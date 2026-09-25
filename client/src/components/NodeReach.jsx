import { lazy, Suspense, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { nice, plural, useApi } from '../lib/api.js';
import { Legend, MapFallback } from '../views/MapPage.jsx';
import Icon from './Icon.jsx';
import { SectionHead } from './ui.jsx';

const MapView = lazy(() => import('./MapView.jsx'));
const LAYERS = { outages: true, equipment: false };

/** Where a piece of equipment reaches: its suburbs, with the power flowing out to them. */
export default function NodeReach({ id, service = 'ELECTRICITY' }) {
  const water = service === 'WATER';
  const { data } = useApi(`/v1/map/node/${id}`);
  const [replay, setReplay] = useState(0);
  const points = useMemo(
    () => (data?.places ?? []).map((p) => ({ id: p.id, name: nice(p.name), lat: p.lat, lon: p.lon, boundary: p.boundary ?? null, tone: p.state === 'out' ? 'live' : 'plan', groups: [], note: `${p.state === 'out' ? (water ? 'Water interrupted now · ' : 'Power out now · ') : p.state === 'restored' ? (water ? 'Water restored · ' : 'Power restored · ') : ''}named in ${plural(p.evidence, 'post')} about this asset` })),
    [data, water],
  );
  const flow = useMemo(() => (data?.origin && data.edges?.length ? { key: `${id}:${replay}`, origin: data.origin, edges: data.edges } : null), [data, id, replay]);

  if (!data || points.length === 0) return null;
  return (
    <section className="section" aria-labelledby="reach-h">
      <SectionHead
        id="reach-h"
        title="Where it reaches"
        sub={water ? 'Suburbs named in posts about this asset. Connections and positions are approximate.' : 'Suburbs named in posts about this equipment. The lines show inferred connections; positions are approximate.'}
        action={<Link to={`/map?hub=${id}`} className="link">Explore on the map <Icon name="arrow" /></Link>}
      />
      <div className="card map-card">
        <Suspense fallback={<MapFallback height={380} />}>
          <MapView points={points} flow={flow} layers={LAYERS} height={380} cooperative label={`Map of suburbs served by ${data.node.name}`} />
        </Suspense>
        <div className="map-foot">
          <Legend items={[['plan', 'Named in past interruptions'], ['live', water ? 'Water interrupted now' : 'Power out now']]} />
          <span className="row" style={{ gap: 12 }}>
            <button type="button" className="btn small ghost" onClick={() => setReplay((n) => n + 1)}><Icon name="refresh" /> Replay</button>
            <span className="small faint">{data.unplaced > 0 ? `${plural(data.unplaced, 'suburb')} could not be placed · ` : ''}Map © OpenStreetMap contributors</span>
          </span>
        </div>
      </div>
    </section>
  );
}
