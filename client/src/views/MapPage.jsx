import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
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
const HUB_KINDS = [['', 'All'], ['SUBSTATION', 'Substations'], ['SWITCHING_STATION', 'Switching stations'], ['DISTRIBUTOR', 'Distributors']];

/**
 * Two views of the same map:
 *   Outages         where power is out right now (dots, grouped into bubbles when zoomed out)
 *   Infrastructure  City Power's equipment; click one and lines animate out to the areas it feeds
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

  const live = useApi('/v1/map', { refreshMs: 60_000 });
  const hubsApi = useApi('/v1/map/infrastructure', { refreshMs: 120_000 });
  const hubData = useApi(hubId ? `/v1/map/node/${hubId}` : null);
  const node = hubData.data?.node?.id === hubId ? hubData.data : null;

  const outages = useMemo(() => live.data?.data ?? [], [live.data]);
  const allHubs = useMemo(() => hubsApi.data?.data ?? [], [hubsApi.data]);

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

  const points = useMemo(() => {
    if (mode === 'infrastructure') {
      // only the areas the selected equipment feeds
      return (node?.places ?? []).filter((p) => servedIds.has(p.id)).map((p) => ({ id: p.id, name: nice(p.name), lat: p.lat, lon: p.lon, tone: p.live ? 'live' : 'plan', groups: [], note: `Fed by ${nice(node.node.name)}${p.live ? ' · outage now' : ''}` }));
    }
    const pts = [...suburbs.values()].map((s) => {
      const dim = sel ? (sel.type === 'outage' ? !s.groups.includes(sel.id) : s.id !== sel.id) : false;
      return { id: s.id, name: s.name, lat: s.lat, lon: s.lon, tone: s.tone, groups: s.groups, inferred: s.inferred, dim, note: `${s.outages.map((o) => nice(o.title)).slice(0, 2).join(' · ')}${s.outages.length > 2 ? ` · +${s.outages.length - 2} more` : ''}` };
    });
    if (extra && !suburbs.has(extra.id)) pts.push({ id: extra.id, name: extra.name, lat: extra.lat, lon: extra.lon, tone: 'good', groups: [], note: 'No live outage reported' });
    return pts;
  }, [mode, suburbs, sel, node, servedIds, extra]);

  // in the Infrastructure view: every piece of equipment, or (once one is picked) just it and its circuits
  const hubs = useMemo(() => {
    if (mode !== 'infrastructure') return [];
    if (!hubId) return allHubs.filter((h) => !kind || h.type === kind);
    const keep = new Set([hubId, ...(node?.children ?? []).filter((c) => c.near).map((c) => c.id)]);
    return allHubs.filter((h) => keep.has(h.id));
  }, [mode, allHubs, hubId, node, kind]);

  const flow = useMemo(() => (mode === 'infrastructure' && node?.origin && node.edges?.length ? { key: `${node.node.id}:${replay}`, origin: node.origin, edges: node.edges } : null), [mode, node, replay]);
  const layers = useMemo(() => ({ outages: true, equipment: mode === 'infrastructure' }), [mode]);

  // ── moving around
  const zoomTo = (pts) => {
    const b = boundsOf(pts);
    if (b) setFocus({ key: Math.random(), bounds: pts.length === 1 ? [[b[0][0] - 0.01, b[0][1] - 0.008], [b[1][0] + 0.01, b[1][1] + 0.008]] : b });
  };
  const go = (next) => setParams(next, { replace: true });
  const focused = useRef(null);
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
      if (hubId || !allHubs.length) return; // a chosen piece frames itself with its animation
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
  }, [live.data, mode, hubId, allHubs.length, sel?.type, sel?.id, selectedOutage, suburbs]);

  const error = live.error && !live.data;
  const mapped = outages.filter((o) => o.places.length).length;
  const suburbSel = sel?.type === 'suburb' ? suburbs.get(sel.id) ?? (extra?.id === sel.id ? { ...extra, outages: [], tone: 'good' } : null) : null;
  const hubList = useMemo(() => [...allHubs].filter((h) => !kind || h.type === kind).sort((a, b) => Number(b.live) - Number(a.live) || b.served - a.served).slice(0, 60), [allHubs, kind]);

  const back = <button type="button" className="link back" onClick={reset}><Icon name="arrow" className="flip" /> {mode === 'infrastructure' ? 'All equipment' : 'All outages'}</button>;

  return (
    <div className="container page">
      <header className="page-head">
        <h1>{mode === 'infrastructure' ? 'Power network map' : 'Outage map'}</h1>
        <p>{mode === 'infrastructure' ? "City Power's equipment. Pick a substation or distributor and watch power flow out to the areas it feeds." : "Where power is out right now. Switch to Infrastructure to see how City Power's equipment feeds each area."}</p>
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
                  points={points}
                  hubs={hubs}
                  flow={flow}
                  focus={focus}
                  layers={layers}
                  selectedHub={hubId}
                  onPickSuburb={mode === 'outages' ? pickSuburb : undefined}
                  onPickHub={pickHub}
                  onClear={() => (mode === 'outages' ? go({}) : hubId && go({ view: 'infrastructure' }))}
                  height={580}
                  label={mode === 'infrastructure' ? "Map of City Power's equipment and the areas it feeds" : 'Map of suburbs with power outages'}
                />
              </Suspense>
              {hubId && hubData.loading && !node && <div className="map-toast">Loading connections…</div>}
              {mode === 'infrastructure' && !hubId && <div className="map-toast">Click a diamond to see what it feeds</div>}
            </div>
            <div className="map-foot">
              {mode === 'outages' ? (
                <Legend items={[['live', 'Power out'], ['partial', 'Partly restored'], ['good', 'Power back'], ['live', 'Likely area', 'hollow']]} />
              ) : (
                <Legend items={[['plan', 'Equipment', 'diamond'], ['live', 'Outage now', 'diamond'], ['plan', 'Area it feeds']]} />
              )}
              <span className="small faint">Map © OpenStreetMap contributors</span>
            </div>
          </div>

          <aside className="map-panel" aria-label="Details">
            {/* ── Outages view ── */}
            {mode === 'outages' && !sel && (
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
                {back}
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
                {back}
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

            {/* ── Infrastructure view ── */}
            {mode === 'infrastructure' && !hubId && (
              <div className="card">
                <div className="card-pad" style={{ paddingBottom: 10 }}>
                  <div className="small muted" style={{ marginBottom: 8 }}>{plural(allHubs.length, 'piece')} of equipment with a known area. Outages first.</div>
                  <div className="seg" role="group" aria-label="Type of equipment">
                    {HUB_KINDS.map(([k, label]) => <button key={k || 'all'} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>{label}</button>)}
                  </div>
                </div>
                <ul className="rows">
                  {hubList.map((h) => (
                    <li key={h.id}>
                      <button type="button" className="map-item" onClick={() => pickHub(h.id)}>
                        <span className="t row" style={{ gap: 8 }}><i className={`key-dot diamond tone-${h.live ? 'live' : 'plan'}`} />{nice(h.name)}</span>
                        <span className="small faint">{typeLabel(h.type)} · feeds {plural(h.served, 'area')}{h.live ? ' · outage now' : ''}</span>
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
                {!node && <Skeleton h={140} />}
                {node && (
                  <>
                    <div>
                      <div className="eyebrow"><i className="key-dot diamond tone-plan" /> {typeLabel(node.node.type)}</div>
                      <h2 className="panel-title">{nice(node.node.name)}</h2>
                      <p className="small muted">Feeds {plural(node.total, 'area')}{node.children.length ? ` through ${plural(node.children.length, 'circuit')}` : ''}. The glowing lines show how power reaches them.</p>
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
                      <div className="panel-h">Areas it feeds</div>
                      <div className="chips">
                        {[...node.places].sort((a, b) => Number(b.live) - Number(a.live)).map((p) => (
                          <Link key={p.id} to={`/suburb/${p.id}`} className="chip">{p.live && <span className="dot live" style={{ width: 7, height: 7 }} />}{nice(p.name)}</Link>
                        ))}
                      </div>
                      {node.unplaced > 0 && <p className="small faint" style={{ marginTop: 8 }}>{plural(node.unplaced, 'more area')} could not be placed on the map.</p>}
                    </div>
                    <p className="small faint">City Power doesn't publish where equipment stands, so its marker sits at the centre of the areas it feeds. The connections come from City Power's own posts.</p>
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
