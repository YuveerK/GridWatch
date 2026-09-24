import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { prisma } from '../../db/prisma.js';
import { logger } from '../../lib/logger.js';
import { assertLeaseInTx, exclusive, recoverStaleWork } from '../coordination/lease.js';
import { XInvalidTokenError, XRateLimitError, fetchTimelinePage } from './x.client.js';

// X returns a timeline newest first and we store each page as it arrives. The old code used "the highest stored id" as the
// checkpoint, so a run that stopped after page one (or hit the page cap) made the next run start above everything it had
// not reached yet: those posts were lost for good.
//
// Now the checkpoint is a separate, persisted COMPLETED high-water mark. It only advances when every page of an interval
// has been stored. A page and the cursor pointing at the next page are saved in one transaction, so an interrupted run
// resumes exactly where it stopped (or, if X no longer accepts the saved token, safely re-reads the interval from the
// last completed mark: posts are unique by id, so re-reading never duplicates anything).

const big = (id) => (id == null ? null : BigInt(id));
const maxId = (a, b) => (a == null ? b : b == null ? a : big(a) >= big(b) ? a : b);

/** Highest stored externalId for the account (X ids are snowflakes, so compare numerically). Used only to seed the mark for a database that predates it. */
export async function currentCheckpoint(sourceAccount = env.X_SOURCE_ACCOUNT_NAME) {
  const rows = await prisma.$queryRaw`SELECT MAX(CAST("externalId" AS BIGINT))::text AS max FROM "SourcePost" WHERE "sourceAccount" = ${sourceAccount} AND "externalId" ~ '^[0-9]+$'`;
  return rows[0]?.max ?? null;
}

/** Every account this deployment polls. A brand-new database (no SourceAccount rows at all) is bootstrapped
 * from the env-configured account, exactly as before; once any account exists, new ones are added as
 * SourceAccount rows directly (e.g. via a seed script), not through env vars. */
async function getActiveAccounts() {
  if ((await prisma.sourceAccount.count()) === 0) {
    const seeded = await prisma.sourceAccount.upsert({
      where: { externalId: env.X_SOURCE_ACCOUNT_ID },
      create: { id: randomUUID(), platform: 'X', externalId: env.X_SOURCE_ACCOUNT_ID, displayName: env.X_SOURCE_ACCOUNT_NAME, updatedAt: new Date() },
      update: {},
    });
    return [seeded];
  }
  return prisma.sourceAccount.findMany({ where: { active: true } });
}

function toRows({ tweet, media }, account) {
  const note = tweet.note_tweet?.text ?? null;
  return {
    post: {
      id: randomUUID(),
      platform: 'X',
      sourceAccount: account.displayName,
      externalId: tweet.id,
      authorId: tweet.author_id ?? account.externalId,
      conversationId: tweet.conversation_id ?? tweet.id,
      text: tweet.text,
      noteTweetText: note,
      language: tweet.lang ?? null,
      publishedAt: new Date(tweet.created_at),
      publicMetrics: tweet.public_metrics ?? undefined,
      attachments: media.length ? { media, mediaKeys: media.map((m) => m.media_key) } : undefined,
      rawPayload: { tweet },
      updatedAt: new Date(),
    },
    media,
  };
}

/** Where ingestion stands, for the status endpoint and the audit. Defaults to the env-configured account. */
export async function ingestionStatus(accountExternalId = env.X_SOURCE_ACCOUNT_ID) {
  const state = await prisma.ingestionState.findUnique({ where: { accountId: accountExternalId } });
  const unprocessed = await prisma.sourcePost.count({ where: { processingStatus: { in: ['UNPROCESSED', 'PROCESSING_ERROR'] } } });
  return {
    completedHighWater: state?.completedHighWater ?? null,
    incomplete: state?.incomplete ?? false,
    resumable: Boolean(state?.cursorToken),
    lastCompletedAt: state?.lastCompletedAt ?? null,
    unprocessedPosts: unprocessed,
  };
}

/** Store one page and the cursor that points past it in a single transaction: both happen or neither does. */
async function persistPage(tx, { run, page, state, account }) {
  const ids = page.posts.map((p) => p.tweet.id);
  const existing = new Set((await tx.sourcePost.findMany({ where: { platform: 'X', externalId: { in: ids } }, select: { externalId: true } })).map((r) => r.externalId));
  let inserted = 0;
  let deduped = 0;
  for (const item of page.posts) {
    if (existing.has(item.tweet.id)) {
      deduped += 1;
      continue;
    }
    existing.add(item.tweet.id); // the same id twice inside one page
    const { post, media } = toRows(item, account);
    await tx.sourcePost.create({
      data: {
        ...post,
        PostMedia: {
          create: media.map((m) => ({
            id: randomUUID(),
            mediaKey: m.media_key,
            mediaType: m.type,
            url: m.url ?? m.preview_image_url ?? '',
            width: m.width ?? null,
            height: m.height ?? null,
            durationMs: m.duration_ms ?? null,
          })),
        },
        IngestionRunPost: { create: { ingestionRunId: run.id } },
      },
    });
    inserted += 1;
  }
  await tx.ingestionState.upsert({
    where: { accountId: account.externalId },
    create: { accountId: account.externalId, ...state },
    update: state,
  });
  return { inserted, deduped };
}

/**
 * Pull everything newer than the completed high-water mark and store it, for every active account. Safe to
 * run repeatedly, concurrently (only one runs; the others return { skipped: true }) and after any
 * interruption. Accounts are polled one after another inside a single held lease, not concurrently: the
 * linker needs to see posts in time order, and per-post-volume today doesn't need true concurrency.
 *   maxPages   the fetch budget: pages (up to 100 posts, billed per post) one run may pull, per account.
 *   fetchPage  injectable for tests
 */
export async function ingestNewPosts({ ctx, maxPages = env.X_MAX_PAGES_PER_RUN, fetchPage = fetchTimelinePage } = {}) {
  const outcome = await exclusive(ctx, async (held) => {
    await recoverStaleWork();
    const accounts = await getActiveAccounts();
    const results = [];
    for (const account of accounts) results.push(await runIngestion(held, account, { maxPages, fetchPage }));
    return combineResults(results);
  });
  if (!outcome.acquired) {
    logger.info('another worker holds the pipeline lease, skipping ingestion');
    return { skipped: true };
  }
  return outcome.value;
}

/** Reduces one result per account to the single shape callers (the cycle, /admin/ingest, scripts/ingest.js)
 * expect - for the common one-account case this is exactly that account's own result. `perAccount` carries
 * the detail. `runId` is the last account's run (quality/review records are tied to one run today; a cycle
 * touching several accounts' runs is a simplification worth revisiting if that ever becomes a problem).
 * A single unavailable/rate-limited account must not stop a healthy one's new posts and backlog from ever
 * updating the site: the combined status is only FAILED/RATE_LIMITED when EVERY account ended that way, so a
 * caller only aborts processing when there is truly nothing usable this cycle. `failedAccounts` still reports
 * every account that didn't succeed, even when the combined status is SUCCEEDED overall. */
function combineResults(results) {
  const allUnsuccessful = results.every((r) => r.status !== 'SUCCEEDED');
  const status = !allUnsuccessful ? 'SUCCEEDED' : results.some((r) => r.status === 'FAILED') ? 'FAILED' : 'RATE_LIMITED';
  const failed = status === 'SUCCEEDED' ? null : (results.find((r) => r.status === status) ?? results[0]);
  const sum = (key) => results.reduce((n, r) => n + (r[key] ?? 0), 0);
  return {
    runId: results.at(-1)?.runId ?? null,
    runIds: results.map((r) => r.runId),
    status,
    pagesFetched: sum('pagesFetched'),
    postsFetched: sum('postsFetched'),
    postsInserted: sum('postsInserted'),
    postsDeduplicated: sum('postsDeduplicated'),
    checkpointBefore: results[0]?.checkpointBefore ?? null,
    complete: results.every((r) => r.complete),
    incomplete: results.some((r) => r.incomplete),
    resumedFromCursor: results.some((r) => r.resumedFromCursor),
    tokenExpired: results.some((r) => r.tokenExpired),
    error: failed?.error ?? null,
    failedAccounts: results.filter((r) => r.status !== 'SUCCEEDED').map((r) => ({ displayName: r.displayName, status: r.status, error: r.error })),
    perAccount: results,
  };
}

async function runIngestion(ctx, account, { maxPages, fetchPage }) {
  let state = await prisma.ingestionState.findUnique({ where: { accountId: account.externalId } });
  // Only a database with NO ingestion state at all (one that predates the mark) is seeded from what is stored, as before.
  // Once state exists a null mark means "nothing completed yet": falling back to the highest stored id would skip older posts.
  const sinceId = state ? state.completedHighWater ?? null : (await currentCheckpoint(account.displayName)) ?? null;

  const resumable = state?.cursorToken && (state.cursorSinceId ?? null) === sinceId;
  let token = resumable ? state.cursorToken : null;
  let newest = resumable ? state.cursorNewest : null;

  const run = await prisma.ingestionRun.create({ data: { id: randomUUID(), sourceAccountId: account.id, checkpointBefore: sinceId } });
  const stats = { pagesFetched: 0, postsFetched: 0, postsInserted: 0, postsDeduplicated: 0 };
  const diag = { resumedFromCursor: Boolean(resumable), tokenExpired: false, complete: false };
  let status = 'SUCCEEDED';
  let error = null;
  let complete = false;

  try {
    while (stats.pagesFetched < maxPages) {
      ctx?.assertHeld();
      let page;
      try {
        page = await fetchPage({ userId: account.externalId, sinceId, paginationToken: token });
      } catch (err) {
        if (err instanceof XInvalidTokenError && token && !diag.tokenExpired) {
          // the saved position is no longer valid: start the interval over from the last completed mark (no duplicates: posts are unique)
          diag.tokenExpired = true;
          token = null;
          newest = null;
          await prisma.$transaction(async (tx) => {
            await assertLeaseInTx(tx, ctx);
            await tx.ingestionState.upsert({
              where: { accountId: account.externalId },
              create: { accountId: account.externalId, completedHighWater: sinceId, incomplete: true },
              update: { cursorToken: null, cursorSinceId: null, cursorNewest: null, incomplete: true },
            });
          });
          continue;
        }
        throw err;
      }
      stats.pagesFetched += 1;
      stats.postsFetched += page.posts.length;
      for (const p of page.posts) newest = maxId(newest, p.tweet.id);
      complete = !page.nextToken;

      const next = complete
        ? { completedHighWater: maxId(sinceId, newest), cursorToken: null, cursorSinceId: null, cursorNewest: null, incomplete: false, lastCompletedAt: new Date() }
        : { completedHighWater: sinceId, cursorToken: page.nextToken, cursorSinceId: sinceId, cursorNewest: newest, incomplete: true };
      const saved = await prisma.$transaction(async (tx) => {
        await assertLeaseInTx(tx, ctx); // the page and the checkpoint only commit while we still own the lease
        return persistPage(tx, { run, page, state: next, account });
      }, { timeout: 60_000 });
      stats.postsInserted += saved.inserted;
      stats.postsDeduplicated += saved.deduped;
      state = next;
      if (complete) break;
      token = page.nextToken;
    }
    diag.complete = complete;
    if (!complete && !state?.incomplete) {
      await prisma.$transaction(async (tx) => {
        await assertLeaseInTx(tx, ctx);
        await tx.ingestionState.upsert({ where: { accountId: account.externalId }, create: { accountId: account.externalId, completedHighWater: sinceId, incomplete: true }, update: { incomplete: true } });
      });
    }
  } catch (err) {
    status = err instanceof XRateLimitError ? 'RATE_LIMITED' : 'FAILED';
    error = err;
    logger.error({ err: err.message, account: account.displayName }, 'ingestion stopped early; it will resume from its saved position');
  } finally {
    try {
      const final = await prisma.ingestionState.findUnique({ where: { accountId: account.externalId } });
      await prisma.ingestionRun.update({
        where: { id: run.id },
        data: { ...stats, status, checkpointAfter: final?.completedHighWater ?? sinceId, diagnostics: { ...diag, incomplete: !diag.complete, newestSeen: newest }, completedAt: new Date(), errorMessage: error?.message ?? null, errorCategory: error ? status : null },
      });
    } catch (err) {
      logger.error({ err: err.message }, 'could not record the ingestion run; the lease is still released');
    }
  }
  return { runId: run.id, sourceAccountId: account.id, displayName: account.displayName, status, ...stats, checkpointBefore: sinceId, complete: diag.complete, incomplete: !diag.complete, resumedFromCursor: diag.resumedFromCursor, tokenExpired: diag.tokenExpired, error: error?.message ?? null };
}
