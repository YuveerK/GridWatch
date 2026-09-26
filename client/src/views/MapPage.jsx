import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import Icon from '../components/Icon.jsx';
import SearchBox from '../components/SearchBox.jsx';
import { EmptyState, ErrorState, ServiceIdentity, Skeleton, StatusBadge } from '../components/ui.jsx';
import { nice, placeTone, plural, timeAgo, typeLabel, useApi } from '../lib/api.js';
import { useDocumentTitle } from '../lib/hooks.js';
import { estimateCoverage } from '../lib/coverage.js';
import { useMunicipality, useUtility, withMunicipality } from '../lib/municipality.jsx';

const MapView = lazy(() => import('../components/MapView.jsx'));

export function MapFallback({ height = 460 }) {
  return <div className="map map-loading" style={{ height }}><Skeleton h={height} r={16} /></div>;
}

export function Legend({ items }) {
  return (
    <ul className="legend" aria-label="Map key">
      {items.map(([tone, text, shape]) => (
        <li key={text}><i className={`key-dot tone-${tone}${shape ? ` ${shape}` : ''}`} />{text}</li>
      ))}
    </ul>
  );
}

const ORDER = { live: 0, partial: 1, good: 2 };
const worst = (a, b) => ((ORDER[a] ?? 9) <= (ORDER[b] ?? 9) ? a : b);
const boundsOf = (pts) => {
  if (!pts.length) return null;
  const xs = pts.map((p) => p.lon);
  const ys = pts.map((p) => p.lat);
  return [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]];
};
const POWER_HUB_KINDS = [['', 'All'], ['SDC', 'Service centres'], ['SUBSTATION', 'Substations'], ['SWITCHING_STATION', 'Switching stations'], ['DISTRIBUTOR', 'Distributors']];
const WATER_HUB_KINDS = [['', 'All'], ['RESERVOIR', 'Reservoirs'], ['WATER_TOWER', 'Towers'], ['PUMP_STATION', 'Pump stations'], ['PRV', 'Pressure valves'], ['WATER_SYSTEM', 'Systems'], ['DIRECT_FEED', 'Direct feeds'], ['TREATMENT_WORKS', 'Treatment works'], ['WATER_OTHER', 'Depots']];

/**
 * Two views of the same map:
 *   Outages         where power is out right now (dots, grouped into bubbles when zoomed out)
 *   Infrastructure  the utilities' equipment; click one and lines animate out to the areas it feeds
 */
export default function MapPage() {
  useDocumentTitle('Map');
  const [params, setParams] = useSearchParams();
  const hubId = params.get('hub');
  const mode = hubId || params.get('view') === 'infrastructure' ? 'infrastructure' : 'outages';
  const sel = mode === 'infrastructure' ? null : params.get('outage') ? { type: 'outage', id: params.get('outage') } : params.get('suburb') ? { type: 'suburb', id: params.get('suburb') } : null;
  const [focus, setFocus] = useState(null);
  const [replay, setReplay] = useState(0);
  const [kind, setKind] = useState('');
  const [extra, setExtra] = useState(null); // a searched suburb that has no live outage

  const { param: muniParam, service } = useMunicipality();
  const water = service === 'WATER';
  const hubKinds = water ? WATER_HUB_KINDS : POWER_HUB_KINDS;
  const { utility, single } = useUtility();
  const live = useApi(withMunicipality('/v1/map', muniParam), { refreshMs: 60_000 });
  const hubsApi = useApi(withMunicipality('/v1/map/infrastructure', muniParam), { refreshMs: 120_000 });
  const hubData = useApi(hubId ? `/v1/map/node/${hubId}` : null);
  const node = hubData.data?.node?.id === hubId ? hubData.data : null;
  const isSdc = node?.node.type === 'SDC';

  const outages = useMemo(() => live.data?.data ?? [], [live.data]);
  const allHubs = useMemo(() => hubsApi.data?.data ?? [], [hubsApi.data]);

  // one entry per suburb, with the worst status among the live outages that touch it
  const suburbs = useMemo(() => {
    const m = new Map();
    for (const o of outages) {
      for (const p of o.places) {
        const tone = placeTone(o, p.restored);
        const cur = m.get(p.id);
        if (!cur) m.set(p.id, { id: p.id, name: nice(p.name), lat: p.lat, lon: p.lon, boundary: p.boundary ?? null, tone, groups: [o.id], inferred: p.inferred, outages: [o] });
        else {
          cur.tone = worst(cur.tone, tone);
          cur.groups.push(o.id);
          cur.outages.push(o);
          cur.inferred = cur.inferred && p.inferred;
        }
      }
    }
    return m;
  }, [outages]);

  const selectedOutage = sel?.type === 'outage' ? outages.find((o) => o.id === sel.id) : null;

  // the suburbs the animation actually reaches (very distant, weakly supported ones are left out of it)
  const servedIds = useMemo(() => {
    if (!node) return new Set();
    const drawn = node.node.type === 'SDC' ? [] : node.edges.filter((e) => e.kind === 'suburb').map((e) => e.toId);
    return new Set(drawn.length ? drawn : node.places.map((p) => p.id));
  }, [node]);

  const points = useMemo(() => {
    if (mode === 'infrastructure') {
      // only the areas the selected equipment feeds
      return (node?.places ?? []).filter((p) => servedIds.has(p.id)).map((p) => ({ id: p.id, name: nice(p.name), lat: p.lat, lon: p.lon, boundary: p.boundary ?? null, tone: p.live ? 'live' : 'plan', groups: [], note: `${node.node.type === 'SDC' ? 'Service area of' : 'Associated with'} ${nice(node.node.name)}${p.live ? ' · outage now' : ''}` }));
    }
    const pts = [...suburbs.values()].map((s) => {
      const dim = sel ? (sel.type === 'outage' ? !s.groups.includes(sel.id) : s.id !== sel.id) : false;
      return { id: s.id, name: s.name, lat: s.lat, lon: s.lon, boundary: s.boundary, tone: s.tone, groups: s.groups, inferred: s.inferred, dim, note: `${s.outages.map((o) => nice(o.title)).slice(0, 2).join(' · ')}${s.outages.length > 2 ? ` · +${s.outages.length - 2} more` : ''}` };
    });
    if (extra && !suburbs.has(extra.id)) pts.push({ id: extra.id, name: extra.name, lat: extra.lat, lon: extra.lon, tone: 'good', groups: [], note: 'No live outage reported' });
    return pts;
  }, [mode, suburbs, sel, node, servedIds, extra]);

  // in the Infrastructure view: every piece of equipment, or (once one is picked) just it and its circuits
  const hubs = useMemo(() => {
    if (mode !== 'infrastructure') return [];
    if (!hubId) return allHubs.filter((h) => !kind || h.type === kind);
    const keep = new Set([hubId, ...(node?.children ?? []).filter((c) => node.node.type === 'SDC' || c.near).map((c) => c.id)]);
    const selected = allHubs.filter((h) => keep.has(h.id));
    if (node?.origin && !selected.some((h) => h.id === hubId)) selected.push({ ...node.node, lon: node.origin[0], lat: node.origin[1], served: node.total, live: node.places.some((p) => p.live) });
    const shaped = (node?.places ?? []).some((p) => servedIds.has(p.id) && p.boundary);
    return shaped ? selected.map(({ boundary, ...hub }) => hub) : selected;
  }, [mode, allHubs, hubId, node, kind, servedIds]);

  const servedPlaces = useMemo(() => (node?.places ?? []).filter((p) => servedIds.has(p.id)), [node, servedIds]);
  const hasShapes = servedPlaces.some((p) => p.boundary);
  const coverage = useMemo(() => {
    if (mode !== 'infrastructure' || !node || hasShapes) return null;
    return estimateCoverage(servedPlaces);
  }, [mode, node, servedPlaces, hasShapes]);
  const flow = useMemo(() => (mode === 'infrastructure' && !isSdc && node?.origin && node.edges?.length ? { key: `${node.node.id}:${replay}`, origin: node.origin, edges: node.edges, noFit: Boolean(coverage) || hasShapes } : null), [mode, node, replay, isSdc, coverage, hasShapes]);
  const layers = useMemo(() => ({ outages: true, equipment: mode === 'infrastructure' }), [mode]);

  // ── moving around
  const zoomTo = (pts) => {
    const b = boundsOf(pts);
    if (b) setFocus({ key: Math.random(), bounds: pts.length === 1 ? [[b[0][0] - 0.01, b[0][1] - 0.008], [b[1][0] + 0.01, b[1][1] + 0.008]] : b });
  };
  const go = (next) => {
    const p = new URLSearchParams(next);
    if (params.get('service')) p.set('service', params.get('service')); // the address keeps saying which service this is
    setParams(p, { replace: true });
  };
  const focused = useRef(null);

  // switching municipality re-centres the map on what's actually shown, so picking "City of Tshwane" doesn't
  // leave you staring at an empty Johannesburg-centred view with nothing visible.
  useEffect(() => { setKind(''); }, [service]);
  const prevMuni = useRef(muniParam);
  useEffect(() => {
    if (prevMuni.current === muniParam) return;
    const pts = mode === 'infrastructure' ? allHubs : [...suburbs.values()];
    if (!pts.length) return; // data for the new scope may still be loading; try again once it arrives
    prevMuni.current = muniParam;
    zoomTo(pts);
  }, [muniParam, mode, allHubs, suburbs]);

  const setMode = (m) => {
    setExtra(null);
    focused.current = m === 'infrastructure' ? 'view:all' : 'all';
    go(m === 'infrastructure' ? { view: 'infrastructure' } : {});
    zoomTo(m === 'infrastructure' ? allHubs : [...suburbs.values()]);
  };
  const pickOutage = (id) => {
    focused.current = `outage:${id}`;
    go({ outage: id });
    setExtra(null);
    const o = outages.find((x) => x.id === id);
    if (o) zoomTo(o.places);
  };
  const pickSuburb = (id) => {
    focused.current = `suburb:${id}`;
    setExtra(null);
    go({ suburb: id });
    const s = suburbs.get(id);
    if (s) zoomTo([s]);
  };
  const pickHub = (id) => {
    go({ hub: id });
    setExtra(null);
    setReplay((n) => n + 1);
  };
  const reset = () => {
    go(mode === 'infrastructure' ? { view: 'infrastructure' } : {});
    setExtra(null);
    zoomTo(mode === 'infrastructure' ? allHubs : [...suburbs.values()]);
  };
  const onSearch = (it) => {
    if (it.kind === 'equipment') return pickHub(it.id);
    if (it.kind === 'outage') return outages.some((o) => o.id === it.id) ? pickOutage(it.id) : window.location.assign(`/outages/${it.id}`);
    if (suburbs.has(it.id)) return pickSuburb(it.id);
    if (it.lat != null) {
      const s = { id: it.id, name: it.title, lat: it.lat, lon: it.lon };
      setExtra(s);
      go({ suburb: it.id });
      return zoomTo([s]);
    }
    return go({ suburb: it.id });
  };

  // a link like /map?outage=… or /map?view=infrastructure opens already framed: zoom to it once the data is here
  useEffect(() => {
    if (!live.data) return;
    const key = mode === 'infrastructure' ? `view:${hubId ?? 'all'}` : sel ? `${sel.type}:${sel.id}` : 'all';
    if (focused.current === key) return;
    if (mode === 'infrastructure') {
      if (hubId) {
        if (!node) return;
        focused.current = key;
        if (hasShapes) zoomTo(servedPlaces);
        return;
      }
      if (!allHubs.length) return;
      focused.current = key;
      zoomTo(allHubs);
    } else if (sel?.type === 'outage' && selectedOutage) {
      focused.current = key;
      zoomTo(selectedOutage.places);
    } else if (sel?.type === 'suburb' && suburbs.has(sel.id)) {
      focused.current = key;
      zoomTo([suburbs.get(sel.id)]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.data, mode, hubId, node, hasShapes, servedPlaces, allHubs.length, sel?.type, sel?.id, selectedOutage, suburbs]);

  const error = live.error && !live.data;
  const mapped = outages.filter((o) => o.places.length).length;
  const suburbSel = sel?.type === 'suburb' ? suburbs.get(sel.id) ?? (extra?.id === sel.id ? { ...extra, outages: [], tone: 'good' } : null) : null;
  const hubList = useMemo(() => [...allHubs].filter((h) => !kind || h.type === kind).sort((a, b) => Number(b.live) - Number(a.live) || (b.served ?? 0) - (a.served ?? 0) || String(a.name).localeCompare(String(b.name))).slice(0, 60), [allHubs, kind]);

  const back = <button type="button" className="link back" onClick={reset}><Icon name="arrow" className="flip" /> {mode === 'infrastructure' ? (water ? 'All assets' : 'All equipment') : water ? 'All incidents' : 'All outages'}</button>;

  return (
    <div className="container page">
      <header className="page-head">
        <ServiceIdentity service={service} />
        <h1>{service === 'WATER' ? (mode === 'infrastructure' ? 'Water network map' : 'Water supply map') : mode === 'infrastructure' ? 'Electricity network map' : 'Electricity outage map'}</h1>
        <p>{service === 'WATER'
          ? (mode === 'infrastructure'
            ? 'Reservoirs, towers and direct feeds. Selecting one shades the suburbs it supplies.'
            : 'Where Johannesburg Water has reported a supply problem. A recovering system is not the same as supply restored.')
          : (mode === 'infrastructure' ? 'Pick a service centre, substation or distributor to highlight the suburbs it supplies.' : 'Where power is out right now. Switch to Infrastructure to explore equipment and the suburbs it supplies.')}</p>
      </header>

      {error && <ErrorState error={live.error} />}
      {!live.data && !error && <Skeleton h={560} r={16} />}
      {live.data && (
        <div className="map-layout">
          <div className="card map-card">
            <div className="map-bar">
              <div className="seg" role="group" aria-label="Map view">
                <button type="button" aria-pressed={mode === 'outages'} onClick={() => setMode('outages')}><Icon name="alert" /> Outages</button>
                <button type="button" aria-pressed={mode === 'infrastructure'} onClick={() => setMode('infrastructure')}><Icon name="network" /> Infrastructure</button>
              </div>
              <div className="map-search">
                <SearchBox compact placeholder={mode === 'infrastructure' ? 'Find equipment…' : 'Find a suburb or equipment…'} onPickItem={onSearch} />
              </div>
              <button type="button" className="btn small ghost" onClick={reset} title="Show everything again"><Icon name="refresh" /> Reset</button>
            </div>
            <div className="map-stage">
              <Suspense fallback={<MapFallback height={580} />}>
                <MapView
                  key={service}
                  points={points}
                  hubs={hubs}
                  flow={flow}
                  coverage={coverage}
                  focus={focus}
                  layers={layers}
                  selectedHub={hubId}
                  onPickSuburb={mode === 'outages' ? pickSuburb : undefined}
                  onPickHub={pickHub}
                  onClear={() => (mode === 'outages' ? go({}) : hubId && go({ view: 'infrastructure' }))}
                  height={580}
                  label={mode === 'infrastructure' ? `Map of ${utility}'s facilities and estimated coverage` : `Map of suburbs with ${service === 'WATER' ? 'water interruptions' : 'power outages'}`}
                />
              </Suspense>
              {hubId && !node && !hubData.error && <div className="map-toast">Loading coverage…</div>}
              {coverage && <div className="map-toast coverage-note">{isSdc ? 'Estimated service area' : 'Estimated coverage'} · based on mapped suburbs</div>}
              {mode === 'infrastructure' && !hubId && <div className="map-toast">Click a diamond to highlight its coverage</div>}
            </div>
            <div className="map-foot">
              {mode === 'outages' ? (
                <Legend items={water ? [['live', 'No supply'], ['partial', 'Reduced or recovering'], ['good', 'Supply restored'], ['live', 'Likely area', 'hollow']] : [['live', 'Power out'], ['partial', 'Partly restored'], ['good', 'Power back'], ['live', 'Likely area', 'hollow']]} />
              ) : (
                <Legend items={[['plan', water ? 'Supply asset' : 'Equipment / service centre', 'diamond'], ['live', water ? 'Incident now' : 'Outage now', 'diamond'], ...(hasShapes ? [['plan', 'Suburb it supplies']] : []), ...(coverage ? [['plan', 'Estimated coverage', 'coverage']] : [])]} />
              )}
              <span className="small faint">Map © OpenStreetMap contributors</span>
            </div>
          </div>

          <aside className="map-panel" aria-label="Details">
            {/* ── Outages view ── */}
            {mode === 'outages' && !sel && (
              <>
                <div className="small muted" style={{ marginBottom: 8 }}>{plural(outages.length, 'live outage')}{mapped < outages.length ? ` · ${outages.length - mapped} could not be placed` : ''}</div>
                {outages.length === 0 && <EmptyState icon="check" title={water ? "No live water incidents right now" : "No live outages right now"}>When {utility} reports one, the affected suburbs will show up here.</EmptyState>}
                <ul className="rows card">
                  {outages.map((o) => (
                    <li key={o.id}>
                      <button type="button" className="map-item" onClick={() => pickOutage(o.id)}>
                        <span className="t">{nice(o.title)}</span>
                        <span className="small muted clamp2">{o.latest ?? 'Waiting for the next update'}</span>
                        <span className="row small" style={{ gap: 8 }}>
                          <StatusBadge status={o.status} service={o.service} waterState={o.waterState} />
                          <span className="faint">{timeAgo(o.lastUpdateAt)}</span>
                          {o.places.length === 0 && <span className="faint">not on the map</span>}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {selectedOutage && (
              <div className="card card-pad stack" style={{ gap: 14 }}>
                {back}
                <div>
                  <StatusBadge status={selectedOutage.status} service={selectedOutage.service} waterState={selectedOutage.waterState} />
                  <h2 className="panel-title">{nice(selectedOutage.title)}</h2>
                  <div className="small faint">Updated {timeAgo(selectedOutage.lastUpdateAt)}{selectedOutage.sdc ? ` · ${nice(selectedOutage.sdc)}` : ''}</div>
                </div>
                {selectedOutage.latest && <p className="small">{selectedOutage.latest}</p>}
                <div>
                  <div className="panel-h">Suburbs</div>
                  <div className="chips">
                    {selectedOutage.places.map((p) => <button key={p.id} type="button" className="chip" onClick={() => pickSuburb(p.id)}>{p.restored && <Icon name="check" />}{nice(p.name)}</button>)}
                    {selectedOutage.places.length === 0 && <span className="small faint">No suburb has been named yet.</span>}
                  </div>
                </div>
                {selectedOutage.equipment.length > 0 && (
                  <div>
                    <div className="panel-h">Equipment involved <span className="faint">· tap one to see what it feeds</span></div>
                    <div className="chips">
                      {selectedOutage.equipment.map((n) => <button key={n.id} type="button" className="chip equip" onClick={() => pickHub(n.id)}><i className="key-dot diamond tone-plan" />{nice(n.name)}</button>)}
                    </div>
                  </div>
                )}
                <Link to={`/outages/${selectedOutage.id}`} className="btn">Open full timeline <Icon name="arrow" /></Link>
              </div>
            )}

            {suburbSel && (
              <div className="card card-pad stack" style={{ gap: 14 }}>
                {back}
                <h2 className="panel-title">{nice(suburbSel.name)}</h2>
                {suburbSel.outages.length === 0 ? <p className="small muted">No live outage reported here right now.</p> : (
                  <ul className="rows">
                    {suburbSel.outages.map((o) => (
                      <li key={o.id}>
                        <button type="button" className="map-item" onClick={() => pickOutage(o.id)}>
                          <span className="t">{nice(o.title)}</span>
                          <span className="row small" style={{ gap: 8 }}><StatusBadge status={o.status} service={o.service} waterState={o.waterState} /><span className="faint">{timeAgo(o.lastUpdateAt)}</span></span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <Link to={`/suburb/${suburbSel.id}`} className="btn">Everything about {nice(suburbSel.name)} <Icon name="arrow" /></Link>
              </div>
            )}

            {/* ── Infrastructure view ── */}
            {mode === 'infrastructure' && !hubId && (
              <div className="card">
                <div className="card-pad" style={{ paddingBottom: 10 }}>
                  <div className="small muted" style={{ marginBottom: 8 }}>{plural(allHubs.length, 'facility', 'facilities')} with mapped suburbs. Outages first.</div>
                  <div className="seg" role="group" aria-label="Type of equipment">
                    {hubKinds.map(([k, label]) => <button key={k || 'all'} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>{label}</button>)}
                  </div>
                </div>
                <ul className="rows">
                  {hubList.map((h) => (
                    <li key={h.id}>
                      <button type="button" className="map-item" onClick={() => pickHub(h.id)}>
                        <span className="t row" style={{ gap: 8 }}><i className={`key-dot diamond tone-${h.live ? 'live' : 'plan'}`} />{nice(h.name)}</span>
                        <span className="small faint">{typeLabel(h.type)} · {plural(h.served, 'associated suburb')}{h.live ? ' · outage now' : ''}</span>
                      </button>
                    </li>
                  ))}
                  {hubList.length === 0 && <li className="small faint" style={{ padding: 16 }}>Nothing of that type yet.</li>}
                </ul>
              </div>
            )}

            {mode === 'infrastructure' && hubId && (
              <div className="card card-pad stack" style={{ gap: 14 }}>
                {back}
                {!node && (hubData.error ? <ErrorState error={hubData.error} /> : <Skeleton h={140} />)}
                {node && (
                  <>
                    <div>
                      <div className="eyebrow"><i className="key-dot diamond tone-plan" /> {typeLabel(node.node.type)}</div>
                      <h2 className="panel-title">{nice(node.node.name)}</h2>
                      <p className="small muted">{plural(node.total, 'associated area')}. {isSdc ? 'The shading estimates its service area.' : 'The shading estimates coverage; glowing lines show reported connections.'}</p>
                    </div>
                    {flow && <button type="button" className="btn small" onClick={() => setReplay((n) => n + 1)}><Icon name="refresh" /> Replay animation</button>}
                    <p className="small faint">{coverage ? `Estimated from ${plural(coverage.count, 'mapped suburb')}. Shading may include unserved areas and miss others; it is not an official ${isSdc ? 'service' : service === 'WATER' ? 'water supply' : 'electricity supply'} boundary.` : 'Coverage is unavailable because no associated suburbs have map coordinates.'}</p>
                    {node.children.length > 0 && (
                      <div>
                        <div className="panel-h">{isSdc ? 'Equipment in this service area' : 'Circuits under it'}</div>
                        <div className="chips">
                          {node.children.map((c) => <button key={c.id} type="button" className="chip equip" onClick={() => pickHub(c.id)}>{c.live && <span className="dot live" style={{ width: 7, height: 7 }} />}{nice(c.name)}</button>)}
                        </div>
                      </div>
                    )}
                    <div>
                      <div className="panel-h">{isSdc ? 'Associated service areas' : 'Areas it feeds'}</div>
                      <div className="chips">
                        {[...node.places].sort((a, b) => Number(b.live) - Number(a.live)).map((p) => (
                          <Link key={p.id} to={`/suburb/${p.id}`} className="chip">{p.live && <span className="dot live" style={{ width: 7, height: 7 }} />}{nice(p.name)}</Link>
                        ))}
                      </div>
                      {node.unplaced > 0 && <p className="small faint" style={{ marginTop: 8 }}>{plural(node.unplaced, 'more area')} could not be placed on the map.</p>}
                    </div>
                    <p className="small faint">Marker positions are inferred from associated suburbs. Connections are learned from {single ? `${utility}'s` : "the utilities'"} posts.</p>
                    <Link to={`/network/${node.node.id}`} className="btn">Open equipment page <Icon name="arrow" /></Link>
                  </>
                )}
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
