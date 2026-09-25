import { prisma } from '../../db/prisma.js';
import { categorize, categoryLabel } from '../../lib/fault-category.js';
import { isLong } from '../../lib/durations.js';

const HOUR = 3_600_000;
const MIN_FOR_TYPICAL = 3; // fewer restored outages than this is too few to call anything "typical"
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round1 = (n) => Number(n.toFixed(1));

/**
 * Pure: one suburb's outage history and what is typical for it.
 *   outages: [{ id, title, kind, status, retroactive, cause, startedAt, restoredAt, equipment: [name], alsoAffected: [name] }]
 */
export function buildLocalityHistory({ outages, days, now = new Date(), earliest = null }) {
  const rows = [...outages]
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt) || a.id.localeCompare(b.id))
    .map((o) => {
      // an outage first seen as a "power restored" post has no real start, so it has no honest duration
      const hours = o.restoredAt && !o.retroactive ? (new Date(o.restoredAt) - new Date(o.startedAt)) / HOUR : null;
      return {
        id: o.id,
        title: o.title,
        kind: o.kind,
        status: o.status,
        retroactive: Boolean(o.retroactive),
        startedAt: o.startedAt,
        durationHours: hours != null && hours >= 0 ? round1(hours) : null,
        cause: o.cause ?? null,
        category: o.kind === 'PLANNED' ? 'MAINTENANCE' : categorize(o.cause),
        equipment: o.equipment,
        alsoAffected: o.alsoAffected,
      };
    });

  const faults = rows.filter((r) => r.kind === 'UNPLANNED');
  const restoredAll = faults.map((r) => r.durationHours).filter((h) => h != null);
  const restoredHours = restoredAll.filter((h) => !isLong(h)); // long repair sagas are not what is typical
  const longCount = restoredAll.length - restoredHours.length;
  const tally = (list) => {
    const m = new Map();
    for (const x of list) m.set(x, (m.get(x) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  };
  const topCause = tally(faults.map((r) => r.category).filter((c) => c !== 'UNKNOWN'))[0];
  const topEquipment = tally(faults.flatMap((r) => r.equipment))[0];

  const byCause = [...new Set(faults.map((r) => r.category))]
    .map((id) => {
      const hours = faults.filter((r) => r.category === id).map((r) => r.durationHours).filter((h) => h != null && !isLong(h));
      return { id, label: categoryLabel(id), outages: faults.filter((r) => r.category === id).length, restored: hours.length, medianHours: hours.length >= MIN_FOR_TYPICAL ? round1(median(hours)) : null };
    })
    .sort((a, b) => b.outages - a.outages);

  return {
    days,
    dataDays: earliest ? Math.max(1, Math.round((now.getTime() - new Date(earliest).getTime()) / (24 * HOUR))) : 0,
    total: rows.length,
    faults: faults.length,
    planned: rows.length - faults.length,
    typical: {
      minimum: MIN_FOR_TYPICAL,
      restored: restoredHours.length,
      longExcluded: longCount,
      medianHours: restoredHours.length >= MIN_FOR_TYPICAL ? round1(median(restoredHours)) : null,
      topCause: topCause ? { id: topCause[0], label: categoryLabel(topCause[0]), count: topCause[1] } : null,
      topEquipment: topEquipment ? { name: topEquipment[0], count: topEquipment[1] } : null,
    },
    byCause,
    rows,
  };
}

export async function localityHistory({ localityId, days = 90, service = 'ELECTRICITY', now = new Date() }) {
  const since = new Date(now.getTime() - days * 24 * HOUR);
  const [outages, oldest] = await Promise.all([
    prisma.outage.findMany({
      where: { startedAt: { gte: since }, serviceType: service, localities: { some: { localityId } } },
      select: {
        id: true, title: true, kind: true, status: true, retroactive: true, cause: true, startedAt: true, restoredAt: true,
        nodes: { where: { node: { type: { notIn: ['SDC', 'CABLE', 'LINE', 'OTHER'] } } }, select: { node: { select: { name: true } } } },
        localities: { where: { localityId: { not: localityId } }, select: { locality: { select: { canonicalName: true } } } },
      },
      orderBy: [{ startedAt: 'desc' }, { id: 'asc' }],
      take: 200,
    }),
    prisma.outage.aggregate({ where: { serviceType: service }, _min: { startedAt: true } }),
  ]);
  return buildLocalityHistory({
    outages: outages.map((o) => ({ ...o, equipment: o.nodes.map((n) => n.node.name), alsoAffected: o.localities.map((l) => l.locality.canonicalName).slice(0, 6) })),
    days,
    now,
    earliest: oldest._min.startedAt,
  });
}
