import { lazy, Suspense, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { nice, plural, useApi } from '../lib/api.js';
import { inService } from '../lib/service.jsx';
import { Legend, MapFallback } from '../views/MapPage.jsx';
import Icon from './Icon.jsx';
import { SectionHead } from './ui.jsx';

const MapView = lazy(() => import('./MapView.jsx'));
const LAYERS = { outages: true, equipment: true };

/** Where a piece of equipment reaches: its suburbs, with the power flowing out to them. */
export default function NodeReach({ id, service = 'ELECTRICITY' }) {
  const water = service === 'WATER';
  const { data } = useApi(`/v1/map/node/${id}`, { keepPrevious: false });
  const points = useMemo(
    () => (data?.places ?? []).map((p) => ({ id: p.id, name: nice(p.name), lat: p.lat, lon: p.lon, boundary: p.boundary ?? null, tone: p.state === 'out' ? 'live' : 'plan', groups: [], note: `${p.state === 'out' ? 'An active incident affects this suburb.' : p.state === 'restored' ? 'All currently tracked incidents mark this suburb restored.' : 'No current status reported.'} Selected network: ${p.linkedState === 'out' ? 'interruption reported' : p.linkedState === 'restored' ? 'restoration reported' : 'no active report'}.` })),
    [data, water],
  );
  const flow = useMemo(() => (data?.origin && data.edges?.length ? { key: id, origin: data.origin, edges: data.edges, animated: false } : null), [data, id]);

  const hubs = useMemo(() => data?.origin ? [{ ...data.node, service, lon: data.origin[0], lat: data.origin[1], derived: data.derived, served: data.total }, ...[...(data.parents ?? []), ...data.children].filter((h, i, all) => all.findIndex((c) => c.id === h.id) === i)] : data?.children ?? [], [data, service]);
  if (!data || (!points.length && !hubs.length)) return null;
  return (
    <section className="section" aria-labelledby="reach-h">
      <SectionHead
        id="reach-h"
        title="Where it reaches"
        sub={water ? 'Areas named in incidents involving this asset or its connected equipment. Connections and positions are approximate.' : 'Areas named in incidents involving this equipment or its connected network. Lines show reported connections; positions are approximate.'}
        action={<Link to={inService(`/network?asset=${id}&view=map`, service)} className="link">Explore on the map <Icon name="arrow" /></Link>}
      />
      <div className="card map-card">
        <Suspense fallback={<MapFallback height={380} />}>
          <MapView points={points} hubs={hubs} selectedHub={id} flow={flow} layers={LAYERS} height={380} cooperative label={`Map of areas associated with ${data.node.name}`} />
        </Suspense>
        <div className="map-foot">
          <Legend items={[['plan', 'Associated suburb'], ['live', water ? 'Water interrupted now' : 'Power out now']]} />
          <span className="row" style={{ gap: 12 }}>
            <span className="small faint">{data.unplaced > 0 ? `${plural(data.unplaced, 'suburb')} could not be placed · ` : ''}Map © OpenStreetMap contributors</span>
          </span>
        </div>
      </div>
    </section>
  );
}
