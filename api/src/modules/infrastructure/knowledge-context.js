import { prisma } from '../../db/prisma.js';
import { infraKey } from '../../lib/normalize.js';

export function sdcFromText(text) {
  const m = /#([A-Za-z]+?)SDC\b/.exec(text ?? '');
  return m ? m[1] : null;
}

/** Compact list of infrastructure already learned under an SDC, for the extraction prompt. */
export async function knowledgeContext(sdcName, limit = 40) {
  if (!sdcName) return null;
  const sdc = await prisma.infraNode.findFirst({ where: { type: 'SDC', normalizedKey: infraKey(sdcName) } });
  if (!sdc) return null;
  const level1 = await prisma.infraEdge.findMany({
    where: { parentId: sdc.id },
    include: { child: true },
    orderBy: { evidenceCount: 'desc' },
    take: limit,
  });
  const lines = [];
  for (const e of level1) {
    const kids = await prisma.infraEdge.findMany({ where: { parentId: e.childId }, include: { child: true }, orderBy: { evidenceCount: 'desc' }, take: 5 });
    lines.push(`- ${e.child.type} ${e.child.name}${kids.length ? ` → ${kids.map((k) => `${k.child.type} ${k.child.name}`).join('; ')}` : ''}`);
  }
  return lines.length ? lines.join('\n') : null;
}

/** Bounded water context: assets whose names appear in the notice, plus one hop. */
export async function waterKnowledgeContext(text, limit = 24) {
  const words = infraKey(text ?? '').split(' ').filter((w) => w.length >= 5).slice(0, 8);
  if (!words.length) return null;
  const nodes = await prisma.infraNode.findMany({
    where: { serviceType: 'WATER', OR: words.map((w) => ({ normalizedKey: { contains: w } })) },
    take: limit,
    select: { id: true, name: true, type: true },
  });
  if (!nodes.length) return null;
  const ids = nodes.map((n) => n.id);
  const edges = await prisma.infraEdge.findMany({
    where: { OR: [{ parentId: { in: ids } }, { childId: { in: ids } }], relationType: { not: 'LEGACY_PARENT' } },
    include: { parent: { select: { name: true, type: true } }, child: { select: { name: true, type: true } } },
    take: limit,
  });
  const lines = nodes.map((n) => `- ${n.type} ${n.name}`);
  for (const e of edges) lines.push(`- ${e.parent.name} ${e.relationType} ${e.child.name}`);
  return lines.join('\n');
}
