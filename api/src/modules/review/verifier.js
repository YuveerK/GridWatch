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
  'The other posts of that outage are listed so you can compare. You are NOT shown the original picture, only a transcription of it: if the picture matters and the transcription is unclear, answer UNSURE.',
  'If you cannot quote evidence, answer UNSURE. Never invent a quote.',
].join(' ');

/** What else is in the outage the post was placed in, so "same fault or a different one?" can be judged against the other posts. */
export async function candidateTimeline(prisma, outageId, exceptPostId, limit = 6) {
  const rows = await prisma.outagePost.findMany({
    where: { outageId, postId: { not: exceptPostId } },
    orderBy: { postedAt: 'desc' },
    take: limit,
    select: { postedAt: true, post: { select: { text: true, noteTweetText: true } } },
  });
  if (!rows.length) return 'OTHER POSTS IN THAT OUTAGE: (none)\n\n';
  const line = (r) => '- ' + r.postedAt.toISOString().slice(0, 16) + 'Z: ' + (r.post.noteTweetText || r.post.text || '').replace(/\s+/g, ' ').slice(0, 220);
  return 'OTHER POSTS IN THAT OUTAGE (newest first):\n' + rows.map(line).join('\n') + '\n\n';
}

export const schema = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['AGREE', 'DISAGREE', 'UNSURE'] },
    evidence_quote: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['verdict', 'evidence_quote', 'reason'],
};

const dayOf = (now) => now.toISOString().slice(0, 10);
const LEDGER_LOCK = 724_001;

/** Calls left today: every reservation in the ledger counts (repeat checks of one item, failed calls and unfinished calls included). */
export async function callsLeftToday(prisma, now = new Date(), max = env.VERIFIER_MAX_CALLS_PER_DAY) {
  const used = await prisma.verifierCall.count({ where: { day: dayOf(now) } });
  return Math.max(0, max - used);
}

/**
 * Reserve one call BEFORE the provider is contacted. The count and the insert happen under one database lock, so two callers can never
 * both take the last call. Returns the reservation id, or null when the day's cap is used.
 */
export async function reserveCall(prisma, { itemId, postId, now = new Date(), max = env.VERIFIER_MAX_CALLS_PER_DAY }) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LEDGER_LOCK})`;
    const used = await tx.verifierCall.count({ where: { day: dayOf(now) } });
    if (used >= max) return null;
    const row = await tx.verifierCall.create({ data: { day: dayOf(now), itemId, postId, reservedAt: now } });
    return row.id;
  });
}

/**
 * Check one review item. `generate` is injectable for tests. Returns the verdict object, or null when the verifier is off or its cap is used.
 * Stores the verdict on the item; a DISAGREE also raises its priority by 5.
 */
export async function verifyItem({ prisma, item, generate = generateJson, now = new Date(), force = false, maxPerDay = env.VERIFIER_MAX_CALLS_PER_DAY }) {
  if (!force && env.VERIFIER_ENABLED !== 'on') return null;
  const reservation = await reserveCall(prisma, { itemId: item.id, postId: item.postId, now, max: maxPerDay });
  if (!reservation) return null;

  const post = await prisma.sourcePost.findUniqueOrThrow({
    where: { id: item.postId },
    select: {
      text: true, noteTweetText: true,
      extractions: { where: { status: 'SUCCEEDED' }, orderBy: { createdAt: 'desc' }, take: 1, select: { imageText: true } },
      linkDecisions: { where: { faultIndex: item.faultIndex }, select: { outcome: true, reason: true, outageId: true, outage: { select: { title: true, kind: true, status: true, _count: { select: { posts: true } } } } } },
    },
  });
  const text = post.noteTweetText || post.text || '';
  const imageText = post.extractions[0]?.imageText ?? '';
  const d = post.linkDecisions[0];
  const placement = d?.outage
    ? `PLACED IN: "${d.outage.title}" (${d.outage.kind.toLowerCase()}, ${d.outage.status}, ${d.outage._count.posts} posts). Tracker's reason: ${d.reason ?? 'none'}.`
    : `PLACED: no outage (${d?.outcome ?? 'no decision'}: ${d?.reason ?? 'none'}).`;
  const concerns = item.reasons.map((r) => r.detail ?? r.code).join('; ');
  const outageId = post.linkDecisions[0]?.outageId ?? null;
  const timeline = outageId ? await candidateTimeline(prisma, outageId, item.postId) : '';
  const userText = `POST:\n${text}\n\nPICTURE TRANSCRIPTION:\n${imageText || '(none)'}\n\n${placement}\n${timeline}WHY THIS WAS FLAGGED: ${concerns}`;

  let verdict;
  let callError = null;
  try {
    const out = await generate({ systemInstruction: SYSTEM, parts: [{ text: userText }], jsonSchema: schema, hasImages: false, purpose: 'verify' });
    verdict = JSON.parse(out.text);
  } catch (err) {
    callError = String(err.message).slice(0, 200);
    verdict = { verdict: 'UNSURE', evidence_quote: '', reason: `the check could not be made: ${String(err.message).slice(0, 120)}` };
  }
  if (verdict.verdict !== 'UNSURE' && !quoteAppears(verdict.evidence_quote, text, imageText)) {
    verdict = { verdict: 'UNSURE', evidence_quote: '', reason: `no verifiable quote for "${verdict.verdict}": ${String(verdict.reason ?? '').slice(0, 120)}` };
  }
  const stored = { verdict: verdict.verdict, quote: verdict.evidence_quote, reason: String(verdict.reason ?? '').slice(0, 300), at: now.toISOString(), day: now.toISOString().slice(0, 10), model: env.GEMINI_MODEL };
  // the ledger keeps the spend even if writing the verdict below fails
  await prisma.verifierCall.update({ where: { id: reservation }, data: { outcome: callError ? 'ERROR' : verdict.verdict, error: callError } }).catch(() => {});
  await prisma.reviewItem.update({ where: { id: item.id }, data: { verifier: stored, ...(stored.verdict === 'DISAGREE' ? { priority: { increment: 5 } } : {}) } });
  return stored;
}
