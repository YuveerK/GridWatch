import { useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { OutageRow } from '../components/OutageCard.jsx';
import StatusTabs, { TABS } from '../components/StatusTabs.jsx';
import { CardSkeleton, EmptyState, ErrorState, ServiceIdentity } from '../components/ui.jsx';
import { prettySdc, plural, useApi } from '../lib/api.js';
import { useDocumentTitle } from '../lib/hooks.js';
import { useMunicipality, withMunicipality } from '../lib/municipality.jsx';

const PAGE = 24;

export default function Outages() {
  useDocumentTitle('Incidents');
  const [params, setParams] = useSearchParams();
  const tabId = params.get('status') ?? 'live';
  const sdc = params.get('sdc') ?? '';
  const region = params.get('region') ?? '';
  const q = params.get('q') ?? '';
  const sort = params.get('sort') ?? 'updated';
  const [pages, setPages] = useState(1);
  const tab = TABS.find((t) => t.id === tabId) ?? TABS[0];

  const set = (patch) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
    setPages(1);
    setParams(next, { replace: true });
  };

  const { param: muniParam, name, service } = useMunicipality();
  const water = service === 'WATER';
  const noun = water ? 'water incident' : 'outage';
  const stats = useApi(withMunicipality('/v1/stats', muniParam));
  const query = withMunicipality(`/v1/outages?status=${tab.status}&sort=${sort}&limit=${PAGE * pages}${!water && sdc ? `&sdc=${encodeURIComponent(sdc)}` : ''}${region ? `&region=${encodeURIComponent(region)}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`, muniParam);
  const { data, error, loading, refreshing } = useApi(query);
  const counts = stats.data?.outagesByStatus ?? {};
  const sdcs = (stats.data?.activeBySdc ?? []).map((s) => s.sdc).sort();
  if (tab.id === 'planned') return <Navigate to="/planned" replace />;

  return (
    <div className="container page">
      <header className="page-head">
        <ServiceIdentity service={service} />
        <h1>{water ? 'Water incidents' : 'Electricity outages'}</h1>
        <p>Every {water ? 'water supply incident' : 'electricity outage'} reported{name ? ` for ${name}` : ''}, grouped so each incident appears once with its full history.</p>
      </header>

      <div className="toolbar">
        <StatusTabs active={tab.id} counts={stats.data ? counts : null} keep={params.toString()} />
        <div className="filters">
          <input className="field" type="search" placeholder="Filter by suburb or equipment" aria-label="Filter by suburb or equipment" value={q} onChange={(e) => set({ q: e.target.value })} />
          {!water && <select className="field" aria-label="Service centre" value={sdc} onChange={(e) => set({ sdc: e.target.value })}>
            <option value="">All service centres</option>
            {sdcs.map((s) => <option key={s} value={s}>{prettySdc(s)}</option>)}
          </select>}
          <select className="field" aria-label="Sort" value={sort} onChange={(e) => set({ sort: e.target.value === 'updated' ? '' : e.target.value })}>
            <option value="updated">Recently updated</option>
            <option value="started">Newest first</option>
            <option value="name">Name A–Z</option>
          </select>
        </div>
      </div>

      {error && !data && <ErrorState error={error} />}
      {loading && !data && <CardSkeleton n={6} />}
      {data && (
        <div className={refreshing ? 'fading' : undefined}>
          <p className="small muted" style={{ marginBottom: 12 }} aria-live="polite">
            {data.total === 0 ? `No ${noun}s match` : `Showing ${data.data.length} of ${plural(data.total, noun)}`}
            {!water && sdc ? ` in ${prettySdc(sdc)}` : ''}{region ? ` in Region ${region}` : ''}{q ? ` matching “${q}”` : ''}
          </p>
          {data.data.length === 0 ? (
            <EmptyState icon="search" title="Nothing here" action={<button className="btn" onClick={() => set({ status: '', sdc: '', region: '', q: '' })}>Clear filters</button>}>
              {tab.id === 'live' ? `There are no live ${noun}s that match. That is good news, or try another filter.` : 'Try a different status or clear the filters.'}
            </EmptyState>
          ) : (
            <ul className="ledger">{data.data.map((o) => <OutageRow key={o.id} outage={o} />)}</ul>
          )}
          {data.data.length < data.total && (
            <div style={{ textAlign: 'center', marginTop: 24 }}>
              <button className="btn" onClick={() => setPages((p) => p + 1)}>Show more</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
