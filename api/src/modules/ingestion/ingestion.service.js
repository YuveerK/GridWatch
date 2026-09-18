import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { prisma } from '../../db/prisma.js';
import { logger } from '../../lib/logger.js';
import { XRateLimitError, fetchTimelinePage } from './x.client.js';

const LEASE_ID = 'x-ingestion';
const LEASE_MS = 10 * 60_000;
const MAX_PAGES = 20;

/** Highest stored externalId for the account (X ids are snowflakes → compare as BigInt). */
export async function currentCheckpoint(sourceAccount = env.X_SOURCE_ACCOUNT_NAME) {
  const rows = await prisma.sourcePost.findMany({ where: { sourceAccount }, select: { externalId: true } });
  return rows.reduce((max, r) => (max === null || BigInt(r.externalId) > BigInt(max) ? r.externalId : max), null);
}

async function acquireLease(owner) {
  const now = new Date();
  const lease = await prisma.ingestionLease.findUnique({ where: { id: LEASE_ID } });
  if (lease && lease.expiresAt > now) return false;
  await prisma.ingestionLease.upsert({
    where: { id: LEASE_ID },
    create: { id: LEASE_ID, owner, expiresAt: new Date(now.getTime() + LEASE_MS) },
    update: { owner, expiresAt: new Date(now.getTime() + LEASE_MS) },
  });
  return true;
}

const releaseLease = () => prisma.ingestionLease.deleteMany({ where: { id: LEASE_ID } });

async function getSourceAccount() {
  return prisma.sourceAccount.upsert({
    where: { externalId: env.X_SOURCE_ACCOUNT_ID },
    create: { id: randomUUID(), platform: 'X', externalId: env.X_SOURCE_ACCOUNT_ID, displayName: env.X_SOURCE_ACCOUNT_NAME, updatedAt: new Date() },
    update: {},
  });
}

function toRows({ tweet, media }) {
  const note = tweet.note_tweet?.text ?? null;
  return {
    post: {
      id: randomUUID(),
      platform: 'X',
      sourceAccount: env.X_SOURCE_ACCOUNT_NAME,
      externalId: tweet.id,
      authorId: tweet.author_id ?? env.X_SOURCE_ACCOUNT_ID,
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

/** Pull everything newer than the checkpoint and store it. Safe to run repeatedly. */
export async function ingestNewPosts() {
  const owner = randomUUID();
  if (!(await acquireLease(owner))) {
    logger.info('ingestion already running, skipping');
    return { skipped: true };
  }
  const account = await getSourceAccount();
  const checkpointBefore = await currentCheckpoint();
  const run = await prisma.ingestionRun.create({ data: { id: randomUUID(), sourceAccountId: account.id, checkpointBefore } });
  const stats = { pagesFetched: 0, postsFetched: 0, postsInserted: 0, postsDeduplicated: 0 };
  let status = 'SUCCEEDED';
  let error = null;

  try {
    let token = null;
    do {
      const page = await fetchTimelinePage({ userId: env.X_SOURCE_ACCOUNT_ID, sinceId: checkpointBefore, paginationToken: token });
      stats.pagesFetched += 1;
      stats.postsFetched += page.posts.length;
      for (const item of page.posts) {
        const { post, media } = toRows(item);
        const exists = await prisma.sourcePost.findUnique({ where: { platform_externalId: { platform: 'X', externalId: post.externalId } } });
        if (exists) {
          stats.postsDeduplicated += 1;
          continue;
        }
        await prisma.sourcePost.create({
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
        stats.postsInserted += 1;
      }
      token = page.nextToken;
    } while (token && stats.pagesFetched < MAX_PAGES);
  } catch (err) {
    status = err instanceof XRateLimitError ? 'RATE_LIMITED' : 'FAILED';
    error = err;
    logger.error({ err: err.message }, 'ingestion failed');
  } finally {
    await prisma.ingestionRun.update({
      where: { id: run.id },
      data: { ...stats, status, checkpointAfter: await currentCheckpoint(), completedAt: new Date(), errorMessage: error?.message ?? null, errorCategory: error ? status : null },
    });
    await releaseLease();
  }
  return { status, ...stats, checkpointBefore };
}
