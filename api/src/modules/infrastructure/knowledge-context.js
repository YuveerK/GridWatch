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
