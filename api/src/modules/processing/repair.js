import { assertLeaseInTx } from '../coordination/lease.js';
import { refoldOutage } from '../outages/outage-state.js';
import { decodeEdgeEvidenceRef } from '../../lib/evidence-edge.js';

// Repairs (re-linking a post, a correction, a node merge) are STAGED and REVERSIBLE:
//   1. before anything changes, a snapshot is taken of everything the repair can touch for the posts involved: their outage entries and
//      decisions, the outages they are in, what they taught the graph (with the counters as they were), their readings and summaries, and
//      any manual corrections on them;
//   2. after the repair, the change can be described (before -> after);
//   3. restoreSnapshot puts it all back, exactly, in one transaction that first proves the lease is still held.
// A reading a re-read replaces is also kept (ReadingRevision), so it is never lost.

/** JSON-safe copy (dates become text; restore turns them back). */
const plain = (rows) => JSON.parse(JSON.stringify(rows, (_k, v) => (v instanceof Date ? { $date: v.toISOString() } : v)));
const revive = (rows) => JSON.parse(JSON.stringify(rows), (_k, v) => (v && typeof v === 'object' && '$date' in v ? new Date(v.$date) : v));

export async function snapshotForPosts(prisma, postIds, now = new Date()) {
  const posts = await prisma.sourcePost.findMany({ where: { id: { in: postIds } }, select: { id: true, externalId: true, processingStatus: true } });
  const outagePosts = await prisma.outagePost.findMany({ where: { postId: { in: postIds } } });
  const outageIds = [...new Set(outagePosts.map((o) => o.outageId))];
  const outages = await prisma.outage.findMany({ where: { id: { in: outageIds } } });
  const linkDecisions = await prisma.linkDecision.findMany({ where: { postId: { in: postIds } } });
  const evidence = await prisma.evidenceContribution.findMany({ where: { postId: { in: postIds } } });
  const nodeIds = new Set();
  const edgeKeys = [];
  const nlKeys = [];
  for (const e of evidence) {
    if (e.kind === 'NODE') nodeIds.add(e.refA);
    else if (e.kind === 'EDGE') {
      const { childId, relationType } = decodeEdgeEvidenceRef(e.refB);
      nodeIds.add(e.refA);
      nodeIds.add(childId);
      edgeKeys.push({ parentId: e.refA, childId, relationType });
    } else if (e.kind === 'NODE_LOCALITY') {
      nodeIds.add(e.refA);
      nlKeys.push({ nodeId: e.refA, localityId: e.refB });
    }
  }
  const nodes = await prisma.infraNode.findMany({ where: { id: { in: [...nodeIds] } } });
  const edges = edgeKeys.length ? await prisma.infraEdge.findMany({ where: { OR: edgeKeys } }) : [];
  const nodeLocalities = nlKeys.length ? await prisma.nodeLocality.findMany({ where: { OR: nlKeys } }) : [];
  const extractions = await prisma.postExtraction.findMany({ where: { postId: { in: postIds } } });
  const summaries = await prisma.postSummary.findMany({ where: { postId: { in: postIds } } });
  const overrides = await prisma.linkOverride.findMany({ where: { OR: [{ postId: { in: postIds } }, { anchorPostId: { in: postIds } }] } });
  return plain({ version: 1, takenAt: now, postIds, posts, outagePosts, outages, linkDecisions, evidence, nodes, edges, nodeLocalities, extractions, summaries, overrides });
}

const CONFIRM_AT = 2;
const NODE_FIELDS = ['type', 'name', 'normalizedKey', 'serviceType', 'municipalityId', 'lifecycle', 'evidenceCount', 'firstSeenAt', 'lastSeenAt'];
const edgeKey = (a, b, relationType = 'LEGACY_PARENT') => `${a}|${b}|${relationType}`;
/** How many contributions each graph fact has: NODE|id, EDGE|parent|child, NODE_LOCALITY|node|locality. */
function tally(rows) {
  const m = new Map();
  for (const r of rows) {
    const k = r.kind === 'NODE' ? 'NODE|' + r.refA : r.kind + '|' + r.refA + '|' + r.refB;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}
const OUTAGE_FIELDS = ['id', 'kind', 'status', 'serviceType', 'waterState', 'title', 'sdcName', 'municipalityId', 'cause', 'etaText', 'restorationPercent', 'primaryNodeId', 'retroactive', 'digest', 'startedAt', 'lastUpdateAt', 'restoredAt', 'scheduledStart', 'scheduledEnd', 'createdAt'];
const pick = (row, keys) => Object.fromEntries(keys.filter((k) => k in row).map((k) => [k, row[k]]));

/** Undo a repair: put the snapshot back. `ctx` is the held pipeline lease. Returns what was restored. */
export async function restoreSnapshot({ prisma, snapshot: raw, ctx }) {
  const s = revive(raw);
  const postIds = s.postIds;
  const before = await prisma.outagePost.findMany({ where: { postId: { in: postIds } }, select: { outageId: true } });
  const affected = new Set([...before.map((o) => o.outageId), ...s.outagePosts.map((o) => o.outageId)]);

  const out = await prisma.$transaction(
    async (tx) => {
      await assertLeaseInTx(tx, ctx);
      // Undoing twice, or undoing something already undone, must change nothing (the counters are corrected by difference, so a repeat
      // would double-apply). That requires comparing everything this function actually restores, not just outage membership: a reading,
      // summary or override can change while the post stays in exactly the same outage with the same evidence counts.
      const sig = (ops, ev, decisions, extractions, summaries, overrides, posts) =>
        JSON.stringify([
          ops.map((o) => `${o.outageId}|${o.postId}|${o.faultIndex}|${JSON.stringify(o.effect ?? null)}`).sort(),
          [...tally(ev)].sort(),
          decisions.map((d) => `${d.postId}|${d.faultIndex}|${d.outcome}|${d.outageId}|${d.reason ?? ''}`).sort(),
          extractions.map((x) => `${x.postId}|${x.promptVersion}|${x.status}|${JSON.stringify(x.result ?? null)}`).sort(),
          summaries.map((x) => `${x.postId}|${x.faultIndex}|${x.summary}`).sort(),
          overrides.map((o) => `${o.postId}|${o.faultIndex}|${o.action}|${o.anchorPostId ?? ''}|${o.anchorFaultIndex}|${o.note ?? ''}`).sort(),
          posts.map((p) => `${p.id}|${p.processingStatus}`).sort(),
        ]);
      const nowOps = await tx.outagePost.findMany({ where: { postId: { in: postIds } }, select: { outageId: true, postId: true, faultIndex: true, effect: true } });
      const nowEvidence = await tx.evidenceContribution.findMany({ where: { postId: { in: postIds } } });
      const nowDecisions = await tx.linkDecision.findMany({ where: { postId: { in: postIds } }, select: { postId: true, faultIndex: true, outcome: true, outageId: true, reason: true } });
      const nowExtractions = await tx.postExtraction.findMany({ where: { postId: { in: postIds } }, select: { postId: true, promptVersion: true, status: true, result: true } });
      const nowSummaries = await tx.postSummary.findMany({ where: { postId: { in: postIds } }, select: { postId: true, faultIndex: true, summary: true } });
      const nowOverrides = await tx.linkOverride.findMany({ where: { OR: [{ postId: { in: postIds } }, { anchorPostId: { in: postIds } }] }, select: { postId: true, faultIndex: true, action: true, anchorPostId: true, anchorFaultIndex: true, note: true } });
      const nowPosts = await tx.sourcePost.findMany({ where: { id: { in: postIds } }, select: { id: true, processingStatus: true } });
      if (
        sig(nowOps, nowEvidence, nowDecisions, nowExtractions, nowSummaries, nowOverrides, nowPosts) ===
        sig(s.outagePosts, s.evidence, s.linkDecisions, s.extractions, s.summaries, s.overrides, s.posts)
      ) {
        const stillThere = await tx.outage.count({ where: { id: { in: s.outages.map((o) => o.id) } } });
        if (stillThere === s.outages.length) return { posts: postIds.length, outages: 0, entries: 0, alreadyRestored: true };
      }
      // what the repair produced for these posts goes away. The graph is corrected RELATIVELY: only what these posts contributed
      // is swapped (now -> snapshot); anything a newer post has added since is left alone.
      const touchedNodes = new Set();
      const current = await tx.evidenceContribution.findMany({ where: { postId: { in: postIds } } });
      for (const r of current) if (r.kind === 'NODE') touchedNodes.add(r.refA);
      const nowCounts = tally(current);
      const wasCounts = tally(s.evidence);
      const keys = [...new Set([...nowCounts.keys(), ...wasCounts.keys()])].sort((x, y) => (x.startsWith('NODE|') ? 0 : 1) - (y.startsWith('NODE|') ? 0 : 1));
      const nodeById = new Map(s.nodes.map((n) => [n.id, n]));
      const edgeBy = new Map(s.edges.map((e) => [edgeKey(e.parentId, e.childId, e.relationType), e]));
      const nlBy = new Map(s.nodeLocalities.map((l) => [edgeKey(l.nodeId, l.localityId), l]));
      for (const k of keys) {
        const delta = (wasCounts.get(k) ?? 0) - (nowCounts.get(k) ?? 0);
        if (!delta) continue;
        const [kind, a, b] = k.split('|');
        if (kind === 'NODE') {
          const cur = await tx.infraNode.findUnique({ where: { id: a } });
          const snap = nodeById.get(a);
          if (!cur) {
            if (snap) await tx.infraNode.create({ data: { id: a, ...pick(snap, NODE_FIELDS) } }); // a node the repair deleted comes back with the same id
            continue;
          }
          const evidenceCount = Math.max(0, cur.evidenceCount + delta);
          const data = { evidenceCount, lifecycle: evidenceCount >= CONFIRM_AT ? 'CONFIRMED' : cur.lifecycle === 'CONFIRMED' ? 'CANDIDATE' : cur.lifecycle };
          if (snap) {
            if (snap.firstSeenAt < cur.firstSeenAt) data.firstSeenAt = snap.firstSeenAt;
            if (snap.lastSeenAt > cur.lastSeenAt) data.lastSeenAt = snap.lastSeenAt;
          }
          await tx.infraNode.update({ where: { id: a }, data });
        } else {
          const isEdge = kind === 'EDGE';
          const model = isEdge ? tx.infraEdge : tx.nodeLocality;
          const decoded = isEdge ? decodeEdgeEvidenceRef(b) : null;
          const snap = isEdge ? edgeBy.get(edgeKey(a, decoded.childId, decoded.relationType)) : nlBy.get(edgeKey(a, b));
          const relationType = decoded?.relationType;
          const childId = decoded?.childId;
          const where = isEdge ? { parentId_childId_relationType: { parentId: a, childId, relationType } } : { nodeId_localityId: { nodeId: a, localityId: b } };
          const cur = await model.findUnique({ where });
          if (!cur) {
            if (snap && (wasCounts.get(k) ?? 0) > 0) await model.create({ data: isEdge ? { parentId: a, childId, relationType, evidenceCount: wasCounts.get(k), lastSeenAt: snap.lastSeenAt } : { nodeId: a, localityId: b, evidenceCount: wasCounts.get(k), lastSeenAt: snap.lastSeenAt } });
            continue;
          }
          const evidenceCount = cur.evidenceCount + delta;
          if (evidenceCount <= 0) await model.delete({ where });
          else await model.update({ where, data: { evidenceCount, ...(snap && snap.lastSeenAt > cur.lastSeenAt ? { lastSeenAt: snap.lastSeenAt } : {}) } });
        }
      }
      await tx.outagePost.deleteMany({ where: { postId: { in: postIds } } });
      await tx.linkDecision.deleteMany({ where: { postId: { in: postIds } } });
      await tx.evidenceContribution.deleteMany({ where: { postId: { in: postIds } } });
      await tx.linkOverride.deleteMany({ where: { OR: [{ postId: { in: postIds } }, { anchorPostId: { in: postIds } }] } });

      // the readings and their summaries
      await tx.postSummary.deleteMany({ where: { postId: { in: postIds } } });
      for (const x of s.extractions) {
        const { id, postId, promptVersion, ...rest } = x;
        const clean = { ...rest, result: rest.result ?? undefined }; // (a reading that failed has no result to put back)
        await tx.postExtraction.upsert({ where: { postId_promptVersion: { postId, promptVersion } }, create: { id, postId, promptVersion, ...clean }, update: clean });
      }
      if (s.summaries.length) await tx.postSummary.createMany({ data: s.summaries.map(({ postId, faultIndex, summary, model, promptVersion, createdAt }) => ({ postId, faultIndex, summary, model, promptVersion, createdAt })) });

      // the outages the posts were in (recreated if the repair deleted them), then their entries, decisions and evidence
      for (const o of s.outages) {
        const data = pick(o, OUTAGE_FIELDS);
        await tx.outage.upsert({ where: { id: o.id }, create: data, update: { primaryNodeId: o.primaryNodeId } }); // (a node merge changes the main equipment: put it back)
      }
      if (s.outagePosts.length) await tx.outagePost.createMany({ data: s.outagePosts.map(({ outageId, postId, role, score, reasons, faultIndex, postedAt, effect }) => ({ outageId, postId, role, score, reasons: reasons ?? undefined, faultIndex, postedAt, effect: effect ?? undefined })) });
      if (s.linkDecisions.length) await tx.linkDecision.createMany({ data: s.linkDecisions.map(({ id, postId, faultIndex, outcome, outageId, topScore, usedLlm, reason, candidates, createdAt }) => ({ id, postId, faultIndex, outcome, outageId, topScore, usedLlm, reason, candidates: candidates ?? undefined, createdAt })), skipDuplicates: true });
      if (s.evidence.length) await tx.evidenceContribution.createMany({ data: s.evidence.map(({ postId, faultIndex, kind, refA, refB, createdAt }) => ({ postId, faultIndex, kind, refA, refB, createdAt })), skipDuplicates: true });
      if (s.overrides.length) await tx.linkOverride.createMany({ data: s.overrides.map(({ postId, faultIndex, action, anchorPostId, anchorFaultIndex, note, contrastPostId, createdAt }) => ({ postId, faultIndex, action, anchorPostId, anchorFaultIndex, note, contrastPostId, createdAt })), skipDuplicates: true });
      for (const p of s.posts) await tx.sourcePost.update({ where: { id: p.id }, data: { processingStatus: p.processingStatus } });

      // every outage that was, or now is, touched is recomputed from its entries (an outage left with none is removed)
      for (const id of affected) await refoldOutage(tx, id);
      // equipment the repair itself introduced, that nothing supports any more, goes too (as it would in a rebuild)
      const inSnapshot = new Set(s.nodes.map((n) => n.id));
      for (const id of touchedNodes) {
        if (inSnapshot.has(id)) continue;
        const n = await tx.infraNode.findUnique({ where: { id }, select: { evidenceCount: true } });
        if (!n || n.evidenceCount > 0) continue;
        const used = (await tx.outageNode.count({ where: { nodeId: id } })) + (await tx.infraEdge.count({ where: { OR: [{ parentId: id }, { childId: id }] } })) + (await tx.nodeLocality.count({ where: { nodeId: id } }));
        if (!used) await tx.infraNode.delete({ where: { id } });
      }
      return { posts: postIds.length, outages: affected.size, entries: s.outagePosts.length };
    },
    { timeout: 60_000 },
  );
  return out;
}

/** Where each post was in the snapshot and where it is now, for showing what a repair changed. */
export async function describeChange(prisma, raw) {
  const s = revive(raw);
  const titleOf = new Map(s.outages.map((o) => [o.id, `${o.title} [${o.status}]`]));
  const now = await prisma.outagePost.findMany({ where: { postId: { in: s.postIds } }, select: { postId: true, faultIndex: true, outage: { select: { id: true, title: true, status: true, _count: { select: { posts: true } } } } } });
  const rows = [];
  for (const p of s.posts) {
    const was = s.outagePosts.filter((o) => o.postId === p.id).map((o) => ({ faultIndex: o.faultIndex, outageId: o.outageId, label: titleOf.get(o.outageId) ?? o.outageId }));
    const is = now.filter((o) => o.postId === p.id).map((o) => ({ faultIndex: o.faultIndex, outageId: o.outage.id, label: `${o.outage.title} [${o.outage.status}] (${o.outage._count.posts} posts)` }));
    const same = was.length === is.length && was.every((w) => is.some((i) => i.faultIndex === w.faultIndex && i.outageId === w.outageId));
    rows.push({ externalId: p.externalId, was, is, changed: !same });
  }
  return rows;
}
