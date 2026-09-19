import { prisma } from '../../db/prisma.js';
import { logger } from '../../lib/logger.js';
import { extractPost } from '../ai/extraction.service.js';
import { learnFromExtraction } from '../infrastructure/infrastructure.service.js';
import { linkPost } from '../outages/linker.service.js';

const STATUS_BY_RELEVANCE = {
  OUTAGE: 'RELEVANT',
  PLANNED_OUTAGE: 'RELEVANT',
  RESTORATION: 'RELEVANT',
  UPDATE: 'RELEVANT',
  SDC_SUMMARY: 'GENERAL_NOTICE',
  GENERAL_NOTICE: 'GENERAL_NOTICE',
  IRRELEVANT: 'IRRELEVANT',
};

const setStatus = (id, processingStatus) => prisma.sourcePost.update({ where: { id }, data: { processingStatus } });

const RELEVANCE_BY_STATUS = { RESTORED: 'RESTORATION', PLANNED: 'PLANNED_OUTAGE', CANCELLED: 'PLANNED_OUTAGE', PARTIALLY_RESTORED: 'UPDATE' };

/** A graphic reporting several separate faults: learn and link each fault as its own mini-post. */
async function processFaults({ postRow, extraction, faults }) {
  const sdc = extraction.result.sdc;
  const outcomes = [];
  for (const [i, f] of faults.entries()) {
    const synthetic = {
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
    };
    const facts = { ...(await learnFromExtraction(synthetic, postRow.publishedAt)), fromDigest: true };
    if (!facts.nodes.length && !facts.localityIds.length) continue;
    const decision = await linkPost({ postRow, extraction: synthetic, facts, faultIndex: i });
    outcomes.push(decision.outcome);
  }
  const anyLinked = outcomes.length > 0;
  await setStatus(postRow.id, 'RELEVANT');
  if (!anyLinked) await prisma.linkDecision.create({ data: { postId: postRow.id, outcome: 'NEW', reason: 'digest post: no fault with equipment or suburbs' } });
  return { postId: postRow.id, outcome: outcomes.includes('LINKED') ? 'LINKED' : 'NEW', detail: { fresh: false, tokens: '-', relevance: extraction.relevance, status: 'MULTI', sdc, nodes: [], localities: 0, matchedLocalities: 0, usedLlm: false, topScore: null, reason: `${faults.length} faults split (${outcomes.join(',')})`, outageTitle: null, outageStatus: null, outagePosts: null } };
}

/** extract → learn infrastructure → link/open outage for one post. */
export async function processPost(postId) {
  const postRow = await prisma.sourcePost.findUniqueOrThrow({ where: { id: postId } });
  await prisma.sourcePost.update({ where: { id: postId }, data: { processingStatus: 'PROCESSING', processingStartedAt: new Date() } });
  try {
    // Replies to individual customers ("@user Hi, ...") carry no outage identity of their own.
    if (/^\s*@\w+/.test(postRow.noteTweetText || postRow.text)) {
      await prisma.linkDecision.create({ data: { postId, outcome: 'NEW', reason: 'customer reply, skipped' } });
      await setStatus(postId, 'IRRELEVANT');
      return { postId, outcome: 'SKIPPED_REPLY' };
    }
    const cached = await prisma.postExtraction.findFirst({ where: { postId, status: 'SUCCEEDED' }, select: { id: true } });
    const extraction = await extractPost(postId);
    if (extraction.status !== 'SUCCEEDED') {
      await setStatus(postId, extraction.status === 'FAILED' ? 'PROCESSING_ERROR' : 'NEEDS_REVIEW');
      return { postId, outcome: extraction.status };
    }
    const alreadyLinked = await prisma.linkDecision.findFirst({ where: { postId } });
    if (alreadyLinked) {
      await setStatus(postId, STATUS_BY_RELEVANCE[extraction.relevance]);
      return { postId, outcome: 'ALREADY_LINKED' };
    }
    const faults = extraction.result.faults ?? [];
    // several faults, or a call-count summary that still names one concrete fault: link each fault separately
    if (faults.length >= 2 || (faults.length === 1 && extraction.relevance === 'SDC_SUMMARY')) return processFaults({ postRow, extraction, faults });
    const facts = await learnFromExtraction(extraction, postRow.publishedAt);
    const decision = await linkPost({ postRow, extraction, facts });
    const noPlace = decision.outcome === 'NEEDS_REVIEW' && /no infrastructure or locality/.test(decision.reason ?? '');
    // "Reminder of upcoming planned maintenance" with no place named has nothing to attach to: a notice, not a to-do.
    // An outage report with no place is different (someone may be without power), so that one stays flagged.
    const harmless = noPlace && ['PLANNED_OUTAGE', 'UPDATE', 'RESTORATION'].includes(extraction.relevance);
    await setStatus(postId, harmless ? 'GENERAL_NOTICE' : decision.outcome === 'NEEDS_REVIEW' ? 'NEEDS_REVIEW' : STATUS_BY_RELEVANCE[extraction.relevance]);
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
    logger.error({ postId, err: err.message }, 'processing failed');
    await setStatus(postId, 'PROCESSING_ERROR');
    return { postId, outcome: 'ERROR', error: err.message };
  }
}

/** Process every post that has no link decision yet, oldest first (order matters for linking). */
export async function processPending({ limit, onPost, from, to } = {}) {
  const posts = await prisma.sourcePost.findMany({
    where: {
      linkDecisions: { none: {} },
      processingStatus: { notIn: ['NEEDS_REVIEW'] },
      ...(from || to ? { publishedAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}),
    },
    orderBy: [{ publishedAt: 'asc' }, { externalId: 'asc' }],
    select: { id: true },
    ...(limit ? { take: limit } : {}),
  });
  const tally = {};
  for (const [i, p] of posts.entries()) {
    const res = await processPost(p.id);
    onPost?.(res, i + 1, posts.length);
    tally[res.outcome] = (tally[res.outcome] ?? 0) + 1;
    if ((i + 1) % 10 === 0) logger.info({ done: i + 1, total: posts.length, tally }, 'progress');
  }
  return { total: posts.length, tally };
}

/** Wipe learned graph + outages (extractions are kept) so everything can be replayed chronologically. */
export async function resetLearnedState() {
  await prisma.$transaction([
    prisma.linkDecision.deleteMany(),
    prisma.outagePost.deleteMany(),
    prisma.outageLocality.deleteMany(),
    prisma.outageNode.deleteMany(),
    prisma.outage.deleteMany(),
    prisma.nodeLocality.deleteMany(),
    prisma.infraEdge.deleteMany(),
    prisma.nodeAlias.deleteMany(),
    prisma.infraNode.deleteMany(),
    prisma.locality.deleteMany({ where: { sourceLabel: 'learned-from-posts' } }),
    prisma.sourcePost.updateMany({ data: { processingStatus: 'UNPROCESSED' } }),
  ]);
}
