import { env } from '../../config/env.js';
import { prisma } from '../../db/prisma.js';
import { logger } from '../../lib/logger.js';
import { knowledgeContext, sdcFromText } from '../infrastructure/knowledge-context.js';
import { generateJson } from './gemini.client.js';
import { extractionJsonSchema, extractionSchema } from './extraction.schema.js';
import { SYSTEM_PROMPT, buildUserText } from './prompt.js';

const MAX_IMAGES = 4;

export function postText(post) {
  return post.noteTweetText || post.text;
}

function sast(date) {
  return new Intl.DateTimeFormat('en-ZA', { timeZone: 'Africa/Johannesburg', dateStyle: 'full', timeStyle: 'short' }).format(date);
}

async function fetchImage(url) {
  const res = await fetch(`${url}?name=large`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`image ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > env.MEDIA_MAX_BYTES) throw new Error('image too large');
  return { inlineData: { mimeType: res.headers.get('content-type')?.split(';')[0] || 'image/jpeg', data: buf.toString('base64') } };
}

async function loadImages(post) {
  const photos = post.PostMedia.filter((m) => m.mediaType === 'photo').slice(0, MAX_IMAGES);
  const settled = await Promise.allSettled(photos.map((m) => fetchImage(m.url)));
  const parts = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
  const failed = settled.length - parts.length;
  return { parts, failed };
}

export async function extractPost(postId, { force = false } = {}) {
  const promptVersion = env.AI_PROMPT_VERSION;
  const existing = await prisma.postExtraction.findUnique({ where: { postId_promptVersion: { postId, promptVersion } } });
  if (existing?.status === 'SUCCEEDED' && !force) return existing;

  const post = await prisma.sourcePost.findUniqueOrThrow({ where: { id: postId }, include: { PostMedia: true } });
  const text = postText(post);
  const started = Date.now();
  const { parts: imageParts, failed } = await loadImages(post);
  const knowledge = env.KNOWLEDGE_CONTEXT === 'on' ? await knowledgeContext(sdcFromText(text)) : null;
  const userText = buildUserText({
    post: { text, publishedAtLocal: sast(post.publishedAt), isReply: post.conversationId !== post.externalId },
    knowledge,
  });

  let result = null;
  let error = null;
  let usage = { inputTokens: 0, outputTokens: 0 };
  for (let attempt = 1; attempt <= 2 && !result; attempt++) {
    try {
      const out = await generateJson({
        systemInstruction: SYSTEM_PROMPT,
        parts: [{ text: userText }, ...imageParts],
        jsonSchema: extractionJsonSchema,
        hasImages: imageParts.length > 0,
      });
      usage = { inputTokens: (usage.inputTokens ?? 0) + (out.inputTokens ?? 0), outputTokens: (usage.outputTokens ?? 0) + (out.outputTokens ?? 0) };
      result = extractionSchema.parse(JSON.parse(out.text));
      error = null;
    } catch (err) {
      error = err.message;
      logger.warn({ postId, attempt, err: err.message }, 'extraction attempt failed');
    }
  }

  const needsReview = !result || failed > 0 || result.confidence < 0.6;
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
    error: error ?? (failed ? `${failed} image(s) could not be fetched` : null),
  };
  if (result) {
    const faults = result.faults ?? [];
    const rows = faults.length >= 2 || (faults.length === 1 && result.relevance === 'SDC_SUMMARY')
      ? faults.map((f, i) => ({ faultIndex: i, summary: f.summary }))
      : [{ faultIndex: 0, summary: result.update_summary }];
    for (const r of rows.filter((x) => x.summary?.trim())) {
      await prisma.postSummary.upsert({
        where: { postId_faultIndex: { postId, faultIndex: r.faultIndex } },
        create: { postId, faultIndex: r.faultIndex, summary: r.summary.trim(), model: env.GEMINI_MODEL },
        update: { summary: r.summary.trim(), model: env.GEMINI_MODEL },
      });
    }
  }
  return prisma.postExtraction.upsert({
    where: { postId_promptVersion: { postId, promptVersion } },
    create: { postId, promptVersion, ...data },
    update: data,
  });
}
