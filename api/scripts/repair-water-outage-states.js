// Recompute the water outages touched by a known multi-asset bulletin after the per-fault
// recovery fix. Preview by default; --apply writes a backup before taking the pipeline lease.
// --restore=<backup.json> restores the saved outage scalars and scope if no posts changed since.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '../src/db/prisma.js';
import { assertLeaseInTx, PIPELINE, withLease } from '../src/modules/coordination/lease.js';
import { refoldOutage } from '../src/modules/outages/outage-state.js';

const flag = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const postId = flag('post') ?? '2100174345494548955';
const restore = flag('restore');
const apply = process.argv.includes('--apply');
const backupDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'backups');
const selectLinks = { outageId: true, postId: true, faultIndex: true, role: true, postedAt: true, effect: true };
const scalarFields = ['status', 'waterState', 'kind', 'serviceType', 'title', 'sdcName', 'municipalityId', 'cause', 'etaText', 'restorationPercent', 'primaryNodeId', 'retroactive', 'digest', 'startedAt', 'lastUpdateAt', 'restoredAt', 'scheduledStart', 'scheduledEnd'];
const dateFields = new Set(['startedAt', 'lastUpdateAt', 'restoredAt', 'scheduledStart', 'scheduledEnd']);
const summary = (rows) => rows.map((o) => ({ id: o.id, title: o.title, status: o.status, waterState: o.waterState, restorationPercent: o.restorationPercent }));
const linksFor = (db, ids) => db.outagePost.findMany({ where: { outageId: { in: ids } }, select: selectLinks, orderBy: [{ outageId: 'asc' }, { postId: 'asc' }] });

try {
  if (restore) {
    const snapshot = JSON.parse(fs.readFileSync(restore, 'utf8'));
    const ids = snapshot.outages.map((o) => o.id);
    const held = await withLease(PIPELINE, async (ctx) => prisma.$transaction(async (tx) => {
      await assertLeaseInTx(tx, ctx);
      const currentLinks = await linksFor(tx, ids);
      if (JSON.stringify(currentLinks) !== JSON.stringify(snapshot.links)) throw new Error('outage posts changed since the backup; refusing to overwrite newer work');
      for (const original of snapshot.outages) {
        const data = Object.fromEntries(scalarFields.map((field) => [field, dateFields.has(field) && original[field] ? new Date(original[field]) : original[field] ?? null]));
        await tx.outage.update({ where: { id: original.id }, data });
        await tx.outageNode.deleteMany({ where: { outageId: original.id } });
        if (original.nodes.length) await tx.outageNode.createMany({ data: original.nodes.map((n) => ({ outageId: original.id, nodeId: n.nodeId })) });
        await tx.outageLocality.deleteMany({ where: { outageId: original.id } });
        if (original.localities.length) await tx.outageLocality.createMany({ data: original.localities.map((l) => ({ outageId: original.id, localityId: l.localityId, restored: l.restored, impactBasis: l.impactBasis })) });
      }
    }));
    if (!held.acquired) throw new Error('the pipeline is busy; retry after its current cycle');
    console.log(`Restored ${ids.length} water outages from ${restore}`);
  } else {
    const post = await prisma.sourcePost.findFirst({ where: { externalId: postId, serviceType: 'WATER' }, select: { id: true } });
    if (!post) throw new Error(`no water post with external id ${postId}`);
    const ids = [...new Set((await prisma.outagePost.findMany({ where: { postId: post.id }, select: { outageId: true } })).map((p) => p.outageId))];
    if (!ids.length) throw new Error('the post has no linked water outages');
    const read = (db) => db.outage.findMany({ where: { id: { in: ids }, serviceType: 'WATER' }, include: { nodes: true, localities: true }, orderBy: { id: 'asc' } });
    if (!apply) {
      console.log(JSON.stringify({ post: postId, affected: summary(await read(prisma)), applyWith: `node scripts/repair-water-outage-states.js --post=${postId} --apply` }, null, 2));
    } else {
      const held = await withLease(PIPELINE, async (ctx) => {
        const before = await read(prisma);
        if (before.length !== ids.length) throw new Error('one of the linked outages is not water; refusing to change it');
        const links = await linksFor(prisma, ids);
        fs.mkdirSync(backupDir, { recursive: true });
        const backup = path.join(backupDir, `water-refold-${postId}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
        fs.writeFileSync(backup, JSON.stringify({ post: postId, outages: before, links }, null, 2));
        await prisma.$transaction(async (tx) => {
          await assertLeaseInTx(tx, ctx);
          for (const id of ids) await refoldOutage(tx, id);
        });
        return { backup, before: summary(before), after: summary(await read(prisma)) };
      });
      if (!held.acquired) throw new Error('the pipeline is busy; retry after its current cycle');
      console.log(JSON.stringify({ ...held.value, undoWith: `node scripts/repair-water-outage-states.js --restore=${held.value.backup}` }, null, 2));
    }
  }
} finally { await prisma.$disconnect(); }
