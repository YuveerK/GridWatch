import { env } from '../../config/env.js';
import { prisma } from '../../db/prisma.js';
import { logger } from '../../lib/logger.js';
import { generateJson } from '../ai/gemini.client.js';
import { scoreCandidate } from './scoring.js';
import { cachedVerdict, storeVerdict } from './tiebreak-cache.js';

const LINKABLE = new Set(['OUTAGE', 'PLANNED_OUTAGE', 'RESTORATION', 'UPDATE']);
const HOUR = 3_600_000;
const DIGEST_NODES = 5;
const PLANNED_WINDOW_HOURS = 240;
const DIGEST_ROOTS = 2;
const isDigest = (facts) => !facts.fromDigest && facts.rootCount >= 3 || (facts.rootCount >= DIGEST_ROOTS && facts.nodes.length >= 4);

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
    where: {
      status: { not: 'CLOSED' },
      // planned work (reminders days ahead, multi-day isolations) stays linkable much longer than a fault
      OR: [{ kind: 'UNPLANNED', lastUpdateAt: { gte: since } }, { kind: 'PLANNED', lastUpdateAt: { gte: new Date(post.postedAt.getTime() - PLANNED_WINDOW_HOURS * HOUR) } }],
    },
    orderBy: [{ startedAt: 'asc' }, { title: 'asc' }],
    include: {
      nodes: { include: { node: { select: { name: true, type: true } } } },
      localities: { include: { locality: { select: { canonicalName: true } } } },
      posts: { orderBy: { postedAt: 'asc' }, include: { post: { select: { conversationId: true, externalId: true, text: true, noteTweetText: true } } } },
    },
  });
  return outages.map((o) => ({
    raw: o,
    id: o.id,
    stableId: o.posts.reduce((a, p) => (!a || p.postedAt < a.postedAt ? p : a), null)?.postId ?? o.id,
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
  const clip = (t) => (t ?? '').replace(/#\w+/g, '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 220);
  const summaries = ranked.slice(0, 3).map((c) => {
    const first = c.raw.posts[0]?.post;
    const last = c.raw.posts.at(-1)?.post;
    return {
      outage_id: c.id,
      kind: c.kind,
      status: c.status,
      cause: c.raw.cause,
      equipment: c.raw.nodes.map((n) => `${n.node.type.toLowerCase()} ${n.node.name}`).slice(0, 8),
      suburbs: c.raw.localities.map((l) => l.locality.canonicalName).slice(0, 8),
      posts_so_far: c.raw.posts.length,
      first_post: clip(first?.noteTweetText || first?.text),
      latest_post: last === first ? undefined : clip(last?.noteTweetText || last?.text),
      hours_since_last_update: Number(((post.postedAt - c.lastUpdateAt) / HOUR).toFixed(1)),
      match_score: c.score,
      match_reasons: c.reasons,
    };
  });
  const r = extraction.result;
  const newPost = {
    posted_at: post.postedAt.toISOString(),
    kind: post.kind,
    type: r.relevance,
    status: r.status,
    cause: r.cause,
    equipment: r.entities.filter((e) => e.type !== 'SDC').map((e) => `${e.type.toLowerCase()} ${e.name}`).slice(0, 12),
    suburbs: r.localities.map((l) => l.name).slice(0, 12),
    text: clip(post.text),
  };
  const shortlist = ranked.slice(0, 3);
  const key = `v3|${post.id}|${shortlist.map((c) => c.stableId).sort().join(',')}`;
  const hit = cachedVerdict(key);
  if (hit !== undefined) {
    const chosen = hit.stableId ? shortlist.find((c) => c.stableId === hit.stableId) : null;
    return { outageId: chosen?.id ?? null, reason: `${hit.reason} (cached)` };
  }
  const out = await generateJson({
    systemInstruction:
      'Decide whether a new City Power post is about the SAME fault as one of the candidate outages (same equipment failing, continued repairs, or its restoration) or a DIFFERENT fault. Sharing a suburb alone is not enough when BOTH sides name different equipment: two faults at different equipment are different outages, even nearby. But if a candidate outage names no equipment (it was first reported only by suburb) and the new post is about the same suburbs within a few hours, treat it as the same fault. Planned maintenance and unplanned faults are never the same. A restoration post belongs to the outage it restores. Answer outage_id = null for a different fault.',
    parts: [{ text: JSON.stringify({ new_post: newPost, candidate_outages: summaries }) }],
    jsonSchema: tieBreakSchema,
  });
  const parsed = JSON.parse(out.text);
  const chosen = shortlist.find((c) => c.id === parsed.outage_id) ?? null;
  storeVerdict(key, { stableId: chosen?.stableId ?? null, reason: parsed.reason });
  return { outageId: chosen?.id ?? null, reason: parsed.reason };
}

function roleFor(extraction, isFirst) {
  if (isFirst) return 'OPENED';
  return extraction.relevance === 'RESTORATION' || extraction.result.status === 'RESTORED' ? 'RESTORATION' : 'UPDATE';
}

export function statusFor(extraction, current) {
  const { status: s, localities = [] } = extraction.result;
  // The suburbs are the ground truth for customers: "restored to Willowbrook, but a further fault must be located"
  // is still a restoration, even if the headline status reads INVESTIGATING.
  const restoredAll = localities.length > 0 && localities.every((l) => l.state === 'RESTORED');
  const restoredSome = localities.some((l) => l.state === 'RESTORED');
  // Only override the headline when it is silent about restoration (a post that itself says "partially restored" stays partial).
  const headlineSilent = !['RESTORED', 'PARTIALLY_RESTORED', 'PLANNED', 'CANCELLED'].includes(s);
  if (s === 'RESTORED' || (headlineSilent && restoredAll)) return 'RESTORED';
  if (s === 'PARTIALLY_RESTORED' || (headlineSilent && restoredSome)) return 'PARTIALLY_RESTORED';
  if (s === 'CANCELLED') return 'CANCELLED';
  if (s === 'PLANNED') return 'PLANNED';
  // a fresh "still being repaired" update does not un-restore a restored outage
  return current === 'RESTORED' || current === 'PARTIALLY_RESTORED' ? current : 'ACTIVE'; // a STALE outage that gets news is live again
}

const GENERIC_NODE = /^(pole[- ]mounted|mini[- ]?substations?|ring main units?|transformers?|cables?|lines?|feederboard.*|standby.*)$/i;
const STREETY = /\b(street|st|road|rd|avenue|ave|drive|dr|lane|between|to)\b|^\d/i;
const short = (s) => (s.length > 32 ? `${s.slice(0, 30).trim()}…` : s);

function titleFor(facts, extraction) {
  const specific = [...facts.nodes].reverse().find((n) => !GENERIC_NODE.test(n.name));
  const areas = extraction.result.localities.filter((l) => !STREETY.test(l.name)).slice(0, 2).map((l) => short(l.name));
  const useAreas = areas.length && (!specific || facts.nodes.length >= 5);
  const head = useAreas ? areas.join(', ') : specific?.name;
  const tail = !useAreas && specific && areas.length ? ` (${areas.join(', ')})` : '';
  return `${head ?? facts.sdcNode?.name ?? 'Unknown location'}${tail}`;
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
          digest: isDigest(facts),
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
    const mayExpand = isNew || !(isDigest(facts) || facts.fromDigest);
    for (const n of mayExpand ? facts.nodes : []) {
      await tx.outageNode.upsert({ where: { outageId_nodeId: { outageId: id, nodeId: n.id } }, create: { outageId: id, nodeId: n.id }, update: {} });
    }
    for (const localityId of facts.localityIds) {
      const restored = status === 'RESTORED' || facts.restoredLocalityIds.includes(localityId);
      if (!mayExpand) {
        if (restored) await tx.outageLocality.updateMany({ where: { outageId: id, localityId }, data: { restored } });
        continue;
      }
      await tx.outageLocality.upsert({
        where: { outageId_localityId: { outageId: id, localityId } },
        create: { outageId: id, localityId, restored },
        update: { restored },
      });
    }
    if (status === 'RESTORED') await tx.outageLocality.updateMany({ where: { outageId: id }, data: { restored: true } });
    const opData = { role: roleFor(extraction, isNew && !retroactive), score, reasons, postedAt: post.postedAt, faultIndex: post.faultIndex ?? 0 };
    await tx.outagePost.upsert({
      where: { outageId_postId: { outageId: id, postId: post.id } },
      create: { outageId: id, postId: post.id, ...opData },
      update: {},
    });
    return id;
  });
}

/** Link (or open) an outage for one extracted post. Idempotent per post. */
export async function linkPost({ postRow, extraction, facts, faultIndex = 0 }) {
  const existing = await prisma.linkDecision.findUnique({ where: { postId_faultIndex: { postId: postRow.id, faultIndex } } });
  if (existing) return existing;

  const post = {
    id: postRow.id,
    postedAt: postRow.publishedAt,
    conversationId: postRow.conversationId,
    text: postRow.noteTweetText || postRow.text,
    faultIndex,
    relevance: extraction.relevance,
    status: extraction.result.status,
    kind: isPlanned(extraction, postRow.noteTweetText || postRow.text) ? 'PLANNED' : 'UNPLANNED',
    sdcName: facts.sdcNode?.name ?? null,
    nodeIds: new Set(facts.nodes.map((n) => n.id)),
    localityIds: new Set(facts.localityIds),
  };
  post.relatedNodeIds = await relatedNodeIds(post.nodeIds);

  const decide = (data) => prisma.linkDecision.create({ data: { postId: post.id, faultIndex, ...data } });

  if (!LINKABLE.has(extraction.relevance)) return decide({ outcome: 'NEW', reason: `not linkable (${extraction.relevance})` });

  const candidates = (await loadCandidates(post))
    .map((c) => ({ ...c, ...scoreCandidate(post, c) }))
    .sort((a, b) => b.score - a.score || String(a.stableId).localeCompare(String(b.stableId)));
  const top = candidates[0];
  const summary = candidates.slice(0, 5).map((c) => ({ id: c.id, score: c.score, reasons: c.reasons }));

  let outageId = null;
  let usedLlm = false;
  let reason;
  if (top && top.score >= env.LINK_HIGH_SCORE) {
    outageId = top.id;
    reason = top.reasons.join(', ');
  } else if (top && top.score >= env.LINK_LOW_SCORE && !isDigest(facts)) {
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

  // A multi-fault digest graphic must not open an umbrella outage; it may only join one on a strong match.
  if (!outageId && isDigest(facts)) {
    return decide({ outcome: 'NEW', topScore: top?.score ?? null, reason: 'digest post covering several faults: no outage created', candidates: summary });
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

/**
 * Housekeeping, safe to run any time:
 *  - live outages with no news for OUTAGE_AUTOCLOSE_HOURS become STALE (outcome unknown, not "resolved")
 *  - restored outages older than that are CLOSED; planned ones once well past their window
 */
export async function sweepStaleOutages(now = new Date()) {
  const cutoff = new Date(now.getTime() - env.OUTAGE_AUTOCLOSE_HOURS * HOUR);
  const plannedCutoff = new Date(now.getTime() - PLANNED_WINDOW_HOURS * HOUR);
  const [stale, closed, closedPlanned] = await Promise.all([
    prisma.outage.updateMany({ where: { lastUpdateAt: { lt: cutoff }, status: { in: ['ACTIVE', 'PARTIALLY_RESTORED'] } }, data: { status: 'STALE' } }),
    prisma.outage.updateMany({ where: { lastUpdateAt: { lt: cutoff }, status: { in: ['RESTORED', 'CANCELLED'] } }, data: { status: 'CLOSED' } }),
    prisma.outage.updateMany({ where: { lastUpdateAt: { lt: plannedCutoff }, status: 'PLANNED' }, data: { status: 'CLOSED' } }),
  ]);
  return { stale: stale.count, closed: closed.count + closedPlanned.count };
}
