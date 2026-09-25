import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { logger } from '../../lib/logger.js';
import { ensureWaterSummaries, extractPost, faultLayout } from '../ai/extraction.service.js';
import { isUnsplitWaterBoard, waterFaultItems } from '../ai/readers/water.reader.js';
import { unsupportedService } from '../ai/service-fit.js';
import { LeaseLostError, assertLeaseInTx, exclusive, recoverStaleWork } from '../coordination/lease.js';
import { learnFromExtraction, removeContributions } from '../infrastructure/infrastructure.service.js';
import { readingRevision } from '../../lib/reading-revision.js';
import { MAX_RETRY_ATTEMPTS, nextRetryAt } from '../../lib/retry.js';
import { linkPost, markQuietOutagesStale, recordDecision } from '../outages/linker.service.js';
import { refoldOutage } from '../outages/outage-state.js';
import { markRestoredPlaces } from '../../lib/restored-places.js';

const STATUS_BY_RELEVANCE = {
  OUTAGE: 'RELEVANT',
  PLANNED_OUTAGE: 'RELEVANT',
  RESTORATION: 'RELEVANT',
  UPDATE: 'RELEVANT',
  SDC_SUMMARY: 'GENERAL_NOTICE',
  GENERAL_NOTICE: 'GENERAL_NOTICE',
  IRRELEVANT: 'IRRELEVANT',
};
const RELEVANCE_BY_STATUS = { RESTORED: 'RESTORATION', PLANNED: 'PLANNED_OUTAGE', CANCELLED: 'PLANNED_OUTAGE', PARTIALLY_RESTORED: 'UPDATE' };
const PENDING_STATUSES = ['UNPROCESSED', 'PROCESSING_ERROR'];

const setStatus = (id, processingStatus) => prisma.sourcePost.update({ where: { id }, data: { processingStatus } });

// SourceAccount.displayName -> municipalityId, memoized (accounts are seeded rarely; geography is effectively static per run).
// Returns null for an account with no municipality set, or that doesn't exist - callers already treat null as "unscoped".
let accountByName = null;
async function accountFor(displayName) {
  if (!accountByName) {
    const rows = await prisma.sourceAccount.findMany({ select: { displayName: true, municipalityId: true, serviceType: true } });
    accountByName = new Map(rows.map((r) => [r.displayName, r]));
  }
  return accountByName.get(displayName) ?? { municipalityId: null, serviceType: 'ELECTRICITY' };
}
async function municipalityForAccount(displayName) {
  return (await accountFor(displayName)).municipalityId ?? null;
}
export function resetMunicipalityCache() {
  accountByName = null;
}

/**
 * What the linker sees for a reading: one item for an ordinary post, or one synthetic "mini-post" per fault for a graphic
 * reporting several separate faults. Each item is learned and linked (and retried) on its own.
 */
export function faultItems(extraction) {
  if (faultLayout(extraction.result) === 1 && !(extraction.result.faults?.length === 1 && extraction.relevance === 'SDC_SUMMARY')) {
    return [{ faultIndex: 0, extraction, fromDigest: false }];
  }
  const sdc = extraction.result.sdc;
  return extraction.result.faults.map((f, faultIndex) => ({
    faultIndex,
    fromDigest: true,
    extraction: {
      ...extraction,
      relevance: RELEVANCE_BY_STATUS[f.status] ?? 'OUTAGE',
      result: {
        ...extraction.result,
        status: f.status,
        cause: f.cause,
        eta_text: f.eta_text,
        restoration_percent: f.restoration_percent,
        update_summary: f.summary ?? null,
        entities: [...(sdc ? [{ type: 'SDC', name: sdc, parent_name: null }] : []), ...f.equipment],
        localities: f.localities,
        faults: [],
      },
    },
  }));
}

/** Everything the post ends up as, from its per-fault decisions: review work is never hidden behind a linked sibling. */
function finalStatus(items, decisions, extraction) {
  const byIndex = new Map(decisions.map((d) => [d.faultIndex, d]));
  const review = items.filter((it) => byIndex.get(it.faultIndex)?.outcome === 'NEEDS_REVIEW');
  // A status update that names no asset or suburb is a notice. An outage report with no place stays flagged.
  const harmless = items.length === 1 && /no infrastructure or locality/.test(byIndex.get(0)?.reason ?? '') && ['PLANNED_OUTAGE', 'UPDATE', 'RESTORATION'].includes(extraction.relevance);
  if (harmless) return 'GENERAL_NOTICE';
  if (review.length) return 'NEEDS_REVIEW';
  return items.length > 1 ? 'RELEVANT' : STATUS_BY_RELEVANCE[extraction.relevance];
}

async function decisionsOf(postId) {
  return prisma.linkDecision.findMany({ where: { postId }, orderBy: { faultIndex: 'asc' } });
}

async function processLocked(postId, ctx, { force = false, repairOutageIds = [], reading = null } = {}) {
  ctx?.assertHeld();
  const postRow = await prisma.sourcePost.findUniqueOrThrow({ where: { id: postId } });
  await prisma.sourcePost.update({ where: { id: postId }, data: { processingStatus: 'PROCESSING', processingStartedAt: new Date() } });
  try {
    // Replies to individual customers ("@user Hi, ...") carry no outage identity of their own.
    if (/^\s*@\w+/.test(postRow.noteTweetText || postRow.text)) {
      await recordDecision(ctx, { id: postId, faultIndex: 0 }, { outcome: 'NEW', reason: 'customer reply, skipped' });
      await setStatus(postId, 'IRRELEVANT');
      return { postId, outcome: 'SKIPPED_REPLY' };
    }
    const cached = await prisma.postExtraction.findFirst({ where: { postId, status: 'SUCCEEDED' }, select: { id: true } });
    const extraction = reading ?? (await extractPost(postId, { force, signal: ctx?.signal })); // `reading`: already read (a re-read done before anything was removed)
    // which reading this is (taken from what was stored, before the free corrections below), recorded on every effect built from it
    const revision = readingRevision(extraction.result);
    // "restored to X" in the post's own words settles X, whatever the reading listed (free, deterministic)
    if (extraction.result) extraction.result = markRestoredPlaces(extraction.result, postRow.noteTweetText || postRow.text);
    if (extraction.status !== 'SUCCEEDED') {
      await setStatus(postId, extraction.status === 'FAILED' ? 'PROCESSING_ERROR' : 'NEEDS_REVIEW');
      return { postId, outcome: extraction.status };
    }
    const account = await accountFor(postRow.sourceAccount);
    const municipalityId = account.municipalityId ?? null;
    const serviceType = postRow.serviceType ?? account.serviceType ?? 'ELECTRICITY';
    if (serviceType === 'WATER') await ensureWaterSummaries(postId, extraction.result);
    const other = unsupportedService({ serviceType, text: postRow.noteTweetText || postRow.text, result: extraction.result });
    if (other) {
      await recordDecision(ctx, { id: postId, faultIndex: 0 }, { outcome: 'NEW', reason: `unsupported service: ${other} content on an ${serviceType} account` });
      await setStatus(postId, 'IRRELEVANT');
      return { postId, outcome: 'UNSUPPORTED_SERVICE' };
    }
    if (serviceType === 'WATER' && isUnsplitWaterBoard(extraction.result)) {
      await recordDecision(ctx, { id: postId, faultIndex: 0 }, { outcome: 'NEW', reason: 'system status board: several assets without per-asset faults' });
      await setStatus(postId, 'GENERAL_NOTICE');
      return { postId, outcome: 'SYSTEM_STATUS_BOARD' };
    }
    const items = serviceType === 'WATER' ? waterFaultItems(extraction) : faultItems(extraction);
    const have = new Set((await decisionsOf(postId)).map((d) => d.faultIndex));
    const todo = items.filter((it) => !have.has(it.faultIndex));
    if (!todo.length) {
      await setStatus(postId, finalStatus(items, await decisionsOf(postId), extraction));
      return { postId, outcome: 'ALREADY_LINKED' };
    }

    // Faults are handled one at a time and each commits its own decision: after a failure the next attempt does only what is missing.
    let single = null;
    for (const item of todo) {
      ctx?.assertHeld();
      const source = { postId, faultIndex: item.faultIndex };
      const facts = { ...(await learnFromExtraction(item.extraction, postRow.publishedAt, { source, ctx, municipalityId, serviceType })), fromDigest: item.fromDigest };
      if (item.fromDigest && !facts.nodes.length && !facts.localityIds.length) {
        await recordDecision(ctx, { id: postId, faultIndex: item.faultIndex }, { outcome: 'NEW', reason: 'fault names no equipment or suburbs' });
        continue;
      }
      const decision = await linkPost({ postRow, extraction: item.extraction, facts, faultIndex: item.faultIndex, ctx, repairOutageIds, revision });
      if (!item.fromDigest) single = { decision, facts };
    }
    const decisions = await decisionsOf(postId);
    await setStatus(postId, finalStatus(items, decisions, extraction));

    if (!single) {
      const outcomes = decisions.map((d) => d.outcome);
      return { postId, outcome: outcomes.includes('NEEDS_REVIEW') ? 'NEEDS_REVIEW' : outcomes.includes('LINKED') ? 'LINKED' : 'NEW', detail: { fresh: false, tokens: '-', relevance: extraction.relevance, status: 'MULTI', sdc: extraction.result.sdc, nodes: [], localities: 0, matchedLocalities: 0, usedLlm: false, topScore: null, reason: `${items.length} faults split (${outcomes.join(',')})`, outageTitle: null, outageStatus: null, outagePosts: null } };
    }
    const { decision, facts } = single;
    const outage = decision.outageId ? await prisma.outage.findUnique({ where: { id: decision.outageId }, select: { title: true, status: true, _count: { select: { posts: true } } } }) : null;
    return {
      postId,
      outcome: decision.outcome,
      outageId: decision.outageId,
      unmatchedLocalities: facts.unmatched,
      detail: {
        fresh: !cached,
        tokens: `${extraction.inputTokens ?? 0}/${extraction.outputTokens ?? 0}`,
        relevance: extraction.relevance,
        status: extraction.result.status,
        sdc: facts.sdcNode?.name ?? null,
        nodes: facts.nodes.map((n) => n.name),
        localities: extraction.result.localities.length,
        matchedLocalities: facts.localityIds.length,
        usedLlm: decision.usedLlm,
        topScore: decision.topScore,
        reason: decision.reason,
        outageTitle: outage?.title ?? null,
        outageStatus: outage?.status ?? null,
        outagePosts: outage?._count.posts ?? null,
      },
    };
  } catch (err) {
    if (err instanceof LeaseLostError) throw err; // not this post's fault: the new owner requeues it
    logger.error({ postId, err }, 'processing failed'); // the full error, with where it happened
    await setStatus(postId, 'PROCESSING_ERROR');
    return { postId, outcome: 'ERROR', error: err.message };
  }
}

/** extract → learn infrastructure → link/open outage for one post. Holds (or takes) the pipeline lease. */
export async function processPost(postId, { ctx, force = false } = {}) {
  const outcome = await exclusive(ctx, (held) => processLocked(postId, held, { force }));
  return outcome.acquired ? outcome.value : { postId, outcome: 'BUSY' };
}

/**
 * Process posts that are not done yet, oldest first (order matters for linking): never attempted, or failed part-way
 * (their finished faults are kept, only the rest is redone). Posts waiting for review are left for a person.
 *   limit  undefined/null = everything, 0 = nothing, n = at most n. `remaining` reports what was left behind.
 */
/** Display names of accounts whose current X fetch interval hasn't completed (page budget hit, or a failure mid-interval). X
 * returns pages newest-first, so processing what's already stored for such an account now would read a restoration before the
 * older incident it restores, which arrives next cycle. Their posts simply wait, still UNPROCESSED, until the interval is whole. */
async function incompleteAccounts() {
  const states = await prisma.ingestionState.findMany({ where: { incomplete: true }, select: { accountId: true } });
  // Historical cursors are kept on their own runs, but their newest-first pages need the same
  // chronological hold as an unfinished live interval. The latest run for a start boundary wins;
  // a retry with a new end bound supersedes the earlier attempt.
  const backfills = await prisma.ingestionRun.findMany({
    where: { diagnostics: { path: ['kind'], equals: 'backfill' } },
    orderBy: { startedAt: 'desc' },
    select: { sourceAccountId: true, diagnostics: true },
  });
  const latest = new Map();
  for (const run of backfills) {
    const key = `${run.sourceAccountId}:${run.diagnostics?.from}`;
    if (!latest.has(key)) latest.set(key, run);
  }
  const heldBackfillIds = [...latest.values()].filter((r) => r.diagnostics?.complete === false).map((r) => r.sourceAccountId);
  if (!states.length && !heldBackfillIds.length) return [];
  const accounts = await prisma.sourceAccount.findMany({
    where: { OR: [{ externalId: { in: states.map((s) => s.accountId) } }, { id: { in: heldBackfillIds } }] },
    select: { displayName: true },
  });
  return accounts.map((a) => a.displayName);
}

/**
 * Process every waiting post, oldest first. `sweepAsOf`: for replaying HISTORY. Live, the cleanup sweep runs every cycle, so an outage that
 * went quiet is marked STALE (and stays revivable) by the time a later post arrives. A replay would otherwise never sweep between posts,
 * and quiet outages would simply fall out of the candidate window. With this on, the "gone quiet" marking runs as of each post's own time (at most
 * hourly). Only that marking: the sweep's closing of restored and planned outages is deliberately NOT replayed (see docs).
 * `ignoreIncomplete`: process every account regardless of an unfinished fetch interval - for a deliberate full replay/backfill
 * that wants everything processed now. Every other caller (the live cycle, `scripts/process.js`, `scripts/ingest.js --process`)
 * gets the chronological-ordering protection by default, with no wiring required on their part.
 */
export async function processPending({ limit, onPost, onStart, from, to, ctx, sweepAsOf = false, ignoreIncomplete = false, sourceAccount = null, serviceType = null } = {}) {
  const outcome = await exclusive(ctx, async (held) => {
    await recoverStaleWork();
    const heldAccounts = ignoreIncomplete ? [] : await incompleteAccounts();
    const baseWhere = {
      processingStatus: { in: PENDING_STATUSES },
      ...(sourceAccount ? { sourceAccount } : {}),
      ...(serviceType ? { serviceType } : {}),
      ...(from || to ? { publishedAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}),
    };
    const where = heldAccounts.length ? { AND: [baseWhere, { sourceAccount: { notIn: heldAccounts } }] } : baseWhere;
    const take = limit == null ? undefined : Math.max(0, Math.floor(limit));
    const posts = take === 0 ? [] : await prisma.sourcePost.findMany({ where, orderBy: [{ publishedAt: 'asc' }, { externalId: 'asc' }], select: { id: true, publishedAt: true }, ...(take ? { take } : {}) });
    let sweptAt = 0;
    onStart?.(posts.length);
    const tally = {};
    let done = 0;
    for (const [i, p] of posts.entries()) {
      if (held.lost || held.signal?.aborted) break;
      if (sweepAsOf && p.publishedAt.getTime() - sweptAt >= 3_600_000) {
        sweptAt = p.publishedAt.getTime();
        await markQuietOutagesStale(p.publishedAt);
      }
      let res = await processLocked(p.id, held);
      if (res.outcome === 'ERROR' && !held.lost) {
        // a one-off hiccup (database busy, network blip) should not lose an update: try once more, otherwise the next run picks it up
        await new Promise((r) => setTimeout(r, 1500));
        res = await processLocked(p.id, held);
      }
      done += 1;
      onPost?.(res, i + 1, posts.length);
      tally[res.outcome] = (tally[res.outcome] ?? 0) + 1;
      if ((i + 1) % 10 === 0) logger.info({ done: i + 1, total: posts.length, tally }, 'progress');
    }
    // `remaining` keeps its old meaning (every post still pending, held-back or not); `held` breaks out how much of that is
    // deliberately paused for ordering rather than actually stuck.
    const remaining = await prisma.sourcePost.count({ where: baseWhere });
    const heldCount = heldAccounts.length ? await prisma.sourcePost.count({ where: { AND: [baseWhere, { sourceAccount: { in: heldAccounts } }] } }) : 0;
    return { total: posts.length, attempted: done, tally, remaining, held: heldCount };
  });
  return outcome.acquired ? outcome.value : { skipped: true, total: 0, attempted: 0, tally: {}, remaining: null, held: null };
}

/**
 * A tie-break the AI provider could not answer for a temporary reason is tried again by itself: at most MAX_RETRY_ATTEMPTS times, with growing
 * waits (5 min to 6 h). Each try re-decides the post (answers already given are cached, so only the failed question is asked again). Success
 * clears it; after the last try it is left for a person (the decision stays NEEDS_REVIEW) and never retried automatically again.
 */
export async function retryTieBreaks({ ctx, now = new Date(), limit = 5 } = {}) {
  const due = await prisma.retryAttempt.findMany({ where: { kind: 'TIEBREAK', nextRetryAt: { lte: now } }, orderBy: { nextRetryAt: 'asc' }, take: limit });
  let fixed = 0;
  let gaveUp = 0;
  for (const r of due) {
    const attempts = r.attempts + 1; // automatic retries made, counting this one (the queued failure is attempts 0)
    // count this try (and when the next is due) BEFORE making it, so a crash or a non-transient failure cannot make it repeat every cycle
    await prisma.retryAttempt.update({ where: { postId_faultIndex_kind: { postId: r.postId, faultIndex: r.faultIndex, kind: r.kind } }, data: { attempts, nextRetryAt: nextRetryAt(attempts, now) } });
    await reprocessPost(r.postId, { ctx });
    const d = await prisma.linkDecision.findUnique({ where: { postId_faultIndex: { postId: r.postId, faultIndex: r.faultIndex } }, select: { outcome: true, reason: true } });
    if (!d || d.outcome !== 'NEEDS_REVIEW') {
      await prisma.retryAttempt.deleteMany({ where: { postId: r.postId, faultIndex: r.faultIndex, kind: r.kind } });
      fixed += 1;
    } else if (attempts >= MAX_RETRY_ATTEMPTS) {
      gaveUp += 1;
      logger.warn({ postId: r.postId, faultIndex: r.faultIndex, attempts }, 'gave up retrying a tie-break: left for review');
    }
  }
  return { tried: due.length, fixed, gaveUp };
}

/**
 * A post whose picture could not be downloaded is left "needs review", although the picture usually downloads fine minutes later. For a
 * post published a few minutes to `maxAgeMs` ago, read it again (the picture is fetched afresh). Bounded on purpose: a post is tried on each
 * run for at most that window, and only `limit` posts per run, so a picture that is really gone costs a handful of small AI calls, not more.
 */
export async function retryImageFailures({ ctx, now = new Date(), limit = 3, minAgeMs = 3 * 60_000, maxAgeMs = 40 * 60_000 } = {}) {
  const posts = await prisma.sourcePost.findMany({
    where: {
      processingStatus: 'NEEDS_REVIEW',
      publishedAt: { gte: new Date(now.getTime() - maxAgeMs), lte: new Date(now.getTime() - minAgeMs) },
      extractions: { some: { status: 'NEEDS_REVIEW', error: { contains: 'could not be fetched' } } },
    },
    orderBy: [{ publishedAt: 'asc' }, { externalId: 'asc' }],
    take: limit,
    select: { id: true, externalId: true },
  });
  let fixed = 0;
  for (const p of posts) {
    const r = await reprocessPost(p.id, { ctx, reextract: true });
    const now2 = await prisma.sourcePost.findUnique({ where: { id: p.id }, select: { processingStatus: true } });
    if (now2?.processingStatus !== 'NEEDS_REVIEW') fixed += 1;
    logger.info({ postId: p.id, externalId: p.externalId, outcome: r.outcome, status: now2?.processingStatus }, 'retried a post whose picture could not be fetched');
  }
  return { tried: posts.length, fixed };
}

/**
 * Re-do one post. `reextract: false` (default) re-links using the stored reading: nothing is sent to the AI.
 * `reextract: true` also asks the AI to read the post again (and keeps the old reading if that fails).
 * The post's old contribution is removed first (its timeline entries, decisions, graph evidence), the outages it touched
 * are recomputed from their remaining posts (an outage with none left is deleted), and then it is linked afresh. Doing
 * it twice changes nothing more than doing it once.
 */
export async function reprocessPost(postId, { ctx, reextract = false } = {}) {
  const outcome = await exclusive(ctx, async (held) => {
    await recoverStaleWork();
    const post = await prisma.sourcePost.findUnique({ where: { id: postId }, select: { id: true } });
    if (!post) return { postId, outcome: 'NOT_FOUND' };

    // A re-read comes FIRST, before anything is removed: if the new reading is not accepted (failed, uncertain, a picture missing) the
    // previously accepted reading, and the outage built from it, are left exactly as they were.
    let reading = null;
    if (reextract) {
      reading = await extractPost(postId, { force: true, signal: held?.signal });
      if (reading.keptAfterFailure) return { postId, outcome: 'KEPT_EXISTING', reprocessed: false, reason: reading.rejectedReason };
    }

    // Evidence counted before contributions were recorded is adopted first, so taking it back below is exact.
    await adoptLegacyEvidence(postId, held);

    const touched = await prisma.$transaction(async (tx) => {
      await assertLeaseInTx(tx, held);
      const links = await tx.outagePost.findMany({ where: { postId }, select: { outageId: true } });
      const outageIds = [...new Set(links.map((l) => l.outageId))];
      if (outageIds.length) await tx.$queryRaw`SELECT id FROM "Outage" WHERE id IN (${Prisma.join(outageIds)}) ORDER BY id FOR UPDATE`;
      await tx.outagePost.deleteMany({ where: { postId } });
      await tx.linkDecision.deleteMany({ where: { postId } });
      await tx.sourcePost.update({ where: { id: postId }, data: { processingStatus: 'UNPROCESSED' } });
      const results = {};
      for (const id of outageIds) results[id] = await refoldOutage(tx, id);
      return results;
    });
    await removeContributions(postId, null, { ctx: held });
    // The outages this post was in are its REPAIR candidates: taking the post out can move an outage's start to a later post, and the
    // temporal rule (an outage cannot be about a post published before it opened) would then wrongly exclude the very outage it belonged to.
    const repairOutageIds = Object.entries(touched).filter(([, v]) => v !== 'deleted').map(([id]) => id);
    const res = await processLocked(postId, held, { force: false, repairOutageIds, reading });
    const { reconcileReviewItems } = await import('../review/review.service.js');
    const review = await reconcileReviewItems({ prisma, postIds: [postId] });
    return { ...res, reprocessed: true, outagesRecomputed: Object.keys(touched).length, outagesDeleted: Object.values(touched).filter((v) => v === 'deleted').length, reviewResolved: review.resolved };
  });
  return outcome.acquired ? outcome.value : { postId, outcome: 'BUSY' };
}


/** Record (without counting) the graph evidence an already-processed post contributed before contributions were tracked. */
async function adoptLegacyEvidence(postId, ctx) {
  if (await prisma.evidenceContribution.findFirst({ where: { postId }, select: { postId: true } })) return;
  if (!(await prisma.linkDecision.findFirst({ where: { postId }, select: { id: true } }))) return;
  const [row, extraction] = await Promise.all([
    prisma.sourcePost.findUniqueOrThrow({ where: { id: postId }, select: { publishedAt: true, sourceAccount: true, serviceType: true } }),
    prisma.postExtraction.findFirst({ where: { postId, status: 'SUCCEEDED' }, orderBy: { createdAt: 'desc' } }),
  ]);
  if (!extraction) return;
  const account = await accountFor(row.sourceAccount);
  const serviceType = row.serviceType ?? account.serviceType ?? 'ELECTRICITY';
  const items = serviceType === 'WATER' ? waterFaultItems(extraction) : faultItems(extraction);
  for (const item of items) {
    await learnFromExtraction(item.extraction, row.publishedAt, { source: { postId, faultIndex: item.faultIndex }, mode: 'record-only', ctx, municipalityId: account.municipalityId ?? null, serviceType });
  }
}

/**
 * Wipe learned graph + outages (extractions are kept) so everything can be replayed chronologically.
 * Destructive: nothing in the app calls it; the CLI insists on --confirm. Takes the pipeline lease, so it cannot run under a fetch or a linking pass.
 */
export async function resetLearnedState({ ctx } = {}) {
  const outcome = await exclusive(ctx, (held) =>
    prisma.$transaction(async (tx) => {
      await assertLeaseInTx(tx, held);
      await tx.linkDecision.deleteMany();
      await tx.outagePost.deleteMany();
      await tx.outageLocality.deleteMany();
      await tx.outageNode.deleteMany();
      await tx.outage.deleteMany();
      await tx.evidenceContribution.deleteMany();
      await tx.nodeLocality.deleteMany();
      await tx.infraEdge.deleteMany();
      await tx.nodeAlias.deleteMany();
      await tx.infraNode.deleteMany();
      await tx.locality.deleteMany({ where: { sourceLabel: 'learned-from-posts' } });
      await tx.sourcePost.updateMany({ data: { processingStatus: 'UNPROCESSED' } });
    }),
  );
  if (!outcome.acquired) throw new Error('another worker holds the pipeline lease; try again when it has finished');
}
