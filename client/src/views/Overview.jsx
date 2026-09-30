import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import Icon from '../components/Icon.jsx';
import MyArea from '../components/MyArea.jsx';
import RefreshButton from '../components/RefreshButton.jsx';
import SearchBox from '../components/SearchBox.jsx';
import SyncStatus from '../components/SyncStatus.jsx';
import UpdatesFeed, { countNew, useSeenUpdates } from '../components/UpdatesFeed.jsx';
import { Sparkline } from '../components/charts.jsx';
import { EmptyState, ErrorState, Freshness, Meter, SectionHead, Skeleton, StatusBadge } from '../components/ui.jsx';
import { fmtDay, nice, placeTone, plural, prettySdc, statusMeta, timeAgo, todayISO, useApi } from '../lib/api.js';
import { useDocumentTitle, useMyArea, useTick } from '../lib/hooks.js';
import { isNewSince } from '../lib/newness.js';
import { useMunicipality, useUtility, withMunicipality } from '../lib/municipality.jsx';
import { useRefresh } from '../lib/refresh.js';

const MapView = lazy(() => import('../components/MapView.jsx'));
const MAP_LAYERS = { outages: true, equipment: false };
const ORDER = { ACTIVE: 0, PARTIALLY_RESTORED: 1, PLANNED: 2, RESTORED: 3, CLOSED: 3, STALE: 4, CANCELLED: 5 };
const LIVE_LAYERS = ['ACTIVE', 'PARTIALLY_RESTORED'];
const DAY_LAYERS = ['ACTIVE', 'PARTIALLY_RESTORED', 'RESTORED', 'PLANNED', 'STALE', 'CANCELLED'];

/** Closed incidents sit with Restored. Everything else is its own layer. */
const layerOf = (status) => (status === 'CLOSED' ? 'RESTORED' : status);

function layerChoices(water) {
  return [
    { id: 'ACTIVE', label: water ? 'Interrupted' : 'Active', tone: 'live' },
    { id: 'PARTIALLY_RESTORED', label: water ? 'Returning' : 'Restoring', tone: 'partial' },
    { id: 'RESTORED', label: 'Restored', tone: 'good' },
    { id: 'PLANNED', label: 'Planned', tone: 'plan' },
    { id: 'STALE', label: 'No update', tone: 'idle' },
    { id: 'CANCELLED', label: 'Cancelled', tone: 'idle' },
  ];
}

function LayerToggles({ choices, layers, counts, onToggle }) {
  return (
    <div className="layer-toggles" role="group" aria-label="Layers">
      {choices.map((layer) => (
        <button key={layer.id} type="button" className={`layer-toggle tone-${layer.tone}`} aria-pressed={layers.includes(layer.id)} onClick={() => onToggle(layer.id)}>
          <i className="key-dot" />
          {layer.label}
          <span className="num">{counts[layer.id] ?? 0}</span>
        </button>
      ))}
    </div>
  );
}

/** How long an outage has been running, in the fewest words. */
function since(startedAt) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(startedAt)) / 60_000));
  if (mins < 60) return `${mins} min`;
  if (mins < 60 * 48) return `${Math.round(mins / 60)} h`;
  return `${Math.round(mins / 1440)} d`;
}

/** "4 new today · ▲ 1 vs yesterday": how many began today, compared with how many began yesterday. It deliberately
 * names what it counts, because the big number above it is how many are live, which is a different thing. */
function Delta({ now, before }) {
  if (now == null || before == null) return null;
  const d = now - before;
  return <span className={`delta${d === 0 ? ' same' : ''}`}>{now} new today · {d === 0 ? 'same as yesterday' : `${d > 0 ? '▲' : '▼'} ${Math.abs(d)} vs yesterday`}</span>;
}

/** A headline number. With `onClick` it filters the list beside it (and shows as pressed); with `to` it opens a page. */
function Metric({ label, value, hint, to, onClick, pressed, tone, spark, delta, loading }) {
  const Tag = onClick ? 'button' : Link;
  const props = onClick ? { type: 'button', onClick, 'aria-pressed': pressed } : { to };
  return (
    <Tag {...props} className={`metric tone-${tone}`}>
      <span className="metric-label"><i className="metric-dot" />{label}</span>
      {loading ? <Skeleton h={40} w="55%" /> : <span className="metric-value num">{value ?? '–'}</span>}
      <span className="metric-foot">{delta ?? <span className="delta same">{hint}</span>}</span>
      {spark && <span className="metric-spark"><Sparkline values={spark} w={92} h={34} /></span>}
    </Tag>
  );
}

/** One outage in the stage list. Selecting it frames it on the map and opens the detail underneath. */
function StageRow({ o, selected, onSelect, dated }) {
  const { lastBatch } = useRefresh();
  const m = statusMeta(o.status, o.service, o.waterState);
  const fresh = !dated && isNewSince(o.latestIngestedAt, lastBatch);
  const liveNow = o.status === 'ACTIVE' || o.status === 'PARTIALLY_RESTORED';
  const areas = o.places.filter((p) => !p.restored).map((p) => nice(p.name));
  return (
    <li className={`srow tone-${m.tone}${selected ? ' is-selected' : ''}`} data-outage={o.id}>
      <button type="button" className="srow-btn" aria-pressed={selected} onClick={() => onSelect(selected ? null : o.id)}>
        <span className="srow-glyph" aria-hidden="true"><Icon name={m.icon} /></span>
        <span className="srow-main">
          <span className="srow-title">{nice(o.title)}{fresh && <em className="new-pill">New</em>}</span>
          <span className="srow-meta">
            <b>{m.label}</b>
            {o.sdc && <span>{prettySdc(o.sdc)}</span>}
            <span className="num">{liveNow && !dated ? `${since(o.startedAt)} so far` : `began ${fmtDay(o.startedAt)}`}</span>
            <span className="num">updated {timeAgo(o.lastUpdateAt)}</span>
          </span>
        </span>
      </button>
      {selected && (
        <div className="srow-open">
          {o.latest && <p>{o.latest}</p>}
          {o.restorationPercent != null && <Meter value={o.restorationPercent} />}
          {areas.length > 0 && <div className="chips">{areas.slice(0, 6).map((a) => <span key={a} className="chip">{a}</span>)}{areas.length > 6 && <span className="small faint">+{areas.length - 6} more</span>}</div>}
          <Link to={`/outages/${o.id}`} className="btn small primary">Open the timeline <Icon name="arrow" /></Link>
        </div>
      )}
    </li>
  );
}

/** Fourteen days per service centre, darker = more outages started that day. Like an uptime bar, for the grid. */
function HistoryStrips({ rows }) {
  const max = Math.max(1, ...rows.flatMap((r) => r.days.map((d) => d.count)));
  return (
    <div className="strips">
      <div className="strips-head"><span /><span className="num">14 days ago</span><span className="num">today</span><span /></div>
      {rows.map((r) => {
        const total = r.days.reduce((n, d) => n + d.count, 0);
        return (
          <div key={r.sdc} className="strip">
            <Link to={`/outages?sdc=${encodeURIComponent(r.sdc)}&status=all`} className="strip-name">{prettySdc(r.sdc)}</Link>
            <div className="strip-cells" role="img" aria-label={`${prettySdc(r.sdc)}: ${plural(total, 'outage')} started in the last 14 days`}>
              {r.days.map((d) => (
                <i key={d.date} className={d.count ? 'on' : ''} style={d.count ? { '--level': 0.25 + 0.75 * (d.count / max) } : undefined} title={`${d.date}: ${plural(d.count, 'outage')} started`} />
              ))}
            </div>
            <span className="strip-total num">{total}</span>
          </div>
        );
      })}
      <p className="strip-note">Each square is a day. It shows how many unplanned outages began in that service centre.</p>
    </div>
  );
}

export default function Overview() {
  useDocumentTitle();
  useTick(60_000);
  const { param: muniParam, service } = useMunicipality();
  const water = service === 'WATER';
  const { Utility, utility, accounts } = useUtility();
  const { data, error, loading } = useApi(withMunicipality('/v1/overview', muniParam), { refreshMs: 60_000 });
  const [day, setDay] = useState(''); // '' is live right now; a YYYY-MM-DD shows outages underway that Johannesburg day
  const map = useApi(withMunicipality(day ? `/v1/map?on=${day}` : '/v1/map', muniParam), { refreshMs: 60_000, keepPrevious: !day });
  const { area } = useMyArea();
  const areaDetail = useApi(area ? `/v1/localities/${area.id}` : null);
  const areaShape = areaDetail.data?.id === area?.id ? areaDetail.data : null;
  const [selectedId, setSelectedId] = useState(null);
  const [layers, setLayers] = useState(LIVE_LAYERS);
  const [tab, setTab] = useState(() => (new URLSearchParams(window.location.search).get('panel') === 'updates' ? 'updates' : 'outages')); // outages | updates (?panel=updates links straight to the feed)
  const updates = useApi(withMunicipality('/v1/updates?limit=60', muniParam), { refreshMs: 60_000 });
  const seen = useSeenUpdates();
  const newCount = seen.cleared ? 0 : countNew(updates.data?.data ?? [], seen.seenAt);

  const outages = useMemo(() => {
    const rows = [...(map.data?.data ?? [])];
    if (day) return rows.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt) || String(a.id).localeCompare(String(b.id)));
    return rows.sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || new Date(b.lastUpdateAt) - new Date(a.lastUpdateAt));
  }, [map.data, day]);
  const shown = outages.filter((o) => layers.includes(layerOf(o.status)));
  const dayLabel = day ? fmtDay(`${day}T12:00:00+02:00`) : '';
  const choices = layerChoices(water).filter((layer) => {
    const present = outages.some((o) => layerOf(o.status) === layer.id);
    if (present) return true;
    return !day && LIVE_LAYERS.includes(layer.id);
  });
  const counts = Object.fromEntries(choices.map((layer) => [layer.id, outages.filter((o) => layerOf(o.status) === layer.id).length]));
  const onlyLayer = (status) => layers.length === 1 && layers[0] === status;
  // the headline numbers show just that live layer; pressing the active one again shows both live layers
  const showOnly = (status) => {
    setDay('');
    setLayers(onlyLayer(status) && !day ? LIVE_LAYERS : [status]);
    setSelectedId(null);
    setTab('outages');
  };
  const pickDay = (value) => {
    setDay(value);
    setLayers(value ? DAY_LAYERS : LIVE_LAYERS);
    setSelectedId(null);
    setTab('outages');
  };
  const toggleLayer = (id) => {
    setLayers((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
    setSelectedId(null);
  };
  const selected = shown.find((o) => o.id === selectedId) ?? null;

  const points = useMemo(() => {
    const pts = shown.flatMap((o) => o.places.map((p) => ({
      id: `${o.id}:${p.id}`, sub: p.id, oid: o.id, name: nice(p.name), lat: p.lat, lon: p.lon,
      boundary: p.boundary ?? null, inferred: p.inferred, tone: day && !p.restored && ['RESTORED', 'CLOSED', 'STALE'].includes(o.status) ? 'live' : placeTone(o, p.restored),
      groups: [o.id], dim: Boolean(selectedId) && o.id !== selectedId, note: nice(o.title),
    })));
    if (areaShape?.lat != null && areaShape.lon != null && !pts.some((p) => p.sub === areaShape.id)) {
      pts.push({
        id: `area:${areaShape.id}`, sub: areaShape.id, oid: null, name: nice(areaShape.name), lat: areaShape.lat, lon: areaShape.lon,
        boundary: areaShape.boundary ?? null, inferred: false, tone: 'plan', groups: [], dim: Boolean(selectedId), note: 'Your saved area',
      });
    }
    return pts;
  }, [shown, selectedId, areaShape, day]);
  const focus = useMemo(() => {
    const frame = (pts, key) => {
      if (!pts.length) return null;
      const lons = pts.map((p) => p.lon);
      const lats = pts.map((p) => p.lat);
      const pad = 0.012;
      return { key, bounds: [[Math.min(...lons) - pad, Math.min(...lats) - pad], [Math.max(...lons) + pad, Math.max(...lats) + pad]] };
    };
    if (selected) return frame(selected.places.filter((p) => p.lat != null), selected.id);
    if (areaShape?.lat != null && areaShape.lon != null) return frame([areaShape], `area:${areaShape.id}`);
    return null;
  }, [selected, areaShape]);
  const outageFor = (ids) => {
    const hits = [...new Set(ids.map((id) => points.find((p) => p.id === id)?.oid).filter(Boolean))];
    return hits.length === 1 ? hits[0] : null;
  };
  const pick = (pointId) => setSelectedId(outageFor([pointId]));
  const pickCluster = (ids) => {
    const oid = outageFor(ids);
    if (!oid) return false;
    setSelectedId(oid);
    return true;
  };
  useEffect(() => {
    if (!selectedId || tab !== 'outages') return;
    document.querySelector(`[data-outage="${selectedId}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selectedId, tab]);
  useEffect(() => {
    const esc = (e) => e.key === 'Escape' && setSelectedId(null);
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, []);

  const c = data?.counts;
  const daily = data?.daily ?? [];
  const today = daily.at(-1)?.count;
  const yesterday = daily.at(-2)?.count;
  const behindHrs = data?.lastPostAt ? (Date.now() - new Date(data.lastPostAt).getTime()) / 3_600_000 : 0;
  const loadingAll = loading && !data;

  return (
    <>
      <section className="statusbar" aria-label="Right now">
        <div className="wide statusbar-row">
          <div className="statusbar-lead">
            <h1><Icon name={water ? 'drop' : 'bolt'} /> {water ? 'Is your water supply affected?' : 'Is your power out?'}</h1>
            <p className="dateline"><Freshness lastPostAt={data?.lastPostAt} /></p>
          </div>
          <div className="metrics">
            <Metric label={water ? 'Supply problems now' : 'Outages right now'} value={c?.live} onClick={() => showOnly('ACTIVE')} pressed={!day && onlyLayer('ACTIVE')} tone="live" spark={daily.map((d) => d.count)} delta={<Delta now={today} before={yesterday} />} loading={loadingAll} />
            <Metric label={water ? 'Supply returning' : 'Being restored'} value={c?.partial} onClick={() => showOnly('PARTIALLY_RESTORED')} pressed={!day && onlyLayer('PARTIALLY_RESTORED')} tone="partial" hint={water ? 'Back in some areas' : 'Some suburbs are back on'} loading={loadingAll} />
            <Metric label="Restored in 24 hours" value={c?.restored24h} to="/outages?status=restored" tone="good" hint={water ? 'Water supply restored' : 'Power is back on'} loading={loadingAll} />
            <Metric label="Planned ahead" value={c?.plannedUpcoming} to="/planned" tone="plan" hint="Scheduled maintenance" loading={loadingAll} />
          </div>
          <div className="statusbar-actions"><SyncStatus /><RefreshButton /></div>
        </div>
        {behindHrs > 6 && (
          <div className="wide">
            <div className="notice" role="status">
              <Icon name="clock" />
              <div><b>This may be out of date.</b> The newest post we have from {utility} is {timeAgo(data.lastPostAt)}. Check {accounts.map((a, i) => <span key={a}>{i > 0 && ' or '}<a className="link" href={`https://x.com/${a}`} target="_blank" rel="noreferrer">@{a}</a></span>)} for anything newer.</div>
            </div>
          </div>
        )}
      </section>

      <section className="stage" aria-label="Outages on the map">
        <aside className="stage-panel">
          <div className="stage-tools">
            <SearchBox placeholder="Search your suburb, e.g. Fourways" compact />
            <MyArea />
          </div>
          <div className="stage-when">
            <div className="seg" role="group" aria-label="When">
              <button type="button" aria-pressed={!day} onClick={() => pickDay('')}>Now</button>
            </div>
            <label className="day-filter">
              <span>Day</span>
              <input type="date" className="field" max={todayISO()} value={day} onChange={(e) => pickDay(e.target.value)} aria-label="Show outages underway on this day" />
            </label>
          </div>
          <div className="stage-tabs" role="tablist" aria-label="Show">
            <button type="button" role="tab" aria-selected={tab === 'outages'} onClick={() => setTab('outages')}>{day ? dayLabel : (water ? 'Live incidents' : 'Live outages')} <span className="num">{shown.length}</span></button>
            <button type="button" role="tab" aria-selected={tab === 'updates'} onClick={() => setTab('updates')}>Latest updates{newCount > 0 && <span className="tab-badge">{newCount} new</span>}</button>
          </div>
          {tab === 'updates' ? (
            <div className="stage-scroll"><UpdatesFeed all={updates.data?.data} loading={updates.loading && !updates.data} seenAt={seen.seenAt} markSeen={seen.markSeen} /></div>
          ) : (
            <>
          <div className="stage-head">
            <h2>{day ? `Underway on ${dayLabel}` : (water ? 'Where water is interrupted' : 'Where power is out')}</h2>
            <LayerToggles choices={choices} layers={layers} counts={counts} onToggle={toggleLayer} />
          </div>
          {error && !data && <ErrorState error={error} />}
          {map.loading && !map.data ? (
            <div className="stage-skeleton" aria-busy="true">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} h={62} />)}</div>
          ) : shown.length ? (
            <>
            <ul className="slist">{shown.map((o) => <StageRow key={o.id} o={o} selected={o.id === selectedId} onSelect={setSelectedId} dated={Boolean(day)} />)}</ul>
            {map.data?.truncated && <p className="stage-note">This day has more outages than the map can draw. The latest 300 are shown.</p>}
            </>
          ) : (
            outages.length ? (
            <EmptyState icon="check" title="Those layers are hidden" action={<button type="button" className="btn small" onClick={() => setLayers(day ? DAY_LAYERS : LIVE_LAYERS)}>Show them</button>}>Turn a layer back on to see it in the list and on the map.</EmptyState>
          ) : day ? (
            <EmptyState icon="calendar" title={`Nothing underway on ${dayLabel}`}>No {water ? 'water incident' : 'outage'} was open on this day.</EmptyState>
          ) : (
            <EmptyState icon="check" title={water ? 'No live water incidents' : 'No live outages'}>{Utility} hasn't reported any active {water ? 'water supply problems' : 'outages'} in the last two days. That's good news.</EmptyState>
          )
          )}
          <Link to="/outages" className="stage-more link">{water ? 'All water incidents' : 'All outages'}, planned and restored <Icon name="arrow" /></Link>
            </>
          )}
        </aside>
        <div className="stage-map">
          <Suspense fallback={<div className="map-fallback" />}>
            <MapView points={points} layers={MAP_LAYERS} height="100%" focus={focus} onPickSuburb={pick} onPickCluster={pickCluster} onClear={() => setSelectedId(null)} label={day ? `Map of suburbs affected on ${dayLabel}` : 'Map of suburbs with an outage right now'} />
          </Suspense>
          {selected && (
            <div className="map-pick">
              <button type="button" className="map-pick-x" aria-label="Clear selection" onClick={() => setSelectedId(null)}><Icon name="close" /></button>
              <StatusBadge status={selected.status} service={selected.service} waterState={selected.waterState} />
              <h2>{nice(selected.title)}</h2>
              {selected.latest && <p>{selected.latest}</p>}
              <div className="panel-h">{water ? 'Areas affected' : 'Suburbs affected'}</div>
              <div className="chips">
                {selected.places.map((p) => <span key={p.id} className="chip">{p.restored && <Icon name="check" />}{nice(p.name)}</span>)}
                {selected.places.length === 0 && <span className="small faint">No suburb has been named yet.</span>}
              </div>
              <Link to={`/outages/${selected.id}`} className="btn small primary">Open the timeline <Icon name="arrow" /></Link>
            </div>
          )}
          <div className="map-key">
            {areaShape && <span><i className="key-dot tone-plan" /> Your area</span>}
            <LayerToggles choices={choices} layers={layers} counts={counts} onToggle={toggleLayer} />
          </div>
          <Link to="/map" className="map-open btn small">Full map <Icon name="arrow" /></Link>
        </div>
      </section>

      <div className="wide below">
        {!water && <section className="section" aria-labelledby="hist-h">
          <SectionHead id="hist-h" title="The last 14 days" sub="Outages that began, by service centre" />
          {data ? (
            data.history?.length ? <HistoryStrips rows={data.history} /> : <p className="muted">No outages recorded in the last 14 days.</p>
          ) : <Skeleton h={220} />}
        </section>}

        <section className="section" aria-labelledby="plan-h">
          <SectionHead id="plan-h" title="Planned maintenance" sub="Scheduled interruptions coming up" action={<Link to="/planned" className="link">Full schedule <Icon name="arrow" /></Link>} />
          {data?.planned.length ? (
            <ul className="rows planned">
              {data.planned.slice(0, 5).map((o) => {
                const d = o.scheduled ? new Date(`${o.scheduled.date}T12:00:00Z`) : null;
                return (
                  <li key={o.id}>
                    <div className="datebox">
                      {d ? (<><b className="num">{d.getUTCDate()}</b><span>{d.toLocaleDateString('en-ZA', { timeZone: 'UTC', month: 'short' })}</span></>) : (<><b><Icon name="calendar" /></b><span>TBC</span></>)}
                    </div>
                    <div className="grow">
                      <Link to={`/outages/${o.id}`} className="t">{nice(o.title)}</Link>
                      <div className="small muted">{o.scheduled?.from ? `${o.scheduled.from}–${o.scheduled.to} · ` : ''}{prettySdc(o.sdc)}{o.localities?.length ? ` · ${o.localities.slice(0, 2).map((l) => nice(l.canonicalName)).join(', ')}` : ''}</div>
                    </div>
                    <Icon name="chevron" />
                  </li>
                );
              })}
            </ul>
          ) : data ? <EmptyState icon="calendar" title="Nothing scheduled">No planned maintenance has been announced.</EmptyState> : <Skeleton h={160} />}
        </section>

      </div>
    </>
  );
}
