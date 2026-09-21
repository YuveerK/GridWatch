import { assertLeaseInTx } from '../coordination/lease.js';
import { refoldOutage } from '../outages/outage-state.js';

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
      nodeIds.add(e.refA);
      nodeIds.add(e.refB);
      edgeKeys.push({ parentId: e.refA, childId: e.refB });
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

const OUTAGE_FIELDS = ['id', 'kind', 'status', 'title', 'sdcName', 'cause', 'etaText', 'restorationPercent', 'primaryNodeId', 'retroactive', 'digest', 'startedAt', 'lastUpdateAt', 'restoredAt', 'scheduledStart', 'scheduledEnd', 'createdAt'];
const pick = (row, keys) => Object.fromEntries(keys.filter((k) => k in row).map((k) => [k, row[k]]));

/** Undo a repair: put the snapshot back. `ctx` is the held pipeline lease. Returns what was restored. */
export async function restoreSnapshot({ prisma, snapshot: raw, ctx }) {
  const s = revive(raw);
  const postIds = s.postIds;
  const before = await prisma.outagePost.findMany({ where: { postId: { in: postIds } }, select: { outageId: true } });
  const affected = new Set([...before.map((o) => o.outageId), ...s.outagePosts.map((o) => o.outageId)]);

  await prisma.$transaction(
    async (tx) => {
      await assertLeaseInTx(tx, ctx);
      // what the repair produced for these posts goes away, including what it taught the graph (counters taken back, as re-linking does)
      const touchedNodes = new Set();
      for (const r of await tx.evidenceContribution.findMany({ where: { postId: { in: postIds } } })) {
        if (r.kind === 'NODE') {
          const n = await tx.infraNode.findUnique({ where: { id: r.refA } });
          if (n) await tx.infraNode.update({ where: { id: n.id }, data: { evidenceCount: Math.max(0, n.evidenceCount - 1) } });
          touchedNodes.add(r.refA);
        } else if (r.kind === 'EDGE') {
          const key = { parentId_childId: { parentId: r.refA, childId: r.refB } };
          const e = await tx.infraEdge.findUnique({ where: key });
          if (e) await (e.evidenceCount <= 1 ? tx.infraEdge.delete({ where: key }) : tx.infraEdge.update({ where: key, data: { evidenceCount: { decrement: 1 } } }));
        } else if (r.kind === 'NODE_LOCALITY') {
          const key = { nodeId_localityId: { nodeId: r.refA, localityId: r.refB } };
          const l = await tx.nodeLocality.findUnique({ where: key });
          if (l) await (l.evidenceCount <= 1 ? tx.nodeLocality.delete({ where: key }) : tx.nodeLocality.update({ where: key, data: { evidenceCount: { decrement: 1 } } }));
        }
      }
      await tx.outagePost.deleteMany({ where: { postId: { in: postIds } } });
      await tx.linkDecision.deleteMany({ where: { postId: { in: postIds } } });
      await tx.evidenceContribution.deleteMany({ where: { postId: { in: postIds } } });
      await tx.linkOverride.deleteMany({ where: { OR: [{ postId: { in: postIds } }, { anchorPostId: { in: postIds } }] } });

      // the graph, with its counters as they were (a node a repair deleted comes back with the same id)
      for (const n of s.nodes) {
        const data = pick(n, ['type', 'name', 'normalizedKey', 'lifecycle', 'evidenceCount', 'firstSeenAt', 'lastSeenAt']);
        await tx.infraNode.upsert({ where: { id: n.id }, create: { id: n.id, ...data }, update: data });
      }
      for (const e of s.edges) {
        await tx.infraEdge.upsert({ where: { parentId_childId: { parentId: e.parentId, childId: e.childId } }, create: { parentId: e.parentId, childId: e.childId, evidenceCount: e.evidenceCount, lastSeenAt: e.lastSeenAt }, update: { evidenceCount: e.evidenceCount, lastSeenAt: e.lastSeenAt } });
      }
      for (const l of s.nodeLocalities) {
        await tx.nodeLocality.upsert({ where: { nodeId_localityId: { nodeId: l.nodeId, localityId: l.localityId } }, create: { nodeId: l.nodeId, localityId: l.localityId, evidenceCount: l.evidenceCount, lastSeenAt: l.lastSeenAt }, update: { evidenceCount: l.evidenceCount, lastSeenAt: l.lastSeenAt } });
      }

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
    },
    { timeout: 60_000 },
  );
  return { posts: postIds.length, outages: affected.size, entries: s.outagePosts.length };
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
