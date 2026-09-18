import { env } from '../../config/env.js';
import { prisma } from '../../db/prisma.js';
import { logger } from '../../lib/logger.js';
import { generateJson } from '../ai/gemini.client.js';
import { scoreCandidate } from './scoring.js';

const LINKABLE = new Set(['OUTAGE', 'PLANNED_OUTAGE', 'RESTORATION', 'UPDATE']);
const HOUR = 3_600_000;
const DIGEST_NODES = 5;

const PLANNED_TEXT = /planned (maintenance|power interruption|interruption|outage)|scheduled (maintenance|interruption|outage)/i;

/** Planned work also shows up as "restored" posts, so relevance alone is not enough. */
export function isPlanned(extraction, text) {
  const r = extraction.result;
  if (extraction.relevance === 'PLANNED_OUTAGE' || r.status === 'PLANNED') return true;
  // Only the post's own text counts: image digests mix planned and unplanned items.
  return extraction.relevance !== 'OUTAGE' && PLANNED_TEXT.test(text ?? '');
}

const tieBreakSchema = {
  type: 'object',
  properties: { outage_id: { type: ['string', 'null'] }, reason: { type: 'string' } },
  required: ['outage_id', 'reason'],
};

async function loadCandidates(post) {
  const since = new Date(post.postedAt.getTime() - env.OUTAGE_WINDOW_HOURS * HOUR);
  const outages = await prisma.outage.findMany({
    where: { lastUpdateAt: { gte: since }, status: { not: 'CLOSED' } },
    include: { nodes: true, localities: true, posts: { include: { post: { select: { conversationId: true, externalId: true } } } } },
  });
  return outages.map((o) => ({
    raw: o,
    id: o.id,
    kind: o.kind,
    status: o.status,
    sdcName: o.sdcName,
    nodeIds: new Set(o.nodes.map((n) => n.nodeId)),
    digest: o.digest,
    localityIds: new Set(o.localities.map((l) => l.localityId)),
    conversationIds: new Set(o.posts.flatMap((p) => [p.post.conversationId, p.post.externalId]).filter(Boolean)),
    lastUpdateAt: o.lastUpdateAt,
    restoredAt: o.restoredAt,
  }));
}

async function relatedNodeIds(nodeIds) {
  if (!nodeIds.size) return new Set();
  const ids = [...nodeIds];
  const edges = await prisma.infraEdge.findMany({
    where: { OR: [{ parentId: { in: ids } }, { childId: { in: ids } }], parent: { type: { not: 'SDC' } } },
  });
  const out = new Set();
  for (const e of edges) {
    out.add(e.parentId);
    out.add(e.childId);
  }
  ids.forEach((i) => out.delete(i));
  return out;
}

async function askLlm(post, extraction, ranked) {
  const summaries = ranked.slice(0, 3).map((c) => ({
    outage_id: c.id,
    status: c.status,
    title: c.raw.title,
    cause: c.raw.cause,
    last_update: c.lastUpdateAt.toISOString(),
    score: c.score,
    reasons: c.reasons,
  }));
  const out = await generateJson({
    systemInstruction:
      'Decide whether a new City Power post belongs to one of the existing outages (same fault/area, continued or restored) or is a different, new outage. Answer outage_id = null when it is a new outage. Prefer null when unsure.',
    parts: [{ text: JSON.stringify({ post_time: post.postedAt.toISOString(), post: extraction.result, candidates: summaries }) }],
    jsonSchema: tieBreakSchema,
  });
  const parsed = JSON.parse(out.text);
  const valid = summaries.some((s) => s.outage_id === parsed.outage_id);
  return { outageId: valid ? parsed.outage_id : null, reason: parsed.reason };
}

function roleFor(extraction, isFirst) {
  if (isFirst) return 'OPENED';
  return extraction.relevance === 'RESTORATION' || extraction.result.status === 'RESTORED' ? 'RESTORATION' : 'UPDATE';
}

function statusFor(extraction, current) {
  const s = extraction.result.status;
  if (s === 'RESTORED') return 'RESTORED';
  if (s === 'PARTIALLY_RESTORED') return 'PARTIALLY_RESTORED';
  if (s === 'CANCELLED') return 'CANCELLED';
  if (s === 'PLANNED') return 'PLANNED';
  // a fresh "still being repaired" update does not un-restore a restored outage
  return current === 'RESTORED' || current === 'PARTIALLY_RESTORED' ? current : 'ACTIVE';
}

function titleFor(facts, extraction) {
  const primary = facts.nodes.at(-1);
  const areas = extraction.result.localities.slice(0, 3).map((l) => l.name).join(', ');
  return [primary?.name ?? facts.sdcNode?.name ?? 'Unknown location', areas && `(${areas})`].filter(Boolean).join(' ');
}

async function applyPost({ post, extraction, facts, outageId, score, reasons, isNew, retroactive }) {
  const r = extraction.result;
  const current = isNew ? null : (await prisma.outage.findUnique({ where: { id: outageId }, select: { status: true } })).status;
  const status = statusFor(extraction, current);
  const kind = post.kind;

  return prisma.$transaction(async (tx) => {
    let id = outageId;
    if (isNew) {
      const created = await tx.outage.create({
        data: {
          kind,
          status: retroactive ? 'RESTORED' : status,
          title: titleFor(facts, extraction),
          sdcName: facts.sdcNode?.name ?? null,
          cause: r.cause,
          etaText: r.eta_text,
          restorationPercent: r.restoration_percent,
          primaryNodeId: facts.nodes.at(-1)?.id ?? null,
          retroactive: Boolean(retroactive),
          digest: facts.nodes.length >= DIGEST_NODES,
          startedAt: post.postedAt,
          lastUpdateAt: post.postedAt,
          restoredAt: status === 'RESTORED' ? post.postedAt : null,
        },
      });
      id = created.id;
    } else {
      await tx.outage.update({
        where: { id },
        data: {
          status,
          lastUpdateAt: post.postedAt,
          ...(r.cause ? { cause: r.cause } : {}),
          ...(r.eta_text ? { etaText: r.eta_text } : {}),
          ...(r.restoration_percent != null ? { restorationPercent: r.restoration_percent } : {}),
          restoredAt: status === 'RESTORED' ? post.postedAt : null,
          ...(facts.sdcNode ? { sdcName: facts.sdcNode.name } : {}),
        },
      });
    }
    // A digest post (many nodes) must not smear its nodes across an existing single-fault outage.
    for (const n of isNew || facts.nodes.length < DIGEST_NODES ? facts.nodes : []) {
      await tx.outageNode.upsert({ where: { outageId_nodeId: { outageId: id, nodeId: n.id } }, create: { outageId: id, nodeId: n.id }, update: {} });
    }
    for (const localityId of facts.localityIds) {
      const restored = status === 'RESTORED' || facts.restoredLocalityIds.includes(localityId);
      await tx.outageLocality.upsert({
        where: { outageId_localityId: { outageId: id, localityId } },
        create: { outageId: id, localityId, restored },
        update: { restored },
      });
    }
    if (status === 'RESTORED') await tx.outageLocality.updateMany({ where: { outageId: id }, data: { restored: true } });
    await tx.outagePost.create({
      data: { outageId: id, postId: post.id, role: roleFor(extraction, isNew && !retroactive), score, reasons, postedAt: post.postedAt },
    });
    return id;
  });
}

/** Link (or open) an outage for one extracted post. Idempotent per post. */
export async function linkPost({ postRow, extraction, facts }) {
  const existing = await prisma.linkDecision.findUnique({ where: { postId: postRow.id } });
  if (existing) return existing;

  const post = {
    id: postRow.id,
    postedAt: postRow.publishedAt,
    conversationId: postRow.conversationId,
    relevance: extraction.relevance,
    status: extraction.result.status,
    kind: isPlanned(extraction, postRow.noteTweetText || postRow.text) ? 'PLANNED' : 'UNPLANNED',
    sdcName: facts.sdcNode?.name ?? null,
    nodeIds: new Set(facts.nodes.map((n) => n.id)),
    localityIds: new Set(facts.localityIds),
  };
  post.relatedNodeIds = await relatedNodeIds(post.nodeIds);

  const decide = (data) => prisma.linkDecision.create({ data: { postId: post.id, ...data } });

  if (!LINKABLE.has(extraction.relevance)) return decide({ outcome: 'NEW', reason: `not linkable (${extraction.relevance})` });

  const candidates = (await loadCandidates(post))
    .map((c) => ({ ...c, ...scoreCandidate(post, c) }))
    .sort((a, b) => b.score - a.score);
  const top = candidates[0];
  const summary = candidates.slice(0, 5).map((c) => ({ id: c.id, score: c.score, reasons: c.reasons }));

  let outageId = null;
  let usedLlm = false;
  let reason;
  if (top && top.score >= env.LINK_HIGH_SCORE) {
    outageId = top.id;
    reason = top.reasons.join(', ');
  } else if (top && top.score >= env.LINK_LOW_SCORE) {
    usedLlm = true;
    try {
      const verdict = await askLlm(post, extraction, candidates);
      outageId = verdict.outageId;
      reason = `LLM: ${verdict.reason}`;
    } catch (err) {
      logger.warn({ postId: post.id, err: err.message }, 'link tie-break failed');
      return decide({ outcome: 'NEEDS_REVIEW', topScore: top.score, usedLlm, reason: `tie-break failed: ${err.message}`, candidates: summary });
    }
  } else {
    reason = top ? `best candidate ${top.score} below threshold` : 'no open candidates';
  }

  if (!outageId && !post.nodeIds.size && !post.localityIds.size) {
    return decide({ outcome: 'NEEDS_REVIEW', topScore: top?.score ?? null, reason: 'no infrastructure or locality identified', candidates: summary });
  }

  const linkedTop = outageId && top?.id === outageId ? top : null;
  const finalId = await applyPost({
    post,
    extraction,
    facts,
    outageId,
    score: linkedTop?.score ?? null,
    reasons: linkedTop?.reasons ?? null,
    isNew: !outageId,
    retroactive: !outageId && extraction.relevance === 'RESTORATION',
  });
  return decide({ outcome: outageId ? 'LINKED' : 'NEW', outageId: finalId, topScore: top?.score ?? null, usedLlm, reason, candidates: summary });
}

/** Close outages that have been quiet for OUTAGE_AUTOCLOSE_HOURS. */
export async function sweepStaleOutages(now = new Date()) {
  const cutoff = new Date(now.getTime() - env.OUTAGE_AUTOCLOSE_HOURS * HOUR);
  const { count } = await prisma.outage.updateMany({
    where: { lastUpdateAt: { lt: cutoff }, status: { in: ['ACTIVE', 'PARTIALLY_RESTORED', 'RESTORED', 'PLANNED'] } },
    data: { status: 'CLOSED' },
  });
  return count;
}
