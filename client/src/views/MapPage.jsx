import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import Icon from '../components/Icon.jsx';
import SearchBox from '../components/SearchBox.jsx';
import { EmptyState, ErrorState, Skeleton, StatusBadge } from '../components/ui.jsx';
import { nice, plural, timeAgo, typeLabel, useApi } from '../lib/api.js';
import { useDocumentTitle } from '../lib/hooks.js';

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
const toneOf = (status, restored) => (restored ? 'good' : status === 'PARTIALLY_RESTORED' ? 'partial' : 'live');
const boundsOf = (pts) => {
  if (!pts.length) return null;
  const xs = pts.map((p) => p.lon);
  const ys = pts.map((p) => p.lat);
  return [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]];
};

/** Bounding box of a GeoJSON feature. */
function featureBounds(f) {
  const xs = [];
  const ys = [];
  const walk = (c) => (typeof c[0] === 'number' ? (xs.push(c[0]), ys.push(c[1])) : c.forEach(walk));
  walk(f.geometry.coordinates);
  return [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]];
}

export default function MapPage() {
  useDocumentTitle('Map');
  const [params, setParams] = useSearchParams();
  const sel = params.get('hub') ? { type: 'hub', id: params.get('hub') } : params.get('outage') ? { type: 'outage', id: params.get('outage') } : params.get('suburb') ? { type: 'suburb', id: params.get('suburb') } : null;
  const [layers, setLayers] = useState({ regions: true, outages: true, equipment: false });
  const [focus, setFocus] = useState(null);
  const [replay, setReplay] = useState(0);
  const [extra, setExtra] = useState(null); // a searched suburb that has no live outage

  const live = useApi('/v1/map', { refreshMs: 60_000 });
  const regionsApi = useApi('/v1/map/regions');
  const hubsApi = useApi('/v1/map/infrastructure');
  const hubData = useApi(sel?.type === 'hub' ? `/v1/map/node/${sel.id}` : null);
  const node = hubData.data?.node?.id === sel?.id ? hubData.data : null;

  const outages = useMemo(() => live.data?.data ?? [], [live.data]);

  // one entry per suburb, with the worst status among the live outages that touch it
  const suburbs = useMemo(() => {
    const m = new Map();
    for (const o of outages) {
      for (const p of o.places) {
        const tone = toneOf(o.status, p.restored);
        const cur = m.get(p.id);
        if (!cur) m.set(p.id, { id: p.id, name: nice(p.name), lat: p.lat, lon: p.lon, tone, groups: [o.id], inferred: p.inferred, outages: [o] });
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
    const drawn = node.edges.filter((e) => e.kind === 'suburb').map((e) => e.toId);
    return new Set(drawn.length ? drawn : node.places.map((p) => p.id));
  }, [node]);
  const isDim = useCallback(
    (s) => {
      if (!sel) return false;
      if (sel.type === 'outage') return !s.groups.includes(sel.id);
      if (sel.type === 'suburb') return s.id !== sel.id;
      return node ? !servedIds.has(s.id) : false;
    },
    [sel, servedIds, node],
  );

  const points = useMemo(() => {
    const pts = [...suburbs.values()].map((s) => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon, tone: s.tone, groups: s.groups, inferred: s.inferred, dim: isDim(s), note: `${s.outages.map((o) => nice(o.title)).slice(0, 2).join(' · ')}${s.outages.length > 2 ? ` · +${s.outages.length - 2} more` : ''}` }));
    if (node) {
      // suburbs the selected equipment serves, even when nothing is wrong there right now
      for (const p of node.places) if (servedIds.has(p.id) && !suburbs.has(p.id)) pts.push({ id: p.id, name: nice(p.name), lat: p.lat, lon: p.lon, tone: 'plan', groups: [], dim: false, note: `Served by ${nice(node.node.name)}` });
    }
    if (extra && !suburbs.has(extra.id)) pts.push({ id: extra.id, name: extra.name, lat: extra.lat, lon: extra.lon, tone: 'good', groups: [], dim: false, note: 'No live outage reported' });
    return pts;
  }, [suburbs, isDim, node, extra, servedIds]);

  const regions = useMemo(() => {
    const feats = (regionsApi.data?.features ?? []).map((f) => {
      const s = suburbs.get(f.properties.id);
      const tone = s?.tone ?? 'idle';
      const affected = tone === 'live' || tone === 'partial';
      const dim = sel ? (s ? isDim(s) : sel.type !== 'hub' || !servedIds.has(f.properties.id)) : false;
      return { ...f, properties: { ...f.properties, label: nice(f.properties.name), tone, affected, dim } };
    });
    return { type: 'FeatureCollection', features: feats };
  }, [regionsApi.data, suburbs, sel, isDim, servedIds]);

  // with equipment selected, show only it and the circuits under it (the other diamonds are just noise then)
  const hubs = useMemo(() => {
    const all = hubsApi.data?.data ?? [];
    if (sel?.type !== 'hub') return all;
    const keep = new Set([sel.id, ...(node?.children ?? []).filter((c) => c.near).map((c) => c.id)]);
    return all.filter((h) => keep.has(h.id));
  }, [hubsApi.data, sel, node]);

  const flow = useMemo(() => (node?.origin && node.edges?.length ? { key: `${node.node.id}:${replay}`, origin: node.origin, edges: node.edges } : null), [node, replay]);

  const focused = useRef(null);
  const select = (type, id) => setParams(type ? { [type]: id } : {}, { replace: true });
  const zoomTo = (pts) => {
    const b = boundsOf(pts);
    if (b) setFocus({ key: Math.random(), bounds: pts.length === 1 ? [[b[0][0] - 0.01, b[0][1] - 0.008], [b[1][0] + 0.01, b[1][1] + 0.008]] : b });
  };
  const pickOutage = (id) => {
    focused.current = `outage:${id}`;
    select('outage', id);
    setExtra(null);
    const o = outages.find((x) => x.id === id);
    if (o) zoomTo(o.places);
  };
  const frameSuburb = (id, fallback) => {
    const region = regionsApi.data?.features?.find((f) => f.properties.id === id);
    if (region) setFocus({ key: Math.random(), bounds: featureBounds(region) }); // the whole outline, not just its centre
    else if (fallback) zoomTo([fallback]);
  };
  const pickSuburb = (id) => {
    focused.current = `suburb:${id}`;
    const s = suburbs.get(id);
    setExtra(null);
    select('suburb', id);
    frameSuburb(id, s);
  };
  const pickHub = (id) => {
    select('hub', id);
    setExtra(null);
    setLayers((l) => ({ ...l, equipment: true }));
    setReplay((n) => n + 1);
  };
  const reset = () => {
    select(null);
    setExtra(null);
    zoomTo([...suburbs.values()]);
  };
  const onSearch = (it) => {
    if (it.kind === 'suburb') {
      if (suburbs.has(it.id)) return pickSuburb(it.id);
      if (it.lat != null) {
        const s = { id: it.id, name: it.title, lat: it.lat, lon: it.lon };
        setExtra(s);
        select('suburb', it.id);
        return zoomTo([s]);
      }
      return select('suburb', it.id);
    }
    if (it.kind === 'outage') return outages.some((o) => o.id === it.id) ? pickOutage(it.id) : window.location.assign(`/outages/${it.id}`);
    return pickHub(it.id);
  };

  // a link like /map?outage=… opens already selected: zoom to it once the data is here
  useEffect(() => {
    if (!live.data || !sel || focused.current === `${sel.type}:${sel.id}`) return;
    if (sel.type === 'outage' && selectedOutage) {
      focused.current = `outage:${sel.id}`;
      zoomTo(selectedOutage.places);
    } else if (sel.type === 'suburb' && suburbs.has(sel.id)) {
      focused.current = `suburb:${sel.id}`;
      frameSuburb(sel.id, suburbs.get(sel.id));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.data, sel?.type, sel?.id, selectedOutage, suburbs]);

  const error = live.error && !live.data;
  const mapped = outages.filter((o) => o.places.length).length;
  const suburbSel = sel?.type === 'suburb' ? suburbs.get(sel.id) ?? (extra?.id === sel.id ? { ...extra, outages: [], tone: 'good' } : null) : null;

  return (
    <div className="container page">
      <header className="page-head">
        <h1>Outage map</h1>
        <p>Where power is out right now, and how City Power's equipment feeds each area. Tap a suburb or a piece of equipment to explore it.</p>
      </header>

      {error && <ErrorState error={live.error} />}
      {!live.data && !error && <Skeleton h={560} r={16} />}
      {live.data && (
        <div className="map-layout">
          <div className="card map-card">
            <div className="map-bar">
              <div className="map-search">
                <SearchBox compact placeholder="Find a suburb or equipment…" onPickItem={onSearch} />
              </div>
              <div className="seg" role="group" aria-label="Map layers">
                <button type="button" aria-pressed={layers.outages} onClick={() => setLayers((l) => ({ ...l, outages: !l.outages }))}>Outages</button>
                <button type="button" aria-pressed={layers.regions} onClick={() => setLayers((l) => ({ ...l, regions: !l.regions }))}>Areas</button>
                <button type="button" aria-pressed={layers.equipment} onClick={() => setLayers((l) => ({ ...l, equipment: !l.equipment }))}>Equipment</button>
              </div>
              <button type="button" className="btn small ghost" onClick={reset} title="Show every live outage"><Icon name="refresh" /> Reset</button>
            </div>
            <div className="map-stage">
              <Suspense fallback={<MapFallback height={560} />}>
                <MapView
                  regions={regions}
                  points={points}
                  hubs={hubs}
                  flow={flow}
                  focus={focus}
                  layers={layers}
                  selectedHub={sel?.type === 'hub' ? sel.id : null}
                  onPickSuburb={pickSuburb}
                  onPickHub={pickHub}
                  onClear={() => select(null)}
                  height={580}
                  label="Map of suburbs with power outages and the equipment that feeds them"
                />
              </Suspense>
              {sel?.type === 'hub' && hubData.loading && <div className="map-toast">Loading connections…</div>}
            </div>
            <div className="map-foot">
              <Legend items={[['live', 'Power out'], ['partial', 'Partly restored'], ['good', 'Power back'], ['live', 'Likely area', 'hollow'], ['plan', 'Equipment', 'diamond']]} />
              <span className="small faint">Suburb outlines © Statistics South Africa (Census 2011) · Map © OpenStreetMap contributors</span>
            </div>
          </div>

          <aside className="map-panel" aria-label="Details">
            {!sel && (
              <>
                <div className="small muted" style={{ marginBottom: 8 }}>{plural(outages.length, 'live outage')}{mapped < outages.length ? ` · ${outages.length - mapped} could not be placed` : ''}</div>
                {outages.length === 0 && <EmptyState icon="check" title="No live outages right now">When City Power reports one, the affected suburbs will show up here.</EmptyState>}
                <ul className="rows card">
                  {outages.map((o) => (
                    <li key={o.id}>
                      <button type="button" className="map-item" onClick={() => pickOutage(o.id)}>
                        <span className="t">{nice(o.title)}</span>
                        <span className="small muted clamp2">{o.latest ?? 'Waiting for the next update'}</span>
                        <span className="row small" style={{ gap: 8 }}>
                          <StatusBadge status={o.status} />
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
                <button type="button" className="link back" onClick={reset}><Icon name="arrow" className="flip" /> All outages</button>
                <div>
                  <StatusBadge status={selectedOutage.status} />
                  <h2 className="panel-title">{nice(selectedOutage.title)}</h2>
                  <div className="small faint">Updated {timeAgo(selectedOutage.lastUpdateAt)}{selectedOutage.sdc ? ` · ${nice(selectedOutage.sdc)}` : ''}</div>
                </div>
                {selectedOutage.latest && <p className="small">{selectedOutage.latest}</p>}
                <div>
                  <div className="panel-h">Suburbs</div>
                  <div className="chips">
                    {selectedOutage.places.map((p) => <button key={p.id} type="button" className="chip" onClick={() => pickSuburb(p.id)}>{p.restored && <Icon name="check" />}{nice(p.name)}</button>)}
                    {selectedOutage.places.length === 0 && <span className="small faint">City Power didn't name a suburb yet.</span>}
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
                <button type="button" className="link back" onClick={reset}><Icon name="arrow" className="flip" /> All outages</button>
                <h2 className="panel-title">{nice(suburbSel.name)}</h2>
                {suburbSel.outages.length === 0 ? <p className="small muted">No live outage reported here right now.</p> : (
                  <ul className="rows">
                    {suburbSel.outages.map((o) => (
                      <li key={o.id}>
                        <button type="button" className="map-item" onClick={() => pickOutage(o.id)}>
                          <span className="t">{nice(o.title)}</span>
                          <span className="row small" style={{ gap: 8 }}><StatusBadge status={o.status} /><span className="faint">{timeAgo(o.lastUpdateAt)}</span></span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <Link to={`/suburb/${suburbSel.id}`} className="btn">Everything about {nice(suburbSel.name)} <Icon name="arrow" /></Link>
              </div>
            )}

            {sel?.type === 'hub' && (
              <div className="card card-pad stack" style={{ gap: 14 }}>
                <button type="button" className="link back" onClick={reset}><Icon name="arrow" className="flip" /> All outages</button>
                {!node && <Skeleton h={140} />}
                {node && (
                  <>
                    <div>
                      <div className="eyebrow"><i className="key-dot diamond tone-plan" /> {typeLabel(node.node.type)}</div>
                      <h2 className="panel-title">{nice(node.node.name)}</h2>
                      <p className="small muted">Feeds {plural(node.total, 'suburb')}{node.children.length ? ` through ${plural(node.children.length, 'circuit')}` : ''}. The glowing lines show how power reaches them.</p>
                    </div>
                    <button type="button" className="btn small" onClick={() => setReplay((n) => n + 1)}><Icon name="refresh" /> Replay animation</button>
                    {node.children.length > 0 && (
                      <div>
                        <div className="panel-h">Circuits under it</div>
                        <div className="chips">
                          {node.children.map((c) => <button key={c.id} type="button" className="chip equip" onClick={() => pickHub(c.id)}>{c.live && <span className="dot live" style={{ width: 7, height: 7 }} />}{nice(c.name)}</button>)}
                        </div>
                      </div>
                    )}
                    <div>
                      <div className="panel-h">Suburbs it serves</div>
                      <div className="chips">
                        {[...node.places].sort((a, b) => Number(b.live) - Number(a.live)).map((p) => <button key={p.id} type="button" className="chip" onClick={() => pickSuburb(p.id)}>{p.live && <span className="dot live" style={{ width: 7, height: 7 }} />}{nice(p.name)}</button>)}
                      </div>
                      {node.unplaced > 0 && <p className="small faint" style={{ marginTop: 8 }}>{plural(node.unplaced, 'more suburb')} could not be placed on the map.</p>}
                    </div>
                    <p className="small faint">City Power doesn't publish where equipment stands, so its marker sits at the centre of the suburbs it serves. The connections come from City Power's own posts.</p>
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
