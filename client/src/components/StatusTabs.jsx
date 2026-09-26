import { Link } from 'react-router-dom';

export const TABS = [
  { id: 'live', label: 'Live', status: 'ACTIVE,PARTIALLY_RESTORED', count: (c) => (c.ACTIVE ?? 0) + (c.PARTIALLY_RESTORED ?? 0) },
  { id: 'planned', label: 'Planned', status: 'PLANNED', count: (c) => c.PLANNED ?? 0 },
  { id: 'restored', label: 'Restored', status: 'RESTORED,CLOSED', count: (c) => (c.RESTORED ?? 0) + (c.CLOSED ?? 0) },
  { id: 'stale', label: 'No recent update', status: 'STALE', count: (c) => c.STALE ?? 0 },
  { id: 'all', label: 'All', status: 'ACTIVE,PARTIALLY_RESTORED,PLANNED,RESTORED,STALE,CLOSED,CANCELLED', count: (c) => Object.values(c).reduce((a, b) => a + b, 0) },
];

/**
 * The status tabs shared by the incident list and the planned-work page, so Planned reads as one tab of the same list
 * rather than a separate place. Each tab is a link; `counts` (from /v1/stats) adds the numbers, and `keep` (the list's
 * other filters: search, sort, service centre) is carried from one list tab to the next.
 */
export default function StatusTabs({ active, counts, keep }) {
  const href = (id) => {
    if (id === 'planned') return '/planned';
    const p = new URLSearchParams(keep ?? '');
    p.delete('status');
    if (id !== 'live') p.set('status', id);
    const qs = p.toString();
    return `/outages${qs ? `?${qs}` : ''}`;
  };
  return (
    <nav className="seg" aria-label="Filter by status">
      {TABS.map((t) => (
        <Link
          key={t.id}
          to={href(t.id)}
          className="seg-link"
          aria-current={t.id === active ? 'page' : undefined}
        >
          {t.label}
          {counts && <span className="n num">{t.count(counts)}</span>}
        </Link>
      ))}
    </nav>
  );
}
