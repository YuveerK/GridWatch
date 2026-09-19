import { lazy, Suspense, useMemo } from 'react';
import { nice, plural, useApi } from '../lib/api.js';
import { Legend, MapFallback } from '../views/MapPage.jsx';
import { SectionHead } from './ui.jsx';

const MapView = lazy(() => import('./MapView.jsx'));

/** Approximate reach of a piece of equipment: the suburbs City Power's posts have tied to it (or to anything downstream of it). */
export default function NodeReach({ id }) {
  const { data } = useApi(`/v1/map/node/${id}`);
  const points = useMemo(() => {
    const max = Math.max(1, ...(data?.places ?? []).map((p) => p.evidence));
    return (data?.places ?? []).map((p) => ({
      id: p.id,
      name: nice(p.name),
      lat: p.lat,
      lon: p.lon,
      tone: p.live ? 'live' : 'plan',
      r: 5 + Math.round((p.evidence / max) * 7),
      note: `${p.live ? 'Power out now · ' : ''}named in ${plural(p.evidence, 'post')} about this equipment`,
    }));
  }, [data]);

  if (!data || points.length === 0) return null;
  return (
    <section className="section" aria-labelledby="reach-h">
      <SectionHead id="reach-h" title="Where it reaches" sub="Suburbs named in posts about this equipment. Bigger dots were named more often. Positions are suburb centres, not cable routes." />
      <div className="card map-card">
        <Suspense fallback={<MapFallback height={360} />}>
          <MapView points={points} height={360} cooperative label={`Map of suburbs served by ${data.node.name}`} />
        </Suspense>
        <div className="map-foot">
          <Legend items={[['plan', 'Named in past outages'], ['live', 'Power out now']]} />
          <span className="small faint">
            {data.unplaced > 0 ? `${plural(data.unplaced, 'suburb')} could not be placed · ` : ''}Map data © OpenStreetMap contributors
          </span>
        </div>
      </div>
    </section>
  );
}
