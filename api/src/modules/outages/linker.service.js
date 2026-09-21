import { createHash } from 'node:crypto';
import { env } from '../../config/env.js';
import { prisma } from '../../db/prisma.js';
import { logger } from '../../lib/logger.js';
import { generateJson } from '../ai/gemini.client.js';
import { tailPlace } from '../../lib/normalize.js';
import { scheduleWindow } from '../../lib/schedule.js';
import { assertLeaseInTx, exclusive } from '../coordination/lease.js';
import { buildEffect, initialStatus, refoldOutage, statusFor } from './outage-state.js';
import { headlineNode, pickHeadlineMatch } from './headline.js';
import { resolveOverride } from './overrides.js';
import { applyRevivalRule, scoreCandidate } from './scoring.js';
import { cachedVerdict, storeVerdict } from './tiebreak-cache.js';

const LINKABLE = new Set(['OUTAGE', 'PLANNED_OUTAGE', 'RESTORATION', 'UPDATE']);
const HOUR = 3_600_000;
const DIGEST_NODES = 5;
const PLANNED_WINDOW_HOURS = 240;
const DIGEST_ROOTS = 2;
const isDigest = (facts) => !facts.fromDigest && facts.rootCount >= 3 || (facts.rootCount >= DIGEST_ROOTS && facts.nodes.length >= 4);

/** A fresh report while the best match is only partly restored: the remaining fault, or a new one? Not for a score alone to say. */
export const mayBeNewFault = (post, top) =>
  Boolean(top && post.relevance === 'OUTAGE' && post.status === 'INVESTIGATING' && top.raw.status === 'PARTIALLY_RESTORED' && !top.reasons.includes('same thread'));

/** Separate faults reported in one graphic are different outages by definition. */
export const linkedToPost = (candidate, postId) => candidate.raw.posts.some((p) => p.postId === postId);

// \b so that "unplanned power interruption" / "unscheduled maintenance" are not mistaken for planned work
// only added for posts that say they are amended, so nothing else about the tie-break changes
const AMENDED_NOTE = ' This post is marked amended or corrected: it replaces an earlier post about the same fault, so its equipment names may differ from those already recorded. Judge it by the area and the timing.';
const AMENDED = /\b(amended|corrected|correction|revised)\b/i;
const PLANNED_TEXT = /\bplanned (maintenance|power interruption|interruption|outage)|\bscheduled (maintenance|interruption|outage)/i;

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

const originOf = (o) => {
  const first = o.posts.reduce((a, p) => (!a || p.postedAt < a.postedAt || (+p.postedAt === +a.postedAt && p.faultIndex < a.faultIndex) ? p : a), null);
  return first ? `${first.postId}#${first.faultIndex}` : o.id;
};

/**
 * A station is often named after the suburb it serves (Halfway House, Selby, Klipfontein). For scoring only, a station named exactly like a
 * known suburb counts as covering that suburb, so an outage that named the suburb and a post that named the station can find each other.
 * Used only for a side that names NO suburb at all: where suburbs are named, they are better evidence than a guess from a name.
 * Returns Map(node key -> [locality ids]).
 */
async function suburbsNamedLikeStations(keys) {
  const wanted = [...new Set(keys.filter((k) => k && k.length >= 4))];
  if (!wanted.length) return new Map();
  const rows = await prisma.locality.findMany({ where: { normalizedName: { in: wanted }, active: true }, select: { id: true, normalizedName: true } });
  const out = new Map();
  for (const r of rows) out.set(r.normalizedName, [...(out.get(r.normalizedName) ?? []), r.id]);
  return out;
}

async function loadCandidates(post) {
  const since = new Date(post.postedAt.getTime() - env.OUTAGE_WINDOW_HOURS * HOUR);
  const revivalSince = new Date(post.postedAt.getTime() - env.STALE_REVIVAL_HOURS * HOUR);
  const outages = await prisma.outage.findMany({
    where: {
      status: { not: 'CLOSED' },
      // an outage that opened after this post was published cannot be what the post is about (late or historical posts)
      startedAt: { lte: post.postedAt },
      // planned work (reminders days ahead, multi-day isolations) stays linkable much longer than a fault
      OR: [{ kind: 'UNPLANNED', lastUpdateAt: { gte: since } }, { kind: 'UNPLANNED', status: 'STALE', lastUpdateAt: { gte: revivalSince } }, { kind: 'PLANNED', lastUpdateAt: { gte: new Date(post.postedAt.getTime() - PLANNED_WINDOW_HOURS * HOUR) } }, { kind: 'PLANNED', scheduledEnd: { gte: post.postedAt } }],
    },
    orderBy: [{ startedAt: 'asc' }, { title: 'asc' }],
    include: {
      nodes: { include: { node: { select: { name: true, type: true, normalizedKey: true } } } },
      localities: { include: { locality: { select: { canonicalName: true } } } },
      posts: { orderBy: { postedAt: 'asc' }, include: { post: { select: { conversationId: true, externalId: true, text: true, noteTweetText: true } } } },
    },
  });
  const named = await suburbsNamedLikeStations(outages.flatMap((o) => o.nodes.map((n) => n.node.normalizedKey)));
  return outages.map((o) => ({
    raw: o,
    id: o.id,
    // identity = the earliest post AND fault that opened it, so two outages opened by sibling faults of one graphic are distinct
    stableId: originOf(o),
    kind: o.kind,
    status: o.status,
    sdcName: o.sdcName,
    nodeIds: new Set(o.nodes.map((n) => n.nodeId)),
    digest: o.digest,
    localityIds: new Set([...o.localities.map((l) => l.localityId), ...(o.localities.length ? [] : o.nodes.flatMap((n) => named.get(n.node.normalizedKey) ?? []))]),
    // links made by the post being placed (an earlier fault of the same graphic) are not thread evidence for it
    conversationIds: new Set(o.posts.filter((p) => p.postId !== post.id).flatMap((p) => [p.post.conversationId, p.post.externalId]).filter(Boolean)),
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

async function askLlm(post, extraction, ranked, { fromDigest = false } = {}) {
  const clip = (t) => (t ?? '').replace(/#\w+/g, '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 220);
  const summaries = ranked.slice(0, 3).map((c) => {
    const first = c.raw.posts[0]?.post;
    const last = c.raw.posts.at(-1)?.post;
    return {
      outage_id: c.id,
      kind: c.kind,
      status: c.status,
      cause: c.raw.cause,
      equipment: c.raw.nodes.map((n) => `${n.node.type.toLowerCase()} ${n.node.name}`).sort().slice(0, 8), // sorted: the database's row order must not change the question (and so the cached answer)
      suburbs: c.raw.localities.map((l) => l.locality.canonicalName).sort().slice(0, 8),
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
    // one fault inside a graphic: describe that fault, not the graphic's generic call-count text
    text: fromDigest ? clip(r.update_summary) : clip(post.text),
  };
  const shortlist = ranked.slice(0, 3);
  // the key fingerprints everything the model sees (and the model), so a changed reading or candidate never reuses an old verdict;
  // candidates enter by their stable identity, not by database id, so replays on fresh ids still hit the cache
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ model: env.GEMINI_MODEL, amended: post.amended, newPost, candidates: summaries.map(({ outage_id, ...rest }, i) => ({ ...rest, origin: shortlist[i].stableId })) }))
    .digest('hex')
    .slice(0, 24);
  const key = `v6|${post.id}|${post.faultIndex ?? 0}|${fingerprint}`;
  let hit = cachedVerdict(key);
  if (hit === undefined) {
    // Verdicts cached before the fingerprinted key existed identified a candidate by its earliest post alone. Two outages opened
    // by sibling faults of one graphic share that id, so such entries are ambiguous and are ignored; an unambiguous one still counts.
    const legacyIds = shortlist.map((c) => c.raw.posts[0]?.postId ?? c.id);
    if (new Set(legacyIds).size === legacyIds.length) {
      const legacy = cachedVerdict(`${post.amended ? 'v5' : 'v4'}|${post.id}|${post.faultIndex ?? 0}|${[...legacyIds].sort().join(',')}`);
      if (legacy !== undefined) {
        const chosen = legacy.stableId ? shortlist[legacyIds.indexOf(legacy.stableId)] : null;
        if (!legacy.stableId || chosen) {
          storeVerdict(key, { stableId: chosen?.stableId ?? null, reason: legacy.reason });
          hit = { stableId: chosen?.stableId ?? null, reason: legacy.reason };
        }
      }
    }
  }
  if (hit !== undefined) {
    const chosen = hit.stableId ? shortlist.find((c) => c.stableId === hit.stableId) : null;
    return { outageId: chosen?.id ?? null, reason: `${hit.reason} (cached)` };
  }
  const out = await generateJson({
    systemInstruction:
      'Decide whether a new City Power post is about the SAME fault as one of the candidate outages (same equipment failing, continued repairs, or its restoration) or a DIFFERENT fault. Sharing a suburb alone is not enough when BOTH sides name different equipment: two faults at different equipment are different outages, even nearby. But if a candidate outage names no equipment (it was first reported only by suburb) and the new post is about the same suburbs within a few hours, treat it as the same fault. Planned maintenance and unplanned faults are never the same. A restoration post belongs to the outage it restores. Answer outage_id = null for a different fault.' + (post.amended ? AMENDED_NOTE : ''),
    parts: [{ text: JSON.stringify({ new_post: newPost, candidate_outages: summaries }) }],
    jsonSchema: tieBreakSchema,
    purpose: 'tiebreak',
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

export { initialStatus, statusFor };

const GENERIC_NODE = /^(pole[- ]mounted|mini[- ]?substations?|ring main units?|transformers?|cables?|lines?|feederboard.*|standby.*)$/i;
const STREETY = /\b(street|st|road|rd|avenue|ave|drive|dr|lane|between|to)\b|^\d/i;
const short = (s, max = 32) => (s.length > max ? `${s.slice(0, max - 2).trim()}…` : s);

// a cable or a loose piece of kit is often named with a whole sentence: name the outage after the station or distributor when there is one
const NAMING_LAST = new Set(['CABLE', 'LINE', 'OTHER']);
export function titleFor(facts, extraction) {
  const named = [...facts.nodes].reverse().filter((n) => !GENERIC_NODE.test(n.name));
  const specific = named.find((n) => !NAMING_LAST.has(n.type)) ?? named[0];
  // "12th Avenue in Parktown North" -> "Parktown North"; pure street names are left out of titles
  const areas = extraction.result.localities.map((l) => tailPlace(l.name) ?? l.name).filter((n) => !STREETY.test(n)).slice(0, 2).map((n) => short(n));
  const useAreas = areas.length && (!specific || facts.nodes.length >= 5);
  const head = useAreas ? areas.join(', ') : specific && short(specific.name, 40);
  const tail = !useAreas && specific && areas.length ? ` (${areas.join(', ')})` : '';
  return `${head ?? facts.sdcNode?.name ?? 'Unknown location'}${tail}`;
}

export class StaleCandidateError extends Error {}

/**
 * The one place a link is committed: the outage change, the post's timeline entry (with its effect) and the per-fault
 * decision are written in ONE transaction, under a check that this worker still holds the pipeline lease. Either the
 * whole decision exists or none of it does, so a crash or a lost race can never leave a change without its marker.
 * Nothing slow (AI, network) happens in here: the candidates and verdict were settled before.
 */
async function commitLink({ ctx, post, extraction, facts, outageId, isNew, retroactive, score, reasons, decision, manual = false }) {
  return prisma.$transaction(
    async (tx) => {
      await assertLeaseInTx(tx, ctx);
      const already = await tx.linkDecision.findUnique({ where: { postId_faultIndex: { postId: post.id, faultIndex: post.faultIndex } } });
      if (already) return already; // another attempt finished first: one result
      let id = outageId;
      if (isNew) {
        const created = await tx.outage.create({
          data: {
            kind: post.kind,
            status: 'ACTIVE',
            title: titleFor(facts, extraction),
            sdcName: facts.sdcNode?.name ?? null,
            primaryNodeId: facts.nodes.at(-1)?.id ?? null,
            retroactive: Boolean(retroactive),
            digest: isDigest(facts),
            startedAt: post.postedAt,
            lastUpdateAt: post.postedAt,
          },
        });
        id = created.id;
      } else {
        // serialise with any other change to this outage and make sure it is still there and still open to news
        const locked = await tx.$queryRaw`SELECT status FROM "Outage" WHERE id = ${id} FOR UPDATE`;
        if (!locked.length || (locked[0].status === 'CLOSED' && !manual)) throw new StaleCandidateError(`outage ${id} changed while the post was being linked`);
      }
      // A digest post (many nodes) must not smear its nodes across an existing single-fault outage.
      const expand = isNew || !(isDigest(facts) || facts.fromDigest);
      const effect = buildEffect({ extraction, facts, post, retroactive, expand });
      await tx.outagePost.create({
        data: { outageId: id, postId: post.id, role: roleFor(extraction, isNew && !retroactive), score, reasons, postedAt: post.postedAt, faultIndex: post.faultIndex, effect },
      });
      const folded = await refoldOutage(tx, id);
      if (folded === 'legacy') await applyLegacy(tx, { id, post, extraction, facts, effect, expand });
      return tx.linkDecision.create({ data: { postId: post.id, faultIndex: post.faultIndex, outageId: id, ...decision } });
    },
    { timeout: 30_000 },
  );
}

/** Outages from before effects were stored can only be updated additively, and never let an older post become the latest word. */
async function applyLegacy(tx, { id, post, extraction, facts, effect, expand }) {
  const r = extraction.result;
  const o = await tx.outage.findUnique({ where: { id }, select: { status: true, lastUpdateAt: true, restoredAt: true } });
  const newest = post.postedAt >= o.lastUpdateAt;
  const status = newest ? statusFor(extraction, o.status) : o.status;
  await tx.outage.update({
    where: { id },
    data: {
      status,
      ...(newest ? { lastUpdateAt: post.postedAt } : {}),
      ...(newest && r.cause ? { cause: r.cause } : {}),
      ...(newest && r.eta_text ? { etaText: r.eta_text } : {}),
      ...(newest && status === 'RESTORED' ? { restorationPercent: 100 } : newest && r.restoration_percent != null ? { restorationPercent: r.restoration_percent } : {}),
      restoredAt: status === 'RESTORED' ? o.restoredAt ?? post.postedAt : null,
      ...(facts.sdcNode ? { sdcName: facts.sdcNode.name } : {}),
      // the announced window of planned work follows the newest post that states one
      ...(newest && effect.schedule?.start ? { scheduledStart: new Date(effect.schedule.start), scheduledEnd: new Date(effect.schedule.end) } : {}),
    },
  });
  if (expand) {
    for (const n of facts.nodes) await tx.outageNode.upsert({ where: { outageId_nodeId: { outageId: id, nodeId: n.id } }, create: { outageId: id, nodeId: n.id }, update: {} });
  }
  const partial = r.restoration_percent != null && r.restoration_percent < 100 && status !== 'RESTORED';
  for (const l of effect.locs) {
    const restored = status === 'RESTORED' || (!partial && l.restored);
    if (expand) await tx.outageLocality.upsert({ where: { outageId_localityId: { outageId: id, localityId: l.id } }, create: { outageId: id, localityId: l.id, restored }, update: { restored } });
    else if (restored) await tx.outageLocality.updateMany({ where: { outageId: id, localityId: l.id }, data: { restored } });
  }
  if (status === 'RESTORED') await tx.outageLocality.updateMany({ where: { outageId: id }, data: { restored: true } });
}

/**
 * Record a decision that changes no outage (not linkable, needs review, digest with no outage). Idempotent per fault.
 */
export async function recordDecision(ctx, post, data) {
  return prisma.$transaction(async (tx) => {
    await assertLeaseInTx(tx, ctx);
    const already = await tx.linkDecision.findUnique({ where: { postId_faultIndex: { postId: post.id, faultIndex: post.faultIndex } } });
    if (already) return already;
    return tx.linkDecision.create({ data: { postId: post.id, faultIndex: post.faultIndex, ...data } });
  });
}

/**
 * Link (or open) an outage for one extracted post. Idempotent per post and fault.
 * `ctx` is the held pipeline lease (from exclusive/withLease); every commit re-checks it.
 */
export async function linkPost({ postRow, extraction, facts, faultIndex = 0, ctx }) {
  const existing = await prisma.linkDecision.findUnique({ where: { postId_faultIndex: { postId: postRow.id, faultIndex } } });
  if (existing) return existing;

  const text = facts.fromDigest ? '' : postRow.noteTweetText || postRow.text;
  const postKind = isPlanned(extraction, text) ? 'PLANNED' : 'UNPLANNED';
  const post = {
    id: postRow.id,
    postedAt: postRow.publishedAt,
    conversationId: facts.fromDigest ? null : postRow.conversationId,
    text: postRow.noteTweetText || postRow.text,
    faultIndex,
    relevance: extraction.relevance,
    status: extraction.result.status,
    kind: postKind,
    sdcName: facts.sdcNode?.name ?? null,
    nodeIds: new Set(facts.nodes.map((n) => n.id)),
    localityIds: new Set(facts.localityIds),
    // "[AMENDED UPDATE]" / "*Amended*" in the opening words: a correction of an earlier post (not judged for one fault inside a graphic)
    amended: !facts.fromDigest && AMENDED.test((postRow.noteTweetText || postRow.text || '').slice(0, 90)),
    schedule: postKind === 'PLANNED' ? scheduleFor(extraction, postRow, facts) : null, // an unplanned fault has no announced window
  };
  post.relatedNodeIds = await relatedNodeIds(post.nodeIds);
  const namedLikeNodes = await suburbsNamedLikeStations(facts.nodes.map((n) => n.normalizedKey));
  // only when the post names no suburb at all (otherwise the suburbs it does name are better evidence); for scoring only, what is stored is unchanged
  if (!facts.localityIds.length) for (const n of facts.nodes) for (const id of namedLikeNodes.get(n.normalizedKey) ?? []) post.localityIds.add(id);

  const decide = (data) => recordDecision(ctx, post, data);

  if (!LINKABLE.has(extraction.relevance)) return decide({ outcome: 'NEW', reason: `not linkable (${extraction.relevance})` });

  const candidates = (await loadCandidates(post))
    .filter((c) => !facts.fromDigest || !linkedToPost(c, post.id))
    .map((c) => applyRevivalRule({ ...c, ...scoreCandidate(post, c) }, post, { windowHours: env.OUTAGE_WINDOW_HOURS, highScore: env.LINK_HIGH_SCORE }))
    .sort((a, b) => b.score - a.score || String(a.stableId).localeCompare(String(b.stableId)));
  const top = candidates[0];
  const summary = candidates.slice(0, 5).map((c) => ({ id: c.id, score: c.score, reasons: c.reasons }));

  let outageId = null;
  let usedLlm = false;
  let reason;
  // a person's correction (scripts/correct-link.js) beats every rule
  const manual = await resolveOverride(post.id, faultIndex);
  // A fresh "outage reported / investigating" post while the best match is only PARTLY restored is either the fault that is still
  // being fixed or a NEW fault in the same streets (Newtown, 15 Sept: a Bree cable fault while the John Ware one sat at 98%).
  // A high score alone cannot tell them apart, so the tie-break decides (unless it is the same conversation thread).
  const maybeNewFault = mayBeNewFault(post, top);
  if (manual) {
    outageId = manual.action === 'JOIN' ? manual.outageId : null;
    reason = `manual: ${manual.action === 'JOIN' ? 'joined the outage of the anchor post' : 'kept as its own outage'}${manual.note ? ` (${manual.note})` : ''}`;
  } else if (top && top.score >= env.LINK_HIGH_SCORE && !maybeNewFault) {
    outageId = top.id;
    reason = top.reasons.join(', ');
  } else if (top && top.score >= env.LINK_LOW_SCORE && (!isDigest(facts) || !(extraction.result.faults?.length >= 2))) {
    // a prose update about one incident that names many substations is not a multi-fault graphic: let the tie-break decide
    usedLlm = true;
    try {
      const verdict = await askLlm(post, extraction, candidates, { fromDigest: Boolean(facts.fromDigest) });
      outageId = verdict.outageId;
      reason = `LLM: ${verdict.reason}`;
    } catch (err) {
      logger.warn({ postId: post.id, err: err.message }, 'link tie-break failed');
      return decide({ outcome: 'NEEDS_REVIEW', topScore: top.score, usedLlm, reason: `tie-break failed: ${err.message}`, candidates: summary });
    }
  } else {
    reason = top ? `best candidate ${top.score} below threshold` : 'no open candidates';
  }

  if (!manual && !outageId && !post.nodeIds.size && !post.localityIds.size) {
    return decide({ outcome: 'NEEDS_REVIEW', topScore: top?.score ?? null, reason: 'no infrastructure or locality identified', candidates: summary });
  }

  // A summary picture that opens with one piece of equipment is an update about THAT equipment's outage (plus mentions of others):
  // judge it on the headline alone. It may join an existing outage only, never open one, and only when clearly ahead.
  if (!manual && !outageId && isDigest(facts) && !facts.fromDigest) {
    const head = headlineNode(post.text, facts.nodes);
    if (head) {
      const narrow = { ...post, nodeIds: new Set([head.id]), localityIds: new Set() };
      narrow.relatedNodeIds = await relatedNodeIds(narrow.nodeIds);
      const ranked = candidates.filter((c) => !(c.status === 'STALE' && (post.postedAt - c.lastUpdateAt) / HOUR > env.OUTAGE_WINDOW_HOURS)).map((c) => ({ ...c, ...scoreCandidate(narrow, c) })).sort((a, b) => b.score - a.score || String(a.stableId).localeCompare(String(b.stableId)));
      const match = pickHeadlineMatch(ranked);
      if (match) {
        return commitLink({
          ctx,
          post,
          extraction: { ...extraction, result: { ...extraction.result, localities: [] } },
          facts: { ...facts, nodes: [head], rootCount: 1, localityIds: [], restoredLocalityIds: [] },
          outageId: match.id,
          isNew: false,
          retroactive: false,
          score: match.score,
          reasons: [`headline: ${head.name}`, ...match.reasons],
          decision: { outcome: 'LINKED', topScore: match.score, usedLlm: false, reason: `summary post: joined on its headline (${head.name}); ${match.reasons.join(', ')}`, candidates: summary },
        });
      }
    }
  }

  // A multi-fault digest graphic must not open an umbrella outage; it may only join one on a strong match.
  if (!manual && !outageId && isDigest(facts)) {
    return decide({ outcome: 'NEW', topScore: top?.score ?? null, reason: 'digest post covering several faults: no outage created', candidates: summary });
  }

  const linkedTop = outageId && top?.id === outageId ? top : null;
  return commitLink({
    ctx,
    post,
    extraction,
    facts,
    outageId,
    isNew: !outageId,
    retroactive: !outageId && extraction.relevance === 'RESTORATION',
    score: linkedTop?.score ?? null,
    reasons: linkedTop?.reasons ?? null,
    manual: Boolean(manual),
    decision: { outcome: outageId ? 'LINKED' : 'NEW', topScore: top?.score ?? null, usedLlm, reason, candidates: summary },
  });
}

// Planned work: the announced window. Filled in by the schedule work (see lib/schedule.js); null when unknown.
function scheduleFor(extraction, postRow, facts) {
  return scheduleWindow(extraction, facts.fromDigest ? '' : postRow.noteTweetText || postRow.text, postRow.publishedAt);
}

/**
 * Housekeeping, safe to run any time (it takes the pipeline lease itself unless the caller already holds it):
 *  - live unplanned outages with no news for OUTAGE_AUTOCLOSE_HOURS become STALE (outcome unknown, not "resolved")
 *  - restored/cancelled outages older than that are CLOSED
 *  - planned work closes only once its announced window has ended (grace: 6h). Only when no window is known does it fall
 *    back to "no news for PLANNED_WINDOW_HOURS".
 * Every update repeats its condition in the UPDATE itself, so a post that lands mid-sweep (and refreshes lastUpdateAt) wins.
 */
export async function sweepStaleOutages(now = new Date(), { ctx } = {}) {
  const outcome = await exclusive(ctx, () => sweepLocked(now));
  return outcome.acquired ? outcome.value : { skipped: true };
}

async function sweepLocked(now) {
  const cutoff = new Date(now.getTime() - env.OUTAGE_AUTOCLOSE_HOURS * HOUR);
  const plannedCutoff = new Date(now.getTime() - PLANNED_WINDOW_HOURS * HOUR);
  const graceEnd = new Date(now.getTime() - 6 * HOUR);
  const stale = await prisma.outage.updateMany({ where: { kind: 'UNPLANNED', lastUpdateAt: { lt: cutoff }, status: { in: ['ACTIVE', 'PARTIALLY_RESTORED'] } }, data: { status: 'STALE' } });
  const closed = await prisma.outage.updateMany({ where: { lastUpdateAt: { lt: cutoff }, status: { in: ['RESTORED', 'CANCELLED'] } }, data: { status: 'CLOSED' } });
  // planned work with an announced window: closed after the window, however long ago it was announced
  const closedWindow = await prisma.outage.updateMany({ where: { status: 'PLANNED', scheduledEnd: { lt: graceEnd } }, data: { status: 'CLOSED' } });
  // no window stored (older rows): read one from the posts, then fall back to the age rule
  const unknown = await prisma.outage.findMany({
    where: { status: 'PLANNED', scheduledEnd: null },
    select: { id: true, posts: { orderBy: { postedAt: 'desc' }, take: 6, select: { post: { select: { text: true, noteTweetText: true, publishedAt: true } } } } },
  });
  const done = [];
  const undated = [];
  for (const o of unknown) {
    let w = null;
    for (const p of o.posts) {
      w = scheduleWindow(null, p.post.noteTweetText || p.post.text, p.post.publishedAt);
      if (w) break;
    }
    if (w) {
      await prisma.outage.updateMany({ where: { id: o.id, scheduledEnd: null }, data: { scheduledStart: new Date(w.start), scheduledEnd: new Date(w.end) } });
      if (new Date(w.end) < graceEnd) done.push(o.id);
    } else undated.push(o.id);
  }
  const closedKnown = done.length ? await prisma.outage.updateMany({ where: { id: { in: done }, status: 'PLANNED' }, data: { status: 'CLOSED' } }) : { count: 0 };
  const closedUndated = undated.length ? await prisma.outage.updateMany({ where: { id: { in: undated }, status: 'PLANNED', lastUpdateAt: { lt: plannedCutoff } }, data: { status: 'CLOSED' } }) : { count: 0 };
  return { stale: stale.count, closed: closed.count + closedWindow.count + closedKnown.count + closedUndated.count };
}
