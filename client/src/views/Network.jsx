import { lazy, Suspense, useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import Icon from '../components/Icon.jsx';
import FeedFlow from '../components/FeedFlow.jsx';
import NetworkEvidence from '../components/NetworkEvidence.jsx';
import SearchBox from '../components/SearchBox.jsx';
import { assetSymbol, hasPosition, networkParams, positionLabel, RELATION, SYMBOLS } from '../lib/network.js';
const MapView = lazy(() => import('../components/MapView.jsx'));
const MAP_LAYERS = { outages: true, equipment: true };
import { CardSkeleton, EmptyState, ErrorState, SectionHead, ServiceIdentity, Skeleton } from '../components/ui.jsx';
import { nice, plural, prettySdc, typeLabel, useApi } from '../lib/api.js';
import { useDocumentTitle } from '../lib/hooks.js';
import { useMunicipality, withMunicipality } from '../lib/municipality.jsx';
import { inService } from '../lib/service.jsx';

const POWER_TYPES = ['', 'SDC', 'KIOSK', 'OTHER', 'SUBSTATION', 'SWITCHING_STATION', 'DISTRIBUTOR', 'MINI_SUBSTATION', 'FEEDER', 'TRANSFORMER', 'CABLE'];
const WATER_TYPES = ['', 'RESERVOIR', 'WATER_TOWER', 'PUMP_STATION', 'BOOSTER_STATION', 'TREATMENT_WORKS', 'WATER_SYSTEM', 'DIRECT_FEED', 'BULK_CONNECTION', 'WATER_PIPELINE', 'PRV', 'BULK_METER', 'WATER_OTHER'];
const PATHS = {
  ELECTRICITY: [
    ['bolt', 'Substation', 'A site that steps voltage down and sends electricity onto local circuits.'],
    ['network', 'Distributor or feeder', 'A circuit carries power towards a group of streets.'],
    ['home', 'Your area', 'A fault upstream can affect several suburbs at once.'],
  ],
  WATER: [
    ['drop', 'Water source', 'Bulk supply or treatment works introduces water to the network.'],
    ['network', 'Storage and pumping', 'Reservoirs, towers and pump stations help manage supply and pressure.'],
    ['arrow', 'Supply route', 'Pipelines and direct feeds carry water towards neighbourhoods.'],
    ['home', 'Your area', 'An upstream interruption can affect more than one suburb.'],
  ],
};

export function Explainer({ service = 'ELECTRICITY' }) {
  return <div className="card card-pad network-explainer">
    <div className="flow">{PATHS[service].map(([icon, title, description], index) =>
      <div key={title} className="step"><span className="network-step-icon"><Icon name={icon} /></span><span className="n">STEP {index + 1}</span><b>{title}</b><span className="small muted">{description}</span></div>
    )}</div>
    <p className="small muted network-caveat">This is a guide to how the service works. The explorer combines official documents, curated records and associations from public notices. Inspect each connection for its sources. Service centres coordinate repairs separately from supply routes; missing links mean the upstream or downstream route is unknown.</p>
  </div>;
}

export default function Network() {
  useDocumentTitle('Network explorer');
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { param, name, service } = useMunicipality();
  const assetId = params.get('asset');
  const suburbId = params.get('suburb');
  const view = ['connections', 'map', 'list'].includes(params.get('view')) ? params.get('view') : 'connections';
  const types = service === 'WATER' ? WATER_TYPES : POWER_TYPES;
  const type = types.includes(params.get('type')) ? params.get('type') : '';
  const q = params.get('q') ?? '';
  const offset = Math.min(1000000, Math.max(0, Number(params.get('offset')) || 0));
  const go = (changes, replace = false) => setParams(networkParams(params, changes), { replace });
  const select = (id) => go({ asset: id, suburb: null });
  const selectSuburb = (id) => go({ suburb: id, asset: null });
  const detail = useApi(assetId ? `/v1/infrastructure/${assetId}` : null, { keepPrevious: false });
  const node = detail.data?.serviceType === service ? detail.data : null;
  const supply = useApi(suburbId ? `/v1/localities/${suburbId}/supply` : null, { keepPrevious: false });
  const query = new URLSearchParams({ limit: 30, offset });
  if (type) query.set('type', type);
  if (q.trim()) query.set('q', q.trim());
  const list = useApi(withMunicipality(`/v1/infrastructure?${query}`, param), { keepPrevious: false });
  const hubs = useApi(view === 'map' && !assetId && !suburbId ? withMunicipality('/v1/map/infrastructure', param) : null, { keepPrevious: false });
  const reach = useApi(view === 'map' && node ? `/v1/map/node/${node.id}` : null, { keepPrevious: false });
  const assets = (supply.data?.assets ?? []).filter((a) => a.service === service);
  const mapHubs = useMemo(() => {
    if (node && reach.data) return [...(reach.data.origin ? [{ ...node, service, lon: reach.data.origin[0], lat: reach.data.origin[1], derived: reach.data.derived, served: reach.data.total }] : []), ...[...(reach.data.parents ?? []), ...reach.data.children].filter((h, i, all) => all.findIndex((x) => x.id === h.id) === i)];
    if (suburbId) return (supply.data?.assets ?? []).filter((a) => a.service === service && hasPosition(a));
    return (hubs.data?.data ?? []).filter((h) => (!type || h.type === type) && (!q || h.name.toLowerCase().includes(q.toLowerCase())));
  }, [node, reach.data, suburbId, supply.data, service, hubs.data, type, q]);
  const points = useMemo(() => node ? (reach.data?.places ?? []).map((p) => ({ ...p, tone: p.state === 'out' ? 'live' : 'plan', groups: [], note: `${p.state === 'out' ? 'An active incident affects this suburb.' : p.state === 'restored' ? 'All currently tracked incidents mark this suburb restored.' : 'No current suburb status reported.'} Selected network: ${p.linkedState === 'out' ? 'interruption reported' : p.linkedState === 'restored' ? 'restoration reported' : 'no active report'}.` })) : supply.data && hasPosition(supply.data.locality) ? [{ ...supply.data.locality, tone: 'plan', groups: [], note: 'Selected suburb. Connections show recorded associations.' }] : [], [node, reach.data, supply.data]);
  const flow = useMemo(() => {
    if (node && reach.data?.origin) return { key: node.id, origin: reach.data.origin, edges: reach.data.edges, animated: false };
    if (suburbId && supply.data && hasPosition(supply.data.locality)) {
      const origin = [supply.data.locality.lon, supply.data.locality.lat];
      return { key: suburbId, origin, animated: false, edges: mapHubs.map((h) => ({ from: [h.lon, h.lat], to: origin, kind: h.relationType === 'SERVES' ? 'equipment' : 'association', relationship: h.relationType, live: false })) };
    }
    return null;
  }, [node, reach.data, suburbId, supply.data, mapHubs]);
  const mapError = reach.error || hubs.error;
  const waiting = (assetId && !detail.data && !detail.error) || (suburbId && !supply.data && !supply.error);
  const selectedName = node?.name ?? supply.data?.locality.name;
  return <div className="container page network-page">
    <header className="page-head network-head"><ServiceIdentity service={service} /><h1>{service === 'WATER' ? 'Water network explorer' : 'Electricity network explorer'}</h1><p>Find a suburb or asset, follow its connections, and inspect the sources{ name ? ` for ${name}` : ''}.</p></header>
    <SearchBox placeholder="Find a suburb or network asset" onPickItem={(item) => item.kind === 'equipment' ? select(item.id) : item.kind === 'suburb' ? selectSuburb(item.id) : navigate(inService(`/outages/${item.id}`, service))} />
    <nav className="seg network-tabs" aria-label="Network view">{['connections', 'map', 'list'].map((v) => <button key={v} aria-pressed={view === v} onClick={() => go({ view: v })}>{v[0].toUpperCase() + v.slice(1)}</button>)}</nav>
    {(assetId || suburbId) && <div className="card card-pad network-selection"><div><span className="eyebrow">Current selection</span><h2>{nice(selectedName) || (waiting ? 'Loading selection...' : 'Selection unavailable')}</h2>{node && <p className="small muted">{typeLabel(node.type)} | {node.live ? 'Live incident linked to this asset' : 'No linked live incident reported'}</p>}</div><button className="btn small" onClick={() => go({ asset: null, suburb: null })}>Clear selection</button></div>}
    {detail.data && !node && <p role="status">This asset belongs to another service. <Link to={inService(`/network?asset=${assetId}&view=${view}`, detail.data.serviceType)}>Open its service</Link> or clear the selection.</p>}
    {(detail.error || supply.error) && <ErrorState error={detail.error || supply.error} />}
    {waiting && <Skeleton h={220} />}
    {view === 'connections' && <>
      {node && <FeedFlow key={node.id} node={node} onSelect={select} onSuburb={selectSuburb} />}
      {supply.data && <section className="section"><h3>Assets linked to {nice(supply.data.locality.name)} ({assets.length})</h3><p className="small muted">Serves indicates a recorded service relationship. Associations from notices do not establish the supply route. Select an asset to inspect all its upstream and downstream connections.</p><div className="network-assets">{assets.map((a) => <button key={a.id} className="card network-asset" onClick={() => select(a.id)}><span className="asset-symbol">{assetSymbol(a.type)}</span><span className="network-asset-main"><strong>{nice(a.name)}</strong><span>{typeLabel(a.type)} | {RELATION[a.relationType]} | {positionLabel(a)}</span></span>{a.live && <span className="badge tone-live">Live incident</span>}</button>)}</div>{!assets.length && <EmptyState title="No linked assets recorded">The upstream supply for this suburb is unknown.</EmptyState>}</section>}
      {!assetId && !suburbId && <EmptyState icon="network" title="Start with a suburb or asset">Use the search above, or choose an asset in Map or List. Each selection reveals all recorded neighbouring connections.</EmptyState>}
    </>}
    {view === 'map' && <section className="section"><p className="small muted">Asset letters identify type. Red marks a linked live incident; it does not measure source confidence. Dashed marker rings indicate estimated positions. Lines show relationships, not pipe or cable routes. Assets without coordinates remain available in Connections and List.</p>
      {mapError ? <ErrorState error={mapError} /> : (node && !reach.data) || (!assetId && !suburbId && !hubs.data) ? <Skeleton h={440} /> : <div className="card map-card"><Suspense fallback={<Skeleton h={440} />}><MapView points={points} hubs={mapHubs} flow={flow} layers={MAP_LAYERS} selectedHub={node?.id} height={480} onPickHub={select} onPickSuburb={selectSuburb} label="Network assets and related suburbs" /></Suspense></div>}
      <p className="small muted">{Object.entries(SYMBOLS).map(([symbol, label]) => `${symbol}: ${label}`).join(' | ')}</p>
      {reach.data && <p className="small muted">{reach.data.total} associated suburbs (up to {reach.data.coverageDepth} connection levels); {reach.data.unplaced} have no map position. {reach.data.unmappedConnections} asset connections cannot be mapped. Suburb colours show overall status; select a suburb marker for the selected network's status.</p>}
      {!mapError && !mapHubs.some(hasPosition) && !points.length && <p className="muted">No map positions are available for this selection.</p>}
    </section>}
    {view === 'list' && <section className="section"><div className="toolbar network-toolbar"><label>Asset type<select className="field" value={type || ''} onChange={(e) => go({ type: e.target.value, offset: null })}>{types.map((t) => <option key={t || 'all'} value={t}>{t ? typeLabel(t) : 'All assets'}</option>)}</select></label><label>Filter by name<input className="field" type="search" value={q} onChange={(e) => go({ q: e.target.value, offset: null }, true)} /></label></div>
      {list.error ? <ErrorState error={list.error} /> : !list.data ? <Skeleton h={220} /> : <><p className="small muted">{list.data.total} matching assets, including those with unknown positions.</p><div className="network-assets">{list.data.data.map((n) => <button key={n.id} className={`card network-asset ${assetId === n.id ? 'is-selected' : ''}`} aria-pressed={assetId === n.id} onClick={() => select(n.id)}><span className="asset-symbol">{assetSymbol(n.type)}</span><span className="network-asset-main"><strong>{nice(n.name)}</strong><span>{typeLabel(n.type)}</span></span>{n.live && <span className="badge tone-live">Live incident linked</span>}</button>)}</div>{!list.data.total && <EmptyState title="No matching assets">Try another type or name.</EmptyState>}<div className="row between network-pagination"><button className="btn" disabled={!offset} onClick={() => go({ offset: Math.max(0, offset - 30) })}>Previous</button><span className="small">{list.data.data.length ? `${offset + 1}-${offset + list.data.data.length}` : '0'} of {list.data.total}</span><button className="btn" disabled={!list.data.hasMore} onClick={() => go({ offset: offset + 30 })}>Next</button></div></>}
    </section>}
    {node && view !== 'connections' && <><Link className="btn" to={inService(`/network/${node.id}`, service)}>Asset details and incident history</Link><NetworkEvidence key={node.id} nodeId={node.id} /></>}
    <details className="network-guide"><summary>How to read the network</summary><Explainer service={service} /></details>
  </div>;
}
