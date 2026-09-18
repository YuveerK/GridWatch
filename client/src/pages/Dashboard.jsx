import { useState } from 'react';
import { ErrorBox, Loading, OutageCard, SuburbSearch } from '../components.jsx';
import { prettySdc, timeAgo, useApi } from '../api.js';

const FILTERS = [
  { id: 'live', label: 'Live', status: 'ACTIVE,PARTIALLY_RESTORED' },
  { id: 'planned', label: 'Planned', status: 'PLANNED' },
  { id: 'restored', label: 'Restored', status: 'RESTORED' },
  { id: 'all', label: 'All', status: 'ACTIVE,PARTIALLY_RESTORED,PLANNED,RESTORED,CANCELLED,CLOSED' },
];

export default function Dashboard() {
  const [filter, setFilter] = useState('live');
  const [sdc, setSdc] = useState('');
  const stats = useApi('/v1/stats');
  const status = FILTERS.find((f) => f.id === filter).status;
  const outages = useApi(`/v1/outages?status=${status}&limit=200${sdc ? `&sdc=${encodeURIComponent(sdc)}` : ''}`);

  const counts = stats.data?.outagesByStatus ?? {};
  const live = (counts.ACTIVE ?? 0) + (counts.PARTIALLY_RESTORED ?? 0);
  const sdcs = (stats.data?.activeBySdc ?? []).map((s) => s.sdc).sort();

  return (
    <>
      <section className="hero">
        <h1>What's happening with the power in Johannesburg?</h1>
        <p className="muted">City Power posts a lot on X. GridWatch pulls it together into one outage per fault.</p>
        <SuburbSearch />
        {stats.data && (
          <p className="small muted">
            {live} live outage{live === 1 ? '' : 's'} · {counts.PLANNED ?? 0} planned · last post {stats.data.lastPostAt ? timeAgo(stats.data.lastPostAt) : 'n/a'}
          </p>
        )}
      </section>

      <div className="toolbar">
        <div className="tabs" role="tablist">
          {FILTERS.map((f) => (
            <button key={f.id} role="tab" aria-selected={filter === f.id} className={filter === f.id ? 'on' : ''} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
        <label className="select">
          <span className="sr">Service delivery centre</span>
          <select value={sdc} onChange={(e) => setSdc(e.target.value)}>
            <option value="">All service centres</option>
            {sdcs.map((s) => <option key={s} value={s}>{prettySdc(s)}</option>)}
          </select>
        </label>
      </div>

      {outages.loading && <Loading />}
      {outages.error && <ErrorBox error={outages.error} />}
      {outages.data && outages.data.data.length === 0 && <p className="empty">No outages match this filter.</p>}
      <div className="grid">
        {outages.data?.data.map((o) => <OutageCard key={o.id} outage={o} />)}
      </div>
    </>
  );
}
