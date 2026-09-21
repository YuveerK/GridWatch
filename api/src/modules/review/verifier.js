import { env } from '../../config/env.js';
import { generateJson } from '../ai/gemini.client.js';
import { quoteAppears } from './suspicion.js';

// An optional, independent second opinion on a suspicious placement. It reads the source post (and the stored transcription of its picture) and
// where the tracker put it, and answers AGREE / DISAGREE / UNSURE with a QUOTE from the source that justifies the answer. Rules:
//   - it never changes an outage: a disagreement raises the item's priority and waits for a person;
//   - an answer whose quote is not really in the source is downgraded to UNSURE (no evidence, no verdict);
//   - it is OFF unless VERIFIER_ENABLED=on, and never makes more than VERIFIER_MAX_CALLS_PER_DAY calls a day.

export const SYSTEM = [
  'You check the work of a tracker of City Power (Johannesburg) outages. You are given ONE post from City Power and where the tracker placed it:',
  'the outage (title, kind planned/unplanned, status, how many posts it holds, its latest summary) and the tracker\'s reason.',
  'Decide whether the placement is reasonable: the same fault or programme belongs in one outage; a different fault, or planned work versus a fault, does not.',
  'Answer AGREE, DISAGREE or UNSURE. You MUST give evidence_quote: words copied EXACTLY from the post text or the picture transcription that justify your answer.',
  'If you cannot quote evidence, answer UNSURE. Never invent a quote.',
].join(' ');

export const schema = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['AGREE', 'DISAGREE', 'UNSURE'] },
    evidence_quote: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['verdict', 'evidence_quote', 'reason'],
};

/** Calls left today (counted from the verdicts already recorded). */
export async function callsLeftToday(prisma, now = new Date(), max = env.VERIFIER_MAX_CALLS_PER_DAY) {
  const used = await prisma.reviewItem.count({ where: { verifier: { path: ['day'], equals: now.toISOString().slice(0, 10) } } });
  return Math.max(0, max - used);
}

/**
 * Check one review item. `generate` is injectable for tests. Returns the verdict object, or null when the verifier is off or its cap is used.
 * Stores the verdict on the item; a DISAGREE also raises its priority by 5.
 */
export async function verifyItem({ prisma, item, generate = generateJson, now = new Date(), force = false, maxPerDay = env.VERIFIER_MAX_CALLS_PER_DAY }) {
  if (!force && env.VERIFIER_ENABLED !== 'on') return null;
  if ((await callsLeftToday(prisma, now, maxPerDay)) <= 0) return null;

  const post = await prisma.sourcePost.findUniqueOrThrow({
    where: { id: item.postId },
    select: {
      text: true, noteTweetText: true,
      extractions: { where: { status: 'SUCCEEDED' }, orderBy: { createdAt: 'desc' }, take: 1, select: { imageText: true } },
      linkDecisions: { where: { faultIndex: item.faultIndex }, select: { outcome: true, reason: true, outage: { select: { title: true, kind: true, status: true, _count: { select: { posts: true } } } } } },
    },
  });
  const text = post.noteTweetText || post.text || '';
  const imageText = post.extractions[0]?.imageText ?? '';
  const d = post.linkDecisions[0];
  const placement = d?.outage
    ? `PLACED IN: "${d.outage.title}" (${d.outage.kind.toLowerCase()}, ${d.outage.status}, ${d.outage._count.posts} posts). Tracker's reason: ${d.reason ?? 'none'}.`
    : `PLACED: no outage (${d?.outcome ?? 'no decision'}: ${d?.reason ?? 'none'}).`;
  const concerns = item.reasons.map((r) => r.detail ?? r.code).join('; ');
  const userText = `POST:\n${text}\n\nPICTURE TRANSCRIPTION:\n${imageText || '(none)'}\n\n${placement}\nWHY THIS WAS FLAGGED: ${concerns}`;

  let verdict;
  try {
    const out = await generate({ systemInstruction: SYSTEM, parts: [{ text: userText }], jsonSchema: schema, hasImages: false, purpose: 'verify' });
    verdict = JSON.parse(out.text);
  } catch (err) {
    verdict = { verdict: 'UNSURE', evidence_quote: '', reason: `the check could not be made: ${String(err.message).slice(0, 120)}` };
  }
  if (verdict.verdict !== 'UNSURE' && !quoteAppears(verdict.evidence_quote, text, imageText)) {
    verdict = { verdict: 'UNSURE', evidence_quote: '', reason: `no verifiable quote for "${verdict.verdict}": ${String(verdict.reason ?? '').slice(0, 120)}` };
  }
  const stored = { verdict: verdict.verdict, quote: verdict.evidence_quote, reason: String(verdict.reason ?? '').slice(0, 300), at: now.toISOString(), day: now.toISOString().slice(0, 10), model: env.GEMINI_MODEL };
  await prisma.reviewItem.update({ where: { id: item.id }, data: { verifier: stored, ...(stored.verdict === 'DISAGREE' ? { priority: { increment: 5 } } : {}) } });
  return stored;
}
