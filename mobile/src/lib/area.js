import { sameService } from './query.js';
import { statusMeta } from './status.js';

const QUIET = new Set(['RESTORED', 'CLOSED', 'CANCELLED']);

/** The single status a suburb should show for one service. */
export function areaHeadline(outages, service) {
  const rows = sameService(outages, service).filter((outage) => !QUIET.has(outage.status));
  rows.sort((a, b) => statusMeta(a.status, service, a.waterState).order - statusMeta(b.status, service, b.waterState).order
    || new Date(b.lastUpdateAt ?? 0).getTime() - new Date(a.lastUpdateAt ?? 0).getTime());
  const top = rows[0];
  if (!top) {
    return service === 'WATER'
      ? { label: 'No interruption reported', long: 'No water interruption reported for this suburb', tone: 'idle', icon: 'check', order: 9 }
      : { label: 'No outage reported', long: 'No power outage reported for this suburb', tone: 'idle', icon: 'check', order: 9 };
  }
  return statusMeta(top.status, service, top.waterState);
}

/** Active first, then partial, then planned. */
export function sortOutages(rows) {
  return [...(rows ?? [])].sort((a, b) => {
    const left = statusMeta(a.status, a.service ?? 'ELECTRICITY', a.waterState).order;
    const right = statusMeta(b.status, b.service ?? 'ELECTRICITY', b.waterState).order;
    if (left !== right) return left - right;
    return new Date(b.lastUpdateAt ?? 0).getTime() - new Date(a.lastUpdateAt ?? 0).getTime();
  });
}

export function placeName(outage) {
  return outage?.localities?.[0]?.canonicalName || outage?.title || 'Outage';
}

export function equipmentLabel(node) {
  const type = String(node?.type ?? '').toLowerCase().replaceAll('_', ' ');
  return type ? `${node.name} · ${type}` : node?.name ?? '';
}
