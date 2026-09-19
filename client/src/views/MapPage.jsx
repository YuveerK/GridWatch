import { lazy, Suspense, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import Icon from '../components/Icon.jsx';
import { EmptyState, ErrorState, Skeleton } from '../components/ui.jsx';
import { StatusBadge } from '../components/ui.jsx';
import { nice, plural, timeAgo, useApi } from '../lib/api.js';
import { useDocumentTitle } from '../lib/hooks.js';

const MapView = lazy(() => import('../components/MapView.jsx'));

export function MapFallback({ height = 460 }) {
  return <div className="map map-loading" style={{ height }}><Skeleton h={height} r={16} /></div>;
}

export function Legend({ items }) {
  return (
    <ul className="legend" aria-label="Map key">
      {items.map(([tone, text, hollow]) => (
        <li key={text}><i className={`key-dot tone-${tone}${hollow ? ' hollow' : ''}`} />{text}</li>
      ))}
    </ul>
  );
}

const toneOf = (status, restored) => (restored ? 'good' : status === 'PARTIALLY_RESTORED' ? 'partial' : 'live');

export default function MapPage() {
  useDocumentTitle('Map');
  const { data, error } = useApi('/v1/map', { refreshMs: 60_000 });
  const [selected, setSelected] = useState(null);
  const outages = data?.data ?? [];

  const points = useMemo(
    () => outages.flatMap((o) => o.places.map((p) => ({
      id: `${o.id}:${p.id}`,
      name: nice(p.name),
      lat: p.lat,
      lon: p.lon,
      tone: toneOf(o.status, p.restored),
      inferred: p.inferred,
      group: o.id,
      r: 8,
      note: `${o.title}${p.inferred ? ' · likely area, not confirmed' : p.restored ? ' · power back' : ' · affected'}`,
    }))),
    [outages],
  );
  const chosen = outages.find((o) => o.id === selected) ?? null;
  const mapped = outages.filter((o) => o.places.length).length;

  return (
    <div className="container page">
      <header className="page-head">
        <h1>Outage map</h1>
        <p>Where power is out right now. Each dot is a suburb City Power has named, placed at its centre, so read it as "roughly here", not as exact streets.</p>
      </header>

      {error && !data && <ErrorState error={error} />}
      {!data && !error && <Skeleton h={480} r={16} />}
      {data && outages.length === 0 && (
        <EmptyState icon="check" title="No live outages right now">When City Power reports one, the affected suburbs will show up here.</EmptyState>
      )}

      {data && outages.length > 0 && (
        <div className="map-layout">
          <div className="card map-card">
            <Suspense fallback={<MapFallback height={560} />}>
              <MapView points={points} selected={selected} onPick={(g) => setSelected((cur) => (cur === g ? null : g))} height={560} label="Map of suburbs with power outages" />
            </Suspense>
            <div className="map-foot">
              <Legend items={[['live', 'Power out'], ['partial', 'Partly restored'], ['good', 'Power back'], ['live', 'Likely area (not confirmed)', true]]} />
              <span className="small faint">Map data © OpenStreetMap contributors</span>
            </div>
          </div>

          <aside className="map-list" aria-label="Live outages">
            <div className="small muted" style={{ marginBottom: 8 }}>{plural(outages.length, 'live outage')}{mapped < outages.length ? ` · ${outages.length - mapped} could not be placed` : ''}</div>
            <ul className="rows card">
              {outages.map((o) => (
                <li key={o.id} className={selected === o.id ? 'is-selected' : ''}>
                  <button type="button" className="map-item" onClick={() => setSelected((cur) => (cur === o.id ? null : o.id))} aria-pressed={selected === o.id}>
                    <span className="t">{nice(o.title)}</span>
                    <span className="small muted">{o.latest ? o.latest : 'Waiting for the next update'}</span>
                    <span className="row small" style={{ gap: 8 }}>
                      <StatusBadge status={o.status} />
                      <span className="faint">{timeAgo(o.lastUpdateAt)}</span>
                      {o.places.length === 0 && <span className="faint">not on the map</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {chosen && (
              <Link to={`/outages/${chosen.id}`} className="btn" style={{ marginTop: 12 }}>Open this outage <Icon name="arrow" /></Link>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
