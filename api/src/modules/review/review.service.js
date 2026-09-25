import { env } from '../../config/env.js';
import { likelyTypo, similarity } from '../../lib/normalize.js';
import { faultItems } from '../processing/processor.service.js';
import { acceptedExtraction, checkPostDispositions, readingFaultItems } from '../processing/quality.js';
import { formatReviewInspection } from './inspect.js';
import { REASONS, isSampled, priorityOf } from './suspicion.js';
import { unsupportedService } from '../ai/service-fit.js';
import { verifyItem } from './verifier.js';

const HOUR = 3_600_000;
const LIVE = ['ACTIVE', 'PARTIALLY_RESTORED', 'PLANNED'];
const STATION = ['SUBSTATION', 'SWITCHING_STATION'];

/**
 * Look at the posts a cycle covered and list what looks wrong, per post fault, with the reasons. Nothing is changed here.
 * Deliberately conservative: it should point at a handful of things a cycle, not at every post.
 */
export async function detectSuspicious({ prisma, postIds, now = new Date() }) {
  if (!postIds.length) return [];
  const posts = await prisma.sourcePost.findMany({
    where: { id: { in: postIds } },
    select: {
      id: true, processingStatus: true, serviceType: true, text: true, noteTweetText: true,
      extractions: { where: { status: 'SUCCEEDED' }, orderBy: { createdAt: 'desc' } },
      linkDecisions: { select: { faultIndex: true, outcome: true, outageId: true, reason: true } },
      retries: { select: { faultIndex: true, nextRetryAt: true, kind: true } },
      outagePosts: {
        select: {
          faultIndex: true, role: true, effect: true, postedAt: true,
          outage: { select: { id: true, title: true, kind: true, status: true, startedAt: true, retroactive: true, localities: { select: { localityId: true } }, nodes: { select: { nodeId: true, node: { select: { id: true, name: true, type: true, normalizedKey: true, evidenceCount: true } } } }, posts: { select: { postId: true, faultIndex: true, effect: true } } } },
        },
      },
    },
  });
  const stations = await prisma.infraNode.findMany({ where: { type: { in: STATION } }, select: { id: true, name: true, normalizedKey: true } });

  const found = new Map(); // "postId:faultIndex" -> reasons
  const add = (postId, faultIndex, code, detail) => {
    const k = `${postId}:${faultIndex}`;
    const list = found.get(k) ?? [];
    if (!list.some((r) => r.code === code)) list.push({ code, detail });
    found.set(k, list);
  };

  for (const x of posts) {
    const e = acceptedExtraction(x);
    const result = e?.result;
    // an uncertain reading, or one the reader itself flagged
    const offService = unsupportedService({ serviceType: x.serviceType ?? 'ELECTRICITY', text: x.noteTweetText || x.text, result });
    const actionable = !['IRRELEVANT', 'GENERAL_NOTICE'].includes(result?.relevance);
    if (!offService && (x.processingStatus === 'NEEDS_REVIEW' || (actionable && result && (result.confidence < 0.75 || result.review_reason)))) add(x.id, 0, 'UNCERTAIN_READING', result?.review_reason ? `the reader said: ${String(result.review_reason).slice(0, 100)}` : `confidence ${result?.confidence ?? 'n/a'}`);
    for (const r of x.retries) if (r.nextRetryAt.getUTCFullYear() >= 9000) add(x.id, r.faultIndex, 'TIEBREAK_GAVE_UP', 'automatic retries are used up');

    if (e?.result) {
      const items = readingFaultItems(x, e, faultItems);
      const verdict = checkPostDispositions({ expectedIndices: items.map((i) => i.faultIndex), decisions: x.linkDecisions, outagePosts: x.outagePosts.map((o) => ({ faultIndex: o.faultIndex, outageId: o.outage.id })) });
      const linkable = ['OUTAGE', 'PLANNED_OUTAGE', 'RESTORATION', 'UPDATE'].includes(e.result.relevance);
      if (linkable && !offService) for (const d of verdict.excluded) if (!/unsupported service|system status board/i.test(d.reason ?? '')) add(x.id, d.faultIndex, 'DISCARDED_FAULT', d.reason);
    }

    for (const op of x.outagePosts) {
      const o = op.outage;
      const locIds = o.localities.map((l) => l.localityId);
      const nodeIds = o.nodes.map((n) => n.nodeId);
      if ((op.role === 'OPENED' || o.retroactive) && (locIds.length || nodeIds.length)) {
        const others = await prisma.outage.findMany({
          where: {
            id: { not: o.id },
            startedAt: { gte: new Date(o.startedAt.getTime() - 72 * HOUR), lte: o.startedAt },
            OR: [...(locIds.length ? [{ localities: { some: { localityId: { in: locIds } } } }] : []), ...(nodeIds.length ? [{ nodes: { some: { nodeId: { in: nodeIds } } } }] : [])],
          },
          select: { id: true, title: true, kind: true, status: true, startedAt: true, nodes: { select: { nodeId: true } } },
        });
        if (o.retroactive) {
          if (others.length) add(x.id, op.faultIndex, 'RESTORATION_SPLIT_FROM_INCIDENT', `similar: "${others[0].title}"`);
          else add(x.id, op.faultIndex, 'RESTORATION_NO_PRECEDING_INCIDENT', 'nothing earlier for these suburbs or equipment');
        } else {
          const near = others.filter((p) => p.kind === o.kind && LIVE.includes(p.status) && o.startedAt.getTime() - p.startedAt.getTime() <= 24 * HOUR);
          if (near.length) add(x.id, op.faultIndex, 'NEW_NEAR_ACTIVE', `still live: "${near[0].title}"`);
          const conflict = others.filter((p) => p.kind !== o.kind && p.status !== 'CANCELLED' && p.nodes.some((n) => nodeIds.includes(n.nodeId)));
          if (conflict.length) add(x.id, op.faultIndex, 'KIND_CONFLICT', `${conflict[0].kind.toLowerCase()}: "${conflict[0].title}"`);
        }
      }
      // A restoration placed by its EQUIPMENT while an older, still-open report that named only suburbs (no equipment) covers the same suburbs:
      // the restoration may really close that older report (Northriding, 17 Sept). Only pointed out; nothing is moved.
      if (op.effect?.status === 'RESTORED' && nodeIds.length && locIds.length >= 2) {
        const older = await prisma.outage.findMany({
          where: {
            id: { not: o.id }, kind: o.kind, status: { in: ['ACTIVE', 'PARTIALLY_RESTORED', 'STALE'] }, nodes: { none: {} },
            startedAt: { lte: op.postedAt, gte: new Date(op.postedAt.getTime() - 72 * HOUR) },
            localities: { some: { localityId: { in: locIds } } },
          },
          select: { title: true, localities: { select: { localityId: true } } },
        });
        const twin = older.find((p) => p.localities.filter((l) => locIds.includes(l.localityId)).length >= 2);
        if (twin) add(x.id, op.faultIndex, 'RESTORATION_OTHER_SUBURB_ONLY_OPEN', `still open, no equipment named: "${twin.title}"`);
      }
      // equipment with a name very like a known station, seen only once
      for (const n of o.nodes) {
        if (!STATION.includes(n.node.type) || n.node.evidenceCount > 1 || n.node.normalizedKey.length < 6) continue;
        const twin = stations.find((s) => s.id !== n.node.id && (likelyTypo(n.node.normalizedKey, s.normalizedKey) || similarity(n.node.normalizedKey, s.normalizedKey) >= 0.85));
        if (twin) add(x.id, op.faultIndex, 'EQUIPMENT_IDENTITY', `"${n.node.name}" ~ "${twin.name}"`);
      }
      // many suburbs new to an outage that already existed
      if (op.role !== 'OPENED' && op.effect?.locs?.length) {
        const known = new Set(o.posts.filter((p) => !(p.postId === x.id && p.faultIndex === op.faultIndex)).flatMap((p) => (p.effect?.locs ?? []).map((l) => l.id)));
        const added = op.effect.locs.filter((l) => !known.has(l.id)).length;
        if (added >= 5) add(x.id, op.faultIndex, 'CHANGED_SCOPE', `${added} new suburbs`);
      }
    }
  }
  return [...found].map(([k, reasons]) => {
    const [postId, faultIndex] = k.split(':');
    return { postId, faultIndex: Number(faultIndex), reasons };
  });
}

/**
 * Put suspicious items in the queue. An item a person already resolved or dismissed stays closed unless it now has a reason it did not have
 * before. Returns how many were newly opened.
 */
export async function saveReviewItems({ prisma, suspicions }) {
  let opened = 0;
  for (const s of suspicions) {
    const key = { postId_faultIndex: { postId: s.postId, faultIndex: s.faultIndex } };
    const existing = await prisma.reviewItem.findUnique({ where: key });
    const priority = priorityOf(s.reasons);
    if (!existing) {
      await prisma.reviewItem.create({ data: { postId: s.postId, faultIndex: s.faultIndex, reasons: s.reasons, priority, sampled: s.reasons.every((r) => r.code === 'SAMPLE') } });
      opened += 1;
      continue;
    }
    const oldCodes = new Set(existing.reasons.map((r) => r.code));
    const fresh = s.reasons.some((r) => !oldCodes.has(r.code));
    if (existing.status === 'OPEN') await prisma.reviewItem.update({ where: key, data: { reasons: s.reasons, priority: priority + (existing.verifier?.verdict === 'DISAGREE' ? 5 : 0) } });
    else if (fresh) {
      await prisma.reviewItem.update({ where: key, data: { status: 'OPEN', resolvedAt: null, resolution: null, reasons: s.reasons, priority } });
      opened += 1;
    }
  }
  return opened;
}

/**
 * One review pass over the posts a cycle covered: find suspicious changes, queue them, and (only if the verifier is switched on) spot-check a few
 * apparently clean posts and ask the verifier about the top unverified items. Never throws into the cycle's work; never changes an outage.
 */
/**
 * Re-read the open review items of these posts. A reason that the current decisions no longer produce is resolved.
 * A concern that is still present stays open. A person who already resolved an item is left alone unless a new reason appears.
 */
export async function reconcileReviewItems({ prisma, postIds, now = new Date() }) {
  const suspicions = await detectSuspicious({ prisma, postIds, now });
  const opened = await saveReviewItems({ prisma, suspicions });
  const still = new Set(suspicions.map((s) => `${s.postId}:${s.faultIndex}`));
  const open = postIds.length ? await prisma.reviewItem.findMany({ where: { status: 'OPEN', sampled: false, postId: { in: postIds } } }) : [];
  let resolved = 0;
  for (const item of open) {
    if (still.has(`${item.postId}:${item.faultIndex}`)) continue;
    await prisma.reviewItem.update({ where: { id: item.id }, data: { status: 'RESOLVED', resolvedAt: now, resolution: 'condition no longer present' } });
    resolved += 1;
  }
  return { suspicions, opened, resolved };
}

/** Re-evaluate every open review item. A second run changes nothing that the first run settled. */
export async function reconcileOpenReviews({ prisma, now = new Date() }) {
  const open = await prisma.reviewItem.findMany({ where: { status: 'OPEN', sampled: false }, select: { postId: true } });
  return reconcileReviewItems({ prisma, postIds: [...new Set(open.map((item) => item.postId))], now });
}

export async function runReview({ prisma, postIds, now = new Date(), generate, maxVerifications = 5 }) {
  const { suspicions, opened: openedConcerns } = await reconcileReviewItems({ prisma, postIds, now });
  if (env.VERIFIER_ENABLED === 'on') {
    const flagged = new Set(suspicions.map((s) => s.postId));
    const day = now.toISOString().slice(0, 10);
    for (const id of postIds) if (!flagged.has(id) && isSampled(id, env.VERIFIER_SAMPLE_RATE, day)) suspicions.push({ postId: id, faultIndex: 0, reasons: [{ code: 'SAMPLE', detail: REASONS.SAMPLE.label }] });
  }
  const openedSamples = await saveReviewItems({ prisma, suspicions });
  let verified = 0;
  if (env.VERIFIER_ENABLED === 'on') {
    const open = await prisma.reviewItem.findMany({ where: { status: 'OPEN', postId: { in: postIds } }, orderBy: { priority: 'desc' } });
    const todo = open.filter((i) => !i.verifier).slice(0, maxVerifications);
    for (const item of todo) if (await verifyItem({ prisma, item, generate, now })) verified += 1;
  }
  return { flagged: suspicions.length, opened: openedConcerns + openedSamples, verified };
}

export async function listReviewItems({ prisma, status = 'OPEN', limit = 200, service = null, source = null }) {
  const rows = await prisma.reviewItem.findMany({
    where: {
      status,
      ...(service || source ? { post: { ...(service ? { serviceType: service } : {}), ...(source ? { sourceAccount: source } : {}) } } : {}),
    },
    orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
    take: limit,
    include: { post: { select: { externalId: true, publishedAt: true, text: true, noteTweetText: true, serviceType: true, sourceAccount: true } } },
  });
  return rows.map((r) => ({ id: r.id, postId: r.postId, externalId: r.post.externalId, publishedAt: r.post.publishedAt, faultIndex: r.faultIndex, priority: r.priority, reasons: r.reasons, verifier: r.verifier, sampled: r.sampled, serviceType: r.post.serviceType, sourceAccount: r.post.sourceAccount, text: (r.post.noteTweetText || r.post.text || '').replace(/\s+/g, ' ').slice(0, 220) }));
}

/** Read everything a person needs to judge one review item. Does not write. */
export async function loadReviewInspection({ prisma, id }) {
  const item = await prisma.reviewItem.findUnique({
    where: { id },
    include: {
      post: {
        select: {
          id: true, externalId: true, publishedAt: true, text: true, noteTweetText: true, serviceType: true, sourceAccount: true,
          extractions: { where: { status: 'SUCCEEDED' }, orderBy: { createdAt: 'desc' }, take: 1 },
          linkDecisions: true,
          outagePosts: { include: { outage: { select: { id: true, title: true, status: true, kind: true, startedAt: true, lastUpdateAt: true, nodes: { select: { node: { select: { id: true, name: true, type: true, normalizedKey: true, evidenceCount: true, aliases: { select: { alias: true } }, parents: { select: { parent: { select: { name: true } } } } } } } }, localities: { select: { locality: { select: { canonicalName: true } } } } } } } },
        },
      },
    },
  });
  if (!item) return null;
  const decision = item.post.linkDecisions.find((d) => d.faultIndex === item.faultIndex) ?? item.post.linkDecisions[0];
  const reading = item.post.extractions[0]?.result ?? {};
  const stored = Array.isArray(decision?.candidates) ? decision.candidates : [];
  const ids = stored.map((c) => c.id).filter(Boolean);
  const rows = ids.length
    ? await prisma.outage.findMany({
      where: { id: { in: ids } },
      select: {
        id: true, title: true, status: true, kind: true, startedAt: true, lastUpdateAt: true,
        nodes: { select: { node: { select: { name: true, type: true } } } },
        localities: { select: { locality: { select: { canonicalName: true } } } },
        posts: { orderBy: { postedAt: 'asc' }, take: 1, select: { post: { select: { externalId: true } } } },
      },
    })
    : [];
  const byId = new Map(rows.map((o) => [o.id, o]));
  const candidates = stored.map((c) => {
    const o = byId.get(c.id);
    const age = o ? `${Math.round((item.post.publishedAt - o.startedAt) / 3_600_000)}h after it opened` : '-';
    return {
      id: c.id,
      score: c.score,
      reasons: c.reasons,
      title: o?.title,
      status: o?.status,
      kind: o?.kind,
      equipment: (o?.nodes ?? []).map((n) => n.node.name),
      localities: (o?.localities ?? []).map((l) => l.locality.canonicalName).slice(0, 12),
      age,
      openedBy: o?.posts[0]?.post.externalId,
    };
  });
  const own = item.post.outagePosts.find((p) => p.faultIndex === item.faultIndex);
  const names = (reading.entities ?? []).map((e) => e.name);
  const identity = [];
  for (const n of own?.outage.nodes ?? []) {
    identity.push({
      name: n.node.name,
      type: n.node.type,
      aliases: n.node.aliases.map((a) => a.alias),
      parents: n.node.parents.map((e) => e.parent.name),
    });
  }
  const detail = {
    id: item.id,
    priority: item.priority,
    reasons: item.reasons,
    serviceType: item.post.serviceType,
    sourceAccount: item.post.sourceAccount,
    postId: item.post.id,
    externalId: item.post.externalId,
    publishedAt: item.post.publishedAt.toISOString(),
    text: item.post.noteTweetText || item.post.text,
    imageText: item.post.extractions[0]?.imageText || reading.image_text || null,
    reading,
    faultIndex: item.faultIndex,
    kind: own?.outage.kind ?? null,
    equipment: names,
    localities: (reading.localities ?? []).map((l) => l.name),
    window: reading.eta_text ?? null,
    decision: decision ? { outcome: decision.outcome, reason: decision.reason, topScore: decision.topScore } : null,
    candidates,
    preceding: (item.reasons ?? []).map((r) => r.detail).filter(Boolean),
    timeline: own ? `${own.role} on ${own.outage.title} [${own.outage.status}]` : '-',
    restorationEvidence: reading.update_summary || reading.status || null,
    identity,
    identityEvidence: (item.reasons ?? []).find((r) => r.code === 'EQUIPMENT_IDENTITY')?.detail ?? null,
  };
  return formatReviewInspection(detail);
}

export async function resolveReviewItem({ prisma, id, status = 'RESOLVED', resolution = null, now = new Date() }) {
  if (!['RESOLVED', 'DISMISSED'].includes(status)) throw new Error('status must be RESOLVED or DISMISSED');
  return prisma.reviewItem.update({ where: { id }, data: { status, resolution, resolvedAt: now } });
}
