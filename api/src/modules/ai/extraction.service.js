import { createHash } from 'node:crypto';
import { readingRevision } from '../../lib/reading-revision.js';
import { env } from '../../config/env.js';
import { prisma } from '../../db/prisma.js';
import { logger } from '../../lib/logger.js';
import { knowledgeContext, sdcFromText, waterKnowledgeContext } from '../infrastructure/knowledge-context.js';
import { generateJson } from './gemini.client.js';
import { readerFor } from './reader-registry.js';
import { classifyWaterNotice, waterNoticeSummary } from './readers/water.reader.js';

const MAX_IMAGES = 4;

/**
 * Fingerprint of what produces a reading: the instructions (including that post's account-specific hint),
 * the output schema and the model. It is stored with every reading, so editing the instructions - or adding/
 * changing a per-account hint in prompt.js - makes older readings show up as stale (npm run audit) and
 * `npm run reread` refreshes exactly those. `sourceAccountName` is SourcePost.sourceAccount.
 */
export function readingStamp(sourceAccountName, serviceType = 'ELECTRICITY') {
  const reader = readerFor(serviceType ?? 'ELECTRICITY');
  const prompt = createHash('sha1').update(reader.buildSystemPrompt(sourceAccountName)).update(JSON.stringify(reader.jsonSchema)).digest('hex').slice(0, 10);
  return { prompt, model: env.GEMINI_MODEL };
}
export const isStale = (row, sourceAccountName, serviceType = 'ELECTRICITY') => row?.result?.__reading?.prompt !== readingStamp(sourceAccountName, serviceType).prompt || row?.model !== env.GEMINI_MODEL;

export function postText(post) {
  return post.noteTweetText || post.text;
}

function sast(date) {
  return new Intl.DateTimeFormat('en-ZA', { timeZone: 'Africa/Johannesburg', dateStyle: 'full', timeStyle: 'short' }).format(date);
}

// Only images X itself serves are fetched (the URL came from a stored payload, so it is not blindly trusted), the size
// limit is enforced while streaming so an oversized or endless body is never buffered, and the whole read has a deadline.
// The host must BE twimg.com or a real subdomain of it (a bare suffix test would let "not-twimg.com" through).
const TRUSTED_MEDIA_HOST = { test: (host) => host === 'twimg.com' || host.endsWith('.twimg.com') };

export function mediaUrl(raw) {
  const u = new URL(raw);
  if (u.protocol !== 'https:' || !TRUSTED_MEDIA_HOST.test(u.hostname.toLowerCase())) throw new Error('untrusted image host');
  if (!u.searchParams.has('name')) u.searchParams.set('name', 'large'); // full-size render, without breaking an existing query
  return u.toString();
}

async function fetchImage(url, { fetchFn = fetch } = {}) {
  const res = await fetchFn(mediaUrl(url), { signal: AbortSignal.timeout(20_000), redirect: 'error' });
  if (!res.ok) throw new Error(`image ${res.status}`);
  const declared = Number(res.headers.get('content-length'));
  if (declared > env.MEDIA_MAX_BYTES) throw new Error('image too large');
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    size += chunk.length;
    if (size > env.MEDIA_MAX_BYTES) {
      await res.body.cancel?.().catch(() => {});
      throw new Error('image too large');
    }
    chunks.push(chunk);
  }
  const buf = Buffer.concat(chunks);
  return { inlineData: { mimeType: res.headers.get('content-type')?.split(';')[0] || 'image/jpeg', data: buf.toString('base64') } };
}
export const _fetchImageForTest = fetchImage;

// A freshly posted picture may not be on X's image servers yet (404), and any network call can blip: those are worth another try a moment
// later. A picture from the wrong host, one that is too large, or a real refusal (403) will not change, so it is not retried.
const TRANSIENT_HTTP = new Set([404, 408, 425, 429, 500, 502, 503, 504]);
export function isTransientImageError(err) {
  const http = /^image (\d+)$/.exec(err?.message ?? '');
  if (http) return TRANSIENT_HTTP.has(Number(http[1]));
  return !/untrusted image host|image too large/.test(err?.message ?? '');
}

export async function fetchImageWithRetry(url, { fetchFn = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), delaysMs = [1500, 4000] } = {}) {
  let last;
  for (let i = 0; i <= delaysMs.length; i++) {
    try {
      return await fetchImage(url, { fetchFn });
    } catch (err) {
      last = err;
      if (!isTransientImageError(err) || i === delaysMs.length) break;
      await sleep(delaysMs[i]);
    }
  }
  throw last;
}

async function loadImages(post) {
  const photos = post.PostMedia.filter((m) => m.mediaType === 'photo').slice(0, MAX_IMAGES);
  const settled = await Promise.allSettled(photos.map((m) => fetchImageWithRetry(m.url)));
  const parts = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
  const failed = settled.length - parts.length;
  const reasons = [...new Set(settled.filter((s) => s.status === 'rejected').map((s) => s.reason?.message ?? 'unknown'))];
  return { parts, failed, reasons };
}

export async function extractPost(postId, { force = false, signal } = {}) {
  const post = await prisma.sourcePost.findUniqueOrThrow({ where: { id: postId }, include: { PostMedia: true } });
  const serviceType = post.serviceType ?? 'ELECTRICITY';
  const reader = readerFor(serviceType);
  const promptVersion = reader.promptVersion ?? env.AI_PROMPT_VERSION;
  const existing = await prisma.postExtraction.findUnique({ where: { postId_promptVersion: { postId, promptVersion } } });
  if (existing && !force && serviceType === 'WATER' && existing.status === 'NEEDS_REVIEW' && existing.result) {
    const noticeClass = classifyWaterNotice(existing.result, postText(post));
    if (noticeClass) {
      const result = { ...existing.result, relevance: noticeClass };
      return prisma.postExtraction.update({ where: { id: existing.id }, data: { status: 'SUCCEEDED', relevance: noticeClass, result, error: null } });
    }
  }
  if (existing?.status === 'SUCCEEDED' && !force) return existing;

  const text = postText(post);
  const started = Date.now();
  const { parts: imageParts, failed, reasons: imageFailures } = await loadImages(post);
  const knowledge = env.KNOWLEDGE_CONTEXT === 'on'
    ? serviceType === 'WATER'
      ? await waterKnowledgeContext(text)
      : await knowledgeContext(sdcFromText(text))
    : null;
  const userText = reader.buildUserText({
    post: { text, publishedAtLocal: sast(post.publishedAt), isReply: post.conversationId !== post.externalId },
    knowledge,
  });

  let result = null;
  let error = null;
  let rawJson = null;
  let usage = { inputTokens: 0, outputTokens: 0 };
  for (let attempt = 1; attempt <= 2 && !result; attempt++) {
    try {
      const out = await generateJson({
        systemInstruction: reader.buildSystemPrompt(post.sourceAccount),
        parts: [{ text: userText }, ...imageParts],
        jsonSchema: reader.jsonSchema,
        hasImages: imageParts.length > 0,
        signal,
      });
      usage = { inputTokens: (usage.inputTokens ?? 0) + (out.inputTokens ?? 0), outputTokens: (usage.outputTokens ?? 0) + (out.outputTokens ?? 0) };
      rawJson = JSON.parse(out.text);
      const parsed = reader.parse ? reader.parse(rawJson) : reader.zodSchema.parse(rawJson);
      result = reader.normaliseReading({ ...parsed, __reading: readingStamp(post.sourceAccount, serviceType) });
      error = null;
    } catch (err) {
      error = err.message;
      logger.warn({ postId, promptVersion, model: env.GEMINI_MODEL, attempt, issues: err.issues ?? null, raw: rawJson, err: err.message }, 'extraction attempt failed');
    }
  }

  const noticeClass = serviceType === 'WATER' && result ? classifyWaterNotice(result, text) : null;
  if (noticeClass && result) result = { ...result, relevance: noticeClass };
  const needsReview = !result || failed > 0 || (result.confidence < 0.6 && !noticeClass);
  const data = {
    model: env.GEMINI_MODEL,
    status: !result ? 'FAILED' : needsReview ? 'NEEDS_REVIEW' : 'SUCCEEDED',
    relevance: result?.relevance ?? null,
    result,
    imageText: result?.image_text ?? null,
    imageCount: imageParts.length,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    durationMs: Date.now() - started,
    error: error ?? (failed ? `${failed} image(s) could not be fetched (${imageFailures.join(', ')})` : null),
  };
  // A forced re-read that fails, or that comes back uncertain (low confidence, a picture that would not download), must not replace a
  // reading that was accepted: the outage it built stays as it was, and the rejected attempt is logged and reported to the caller.
  if ((!result || needsReview) && existing?.status === 'SUCCEEDED') {
    const reason = !result ? `the re-read failed (${error})` : failed > 0 ? `${failed} image(s) could not be fetched` : `low confidence (${result.confidence})`;
    logger.warn({ postId, reason }, 're-read not accepted; keeping the existing successful reading');
    return Object.assign(existing, { keptAfterFailure: true, rejectedReason: reason });
  }
  // The reading and its summaries are one unit: written together, and summaries the new reading no longer has are removed
  // (two faults shrinking to one must not leave a stale second summary).
  return prisma.$transaction(async (tx) => {
    // the accepted reading this one replaces is kept (with its fingerprint), so a repair can be undone and nothing is lost
    if (existing?.status === 'SUCCEEDED' && existing.result && result && readingRevision(existing.result) !== readingRevision(result)) {
      await tx.readingRevision.create({ data: { postId, promptVersion, revision: readingRevision(existing.result), model: existing.model, result: existing.result } });
    }
    await tx.postSummary.deleteMany({ where: { postId } });
    if (result) {
      const faults = result.faults ?? [];
      const rows = faults.length >= 2 || (faults.length === 1 && result.relevance === 'SDC_SUMMARY')
        ? faults.map((f, i) => ({ faultIndex: i, summary: f.summary }))
        : [{ faultIndex: 0, summary: result.update_summary }];
      for (const r of rows.filter((x) => x.summary?.trim())) {
        await tx.postSummary.create({ data: { postId, faultIndex: r.faultIndex, summary: r.summary.trim(), model: env.GEMINI_MODEL, promptVersion } });
      }
    }
    return tx.postExtraction.upsert({ where: { postId_promptVersion: { postId, promptVersion } }, create: { postId, promptVersion, ...data }, update: data });
  });
}

/** A water reading often has no resident sentence (cause is null). Fill the missing post summary from the reading. */
export async function ensureWaterSummaries(postId, result) {
  if (!result || await prisma.postSummary.count({ where: { postId } })) return;
  const faults = result.faults ?? [];
  const multi = faults.length >= 2 || (faults.length === 1 && result.relevance === 'SDC_SUMMARY');
  const rows = multi
    ? faults.map((f, i) => ({ faultIndex: i, summary: waterNoticeSummary(result, f) }))
    : [{ faultIndex: 0, summary: waterNoticeSummary(result) }];
  for (const r of rows.filter((x) => x.summary?.trim())) {
    await prisma.postSummary.create({ data: { postId, faultIndex: r.faultIndex, summary: r.summary.trim(), model: 'water-notice' } });
  }
}

/** The fault layout a reading implies: what the linker keys its per-fault decisions on. */
export function faultLayout(result) {
  const faults = result?.faults ?? [];
  return faults.length >= 2 || (faults.length === 1 && result?.relevance === 'SDC_SUMMARY') ? faults.length : 1;
}
