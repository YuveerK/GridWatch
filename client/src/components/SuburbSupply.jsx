import { lazy, Suspense, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { nice, plural, typeLabel, useApi } from '../lib/api.js';
import { useMyArea } from '../lib/hooks.js';
import { Legend, MapFallback } from '../views/MapPage.jsx';
import Icon from './Icon.jsx';
import SearchBox from './SearchBox.jsx';
import { SectionHead } from './ui.jsx';

const MapView = lazy(() => import('./MapView.jsx'));
const LAYERS = { outages: true, equipment: true };
const WATER = '#2f7d9a';

/** Search a suburb, outline it, and animate the power and water assets posts have tied to it. */
export default function SuburbSupply() {
  const { area } = useMyArea();
  const [picked, setPicked] = useState(null);
  const [replay, setReplay] = useState(0);
  const suburb = picked === false ? null : picked ?? (area ? { id: area.id, name: area.name } : null);
  const { data, error, loading } = useApi(suburb ? `/v1/localities/${suburb.id}/supply` : null);
  const supply = data?.locality?.id === suburb?.id ? data : null;
  const origin = supply?.locality?.lon != null && supply?.locality?.lat != null ? [supply.locality.lon, supply.locality.lat] : null;
  const points = useMemo(() => (origin ? [{
    id: supply.locality.id, name: nice(supply.locality.name), lat: supply.locality.lat, lon: supply.locality.lon,
    boundary: supply.locality.boundary, tone: 'plan', groups: [], note: 'Selected suburb',
  }] : []), [supply, origin]);
  const hubs = useMemo(() => (supply?.assets ?? []).map((asset) => ({
    id: asset.id, name: nice(asset.name), type: asset.type, service: asset.service, lon: asset.lon, lat: asset.lat, live: asset.live, served: asset.evidence,
  })), [supply]);
  const flow = useMemo(() => (origin && hubs.length ? {
    key: `${supply.locality.id}:${replay}`,
    origin,
    edges: hubs.map((hub) => ({ from: origin, to: [hub.lon, hub.lat], kind: 'equipment', live: hub.live, color: hub.service === 'WATER' ? WATER : undefined })),
  } : null), [origin, hubs, supply, replay]);
  const power = hubs.filter((hub) => hub.service !== 'WATER');
  const water = hubs.filter((hub) => hub.service === 'WATER');

  return (
    <section className="section suburb-supply" aria-labelledby="supply-h">
      <SectionHead id="supply-h" title="What supplies a suburb" sub="Search a suburb. Its boundary is highlighted, and lines run out to the power and water assets linked to it in public posts." />
      <div className="suburb-supply-search">
        <SearchBox suburbsOnly placeholder="Search a suburb, e.g. Fourways" onPickSuburb={(item) => setPicked({ id: item.id, name: item.name })} />
        {suburb && <button type="button" className="btn small ghost" onClick={() => setPicked(false)}>Clear</button>}
      </div>
      {!suburb && <p className="muted">Choose a suburb to see the assets that supply it. A saved area is used until you search for another.</p>}
      {suburb && error && !supply && <p className="muted">That suburb could not be loaded.</p>}
      {suburb && loading && !supply && <div className="card map-card"><MapFallback height={420} /></div>}
      {supply && !origin && <p className="muted">{nice(supply.locality.name)} has no map position yet, so its boundary cannot be drawn.</p>}
      {supply && origin && (
        <div className="card map-card">
          <Suspense fallback={<MapFallback height={420} />}>
            <MapView points={points} hubs={hubs} flow={flow} layers={LAYERS} height={420} label={`Map of infrastructure connected to ${supply.locality.name}`} />
          </Suspense>
          <div className="map-foot">
            <Legend items={[['plan', 'Suburb boundary'], ['plan', 'Electricity', 'diamond'], ['live', 'Water', 'diamond']]} />
            <span className="row" style={{ gap: 12 }}>
              {hubs.length > 0 && <button type="button" className="btn small ghost" onClick={() => setReplay((n) => n + 1)}><Icon name="refresh" /> Replay</button>}
              <span className="small faint">Map © OpenStreetMap contributors</span>
            </span>
          </div>
        </div>
      )}
      {supply && (
        <div className="suburb-supply-lists">
          <AssetList title="Electricity" icon="bolt" assets={power} empty={`No electricity equipment is linked to ${nice(supply.locality.name)} yet.`} />
          <AssetList title="Water" icon="drop" assets={water} empty={`No water assets are linked to ${nice(supply.locality.name)} yet.`} />
        </div>
      )}
    </section>
  );
}

function AssetList({ title, icon, assets, empty }) {
  return (
    <div>
      <h3 className="panel-h"><Icon name={icon} /> {title}</h3>
      {assets.length === 0 ? <p className="muted">{empty}</p> : (
        <ul className="repeat">
          {assets.map((asset) => (
            <li key={asset.id}>
              <div className="repeat-main">
                <Link to={`/network/${asset.id}`} className="t">{asset.name}</Link>
                <span className="small muted">{typeLabel(asset.type)} · {plural(asset.served, 'post')}</span>
              </div>
              {asset.live && <span className="badge tone-live">Live</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
