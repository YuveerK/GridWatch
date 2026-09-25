import { prisma } from '../../db/prisma.js';
import { ALL_CATEGORIES, ALL_WATER_CATEGORIES, categorize, categorizeWater, categoryLabel } from '../../lib/fault-category.js';
import { isLong } from '../../lib/durations.js';
import { UTILITIES, outageInMunicipality } from './municipality-scope.js';
import { outageInService } from './service-scope.js';

const HOUR = 3_600_000;
const MIN_FOR_MEDIAN = 3; // fewer than this is too few to call anything "typical"
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const dayOf = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg' }).format(d);
const startOfDay = (date) => Date.parse(`${date}T00:00:00+02:00`); // Johannesburg has no daylight saving

/**
 * Pure: the by-area row an outage belongs to, and the outages-list filter that finds the same outages (null: none can).
 *   { sdcName, municipality: code, regions: [GIS region code of each affected suburb] }
 * A named service centre always wins. A municipality whose posts name none (UTILITIES[code].areas === 'region') groups by
 * the region most of its suburbs sit in, lowest code on a tie.
 */
export function areaOf({ sdcName = null, municipality = null, regions = [], assetName = null, assetId = null }) {
  if (assetName) return { area: assetName, filter: null, href: assetId ? `/network/${assetId}` : null };
  if (sdcName) return { area: sdcName, filter: { sdc: sdcName } };
  const u = UTILITIES[municipality];
  if (u?.areas !== 'region') return { area: 'Unknown', filter: null };
  const n = new Map();
  for (const r of regions) if (r) n.set(r, (n.get(r) ?? 0) + 1);
  const [code] = [...n].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), 'en', { numeric: true }))[0] ?? [];
  return code ? { area: `${u.short} Region ${code}`, filter: { region: code } } : { area: `${u.short}: region not known`, filter: null };
}

/**
 * Pure: turn unplanned outages (and the equipment each involved) into the insights view.
 *   outages:   [{ id, title, sdcName, municipality?, regions?, cause, status, startedAt, restoredAt }]  (may reach back further than the window: the week comparison needs it)
 *   equipment: [{ outageId, nodeId, name, type }]
 *   earliest:  when the oldest outage in the whole database began, so the page can say how much history it stands on
 */
export function buildInsights({ outages: everything, equipment = [], days, now = new Date(), earliest = null, categorize: categorizeFn = categorize, categories = ALL_CATEGORIES }) {
  // whole Johannesburg days, today included, so the totals cover exactly the days the trend shows
  const dayList = Array.from({ length: days }, (_, k) => dayOf(new Date(now.getTime() - (days - 1 - k) * 24 * HOUR)));
  const windowStart = startOfDay(dayList[0]);
  const outages = everything.filter((o) => new Date(o.startedAt).getTime() >= windowStart);
  const cat = new Map(everything.map((o) => [o.id, categorizeFn(o.cause)]));
  const total = outages.length;

  const counts = new Map();
  const wordings = new Map();
  for (const o of outages) {
    const c = cat.get(o.id);
    counts.set(c, (counts.get(c) ?? 0) + 1);
    if (o.cause) {
      const w = wordings.get(c) ?? new Map();
      const key = o.cause.trim().toLowerCase();
      w.set(key, (w.get(key) ?? 0) + 1);
      wordings.set(c, w);
    }
  }
  const causes = categories.map((c) => ({
    id: c.id,
    label: c.label,
    count: counts.get(c.id) ?? 0,
    share: total ? (counts.get(c.id) ?? 0) / total : 0,
    wordings: [...(wordings.get(c.id) ?? [])].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([text, n]) => ({ text, count: n })),
  }))
    .filter((c) => c.count > 0)
    .sort((a, b) => (a.id === 'UNKNOWN') - (b.id === 'UNKNOWN') || b.count - a.count);

  // per day, per category (oldest first, zero-filled)
  const perDay = new Map();
  for (const o of outages) {
    const key = `${cat.get(o.id)}|${dayOf(new Date(o.startedAt))}`;
    perDay.set(key, (perDay.get(key) ?? 0) + 1);
  }
  const trend = causes.map((c) => ({ id: c.id, label: c.label, days: dayList.map((date) => ({ date, count: perDay.get(`${c.id}|${date}`) ?? 0 })) }));

  // area (service centre, or region where posts name none) x category
  const placeOf = new Map(outages.map((o) => [o.id, areaOf(o)]));
  const areas = new Map();
  for (const o of outages) {
    const { area, filter } = placeOf.get(o.id);
    const row = areas.get(area) ?? { area, filter, total: 0, cells: {} };
    row.total += 1;
    row.cells[cat.get(o.id)] = (row.cells[cat.get(o.id)] ?? 0) + 1;
    areas.set(area, row);
  }
  const citywide = new Map(causes.map((c) => [c.id, c.share]));
  const byArea = [...areas.values()]
    .sort((a, b) => b.total - a.total || a.area.localeCompare(b.area))
    .map((r) => {
      const stated = Object.entries(r.cells).filter(([id]) => id !== 'UNKNOWN');
      const top = stated.sort((a, b) => b[1] - a[1])[0];
      // what this area has MORE of than the city as a whole (needs at least 3 cases, and 30% above the city rate)
      const standout = stated
        .map(([id, count]) => ({ id, label: categoryLabel(id), count, lift: count / r.total / (citywide.get(id) || 1) }))
        .filter((x) => x.count >= 3 && x.lift >= 1.3)
        .sort((a, b) => b.lift - a.lift)[0] ?? null;
      return { ...r, topCause: top ? { id: top[0], label: categoryLabel(top[0]), count: top[1] } : null, standout: standout ? { ...standout, lift: Number(standout.lift.toFixed(2)) } : null };
    });

  // how long it took to get power back, by cause and by area (only outages with a recorded restoration)
  const hours = (o) => (new Date(o.restoredAt) - new Date(o.startedAt)) / HOUR;
  const restored = outages.filter((o) => o.restoredAt && hours(o) >= 0 && !isLong(hours(o))); // long repair sagas are not what is typical
  const longExcluded = outages.filter((o) => o.restoredAt && isLong(hours(o))).length;
  const speed = (group) => {
    const xs = group.map(hours);
    return { n: xs.length, medianHours: xs.length >= MIN_FOR_MEDIAN ? Number(median(xs).toFixed(1)) : null };
  };
  const restoreByCause = causes.map((c) => ({ id: c.id, label: c.label, ...speed(restored.filter((o) => cat.get(o.id) === c.id)) })).filter((r) => r.n > 0);
  const restoreByArea = byArea.map((a) => ({ area: a.area, ...speed(restored.filter((o) => placeOf.get(o.id).area === a.area)) })).filter((r) => r.n > 0);

  // the same equipment failing again and again
  const outageById = new Map(outages.map((o) => [o.id, o]));
  const nodes = new Map();
  for (const e of equipment) {
    const o = outageById.get(e.outageId);
    if (!o) continue;
    const n = nodes.get(e.nodeId) ?? { id: e.nodeId, name: e.name, type: e.type, outages: new Set(), area: placeOf.get(o.id).filter ? placeOf.get(o.id).area : null, causes: new Map() };
    n.outages.add(o.id);
    const c = cat.get(o.id);
    n.causes.set(c, (n.causes.get(c) ?? 0) + 1);
    nodes.set(e.nodeId, n);
  }
  const repeat = [...nodes.values()]
    .filter((n) => n.outages.size >= 2)
    .map((n) => ({ id: n.id, name: n.name, type: n.type, area: n.area, count: n.outages.size, causes: [...n.causes].sort((a, b) => b[1] - a[1]).map(([id, count]) => ({ id, label: categoryLabel(id), count })) }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 12);

  // this week against last week: only once there are 14 days of history to compare
  const week = 7 * 24 * HOUR;
  const dataDays = earliest ? Math.max(1, Math.round((now.getTime() - new Date(earliest).getTime()) / (24 * HOUR))) : 0;
  const inRange = (o, from, to) => {
    const t = new Date(o.startedAt).getTime();
    return t >= from && t < to;
  };
  const thisWeek = everything.filter((o) => inRange(o, now.getTime() - week, now.getTime() + 1));
  const lastWeek = everything.filter((o) => inRange(o, now.getTime() - 2 * week, now.getTime() - week));
  const tally = (list) => list.reduce((m, o) => m.set(cat.get(o.id), (m.get(cat.get(o.id)) ?? 0) + 1), new Map());
  const a = tally(thisWeek);
  const b = tally(lastWeek);
  const weekly = {
    available: dataDays >= 14 && lastWeek.length >= 10,
    thisWeek: thisWeek.length,
    lastWeek: lastWeek.length,
    byCause: ALL_CATEGORIES.filter((c) => a.get(c.id) || b.get(c.id)).map((c) => ({ id: c.id, label: c.label, thisWeek: a.get(c.id) ?? 0, lastWeek: b.get(c.id) ?? 0 })),
  };

  // stated causes that matched none of the rules: what to add next
  const unsorted = [...(wordings.get('OTHER') ?? [])].sort((x, y) => y[1] - x[1]).map(([text, n]) => ({ text, count: n }));

  return {
    dataDays,
    weekly,
    unsorted,
    window: { days, from: dayList[0], to: dayList.at(-1) },
    total,
    stated: total - (counts.get('UNKNOWN') ?? 0),
    unknownShare: total ? (counts.get('UNKNOWN') ?? 0) / total : 0,
    causes,
    trend,
    byArea,
    restore: { minimum: MIN_FOR_MEDIAN, longExcluded, byCause: restoreByCause, byArea: restoreByArea },
    repeat,
  };
}

export async function insights({ days = 14, municipality = null, service = 'ELECTRICITY', now = new Date() } = {}) {
  const since = new Date(now.getTime() - Math.max(days, 14) * 24 * HOUR); // at least two weeks back, for the week-on-week comparison
  const scoped = { ...outageInMunicipality(municipality), ...outageInService(service) };
  const oldest = await prisma.outage.aggregate({ where: { kind: 'UNPLANNED', ...scoped }, _min: { startedAt: true } });
  const outages = await prisma.outage.findMany({
    where: { kind: 'UNPLANNED', startedAt: { gte: since }, ...scoped },
    select: {
      id: true, title: true, sdcName: true, cause: true, status: true, startedAt: true, restoredAt: true,
      Municipality: { select: { code: true } },
      localities: { select: { locality: { select: { Region: { select: { code: true } } } } } },
    },
    orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
  }).then((rows) => rows.map(({ Municipality, localities, ...o }) => ({ ...o, municipality: Municipality?.code ?? null, regions: localities.map((l) => l.locality.Region?.code ?? null) })));
  const links = outages.length
    ? await prisma.outageNode.findMany({ where: { outageId: { in: outages.map((o) => o.id) }, node: { type: { notIn: ['SDC', 'CABLE', 'LINE', 'OTHER'] } } }, select: { outageId: true, nodeId: true, node: { select: { name: true, type: true } } } })
    : [];
  const equipment = links.map((l) => ({ outageId: l.outageId, nodeId: l.nodeId, name: l.node.name, type: l.node.type }));
  const water = service === 'WATER';
  if (water) {
    const prefer = ['RESERVOIR', 'WATER_TOWER', 'WATER_SYSTEM', 'PUMP_STATION', 'PRV', 'DIRECT_FEED', 'TREATMENT_WORKS', 'BOOSTER_STATION'];
    const rank = (type) => { const i = prefer.indexOf(type); return i === -1 ? 99 : i; };
    const byOutage = new Map();
    for (const e of equipment) {
      if (rank(e.type) >= 99) continue;
      const current = byOutage.get(e.outageId);
      if (!current || rank(e.type) < rank(current.type)) byOutage.set(e.outageId, e);
    }
    for (const o of outages) {
      const asset = byOutage.get(o.id);
      if (asset) { o.assetName = asset.name; o.assetId = asset.nodeId; }
    }
  }
  return buildInsights({ outages, equipment, days, now, earliest: oldest._min.startedAt, categorize: water ? categorizeWater : categorize, categories: water ? ALL_WATER_CATEGORIES : ALL_CATEGORIES });
}
