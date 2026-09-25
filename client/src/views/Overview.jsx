import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import Icon from '../components/Icon.jsx';
import MyArea from '../components/MyArea.jsx';
import RefreshButton from '../components/RefreshButton.jsx';
import SearchBox from '../components/SearchBox.jsx';
import SyncStatus from '../components/SyncStatus.jsx';
import UpdatesFeed, { countNew, useSeenUpdates } from '../components/UpdatesFeed.jsx';
import { ColumnChart, Sparkline } from '../components/charts.jsx';
import { Chip, EmptyState, ErrorState, Freshness, Meter, SectionHead, ServiceIdentity, Skeleton, StatusBadge } from '../components/ui.jsx';
import { nice, plural, prettySdc, statusMeta, timeAgo, useApi } from '../lib/api.js';
import { useDocumentTitle, useMyArea, useTick } from '../lib/hooks.js';
import { isNewSince } from '../lib/newness.js';
import { useMunicipality, useUtility, withMunicipality } from '../lib/municipality.jsx';
import { useRefresh } from '../lib/refresh.js';

const MapView = lazy(() => import('../components/MapView.jsx'));
const LAYERS = { outages: true, equipment: false };
const TONE = { ACTIVE: 'live', PARTIALLY_RESTORED: 'partial' };
const ORDER = { ACTIVE: 0, PARTIALLY_RESTORED: 1 };

/** How long an outage has been running, in the fewest words. */
function since(startedAt) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(startedAt)) / 60_000));
  if (mins < 60) return `${mins} min`;
  if (mins < 60 * 48) return `${Math.round(mins / 60)} h`;
  return `${Math.round(mins / 1440)} d`;
}

/** ▲ 3 vs yesterday: a number needs something to be compared with. */
function Delta({ now, before, unit = 'vs yesterday' }) {
  if (now == null || before == null) return null;
  const d = now - before;
  if (d === 0) return <span className="delta same">No change {unit}</span>;
  return <span className="delta">{d > 0 ? '▲' : '▼'} {Math.abs(d)} {unit}</span>;
}

function Metric({ label, value, hint, to, tone, spark, delta, loading }) {
  return (
    <Link to={to} className={`metric tone-${tone}`}>
      <span className="metric-label"><i className="metric-dot" />{label}</span>
      {loading ? <Skeleton h={40} w="55%" /> : <span className="metric-value num">{value ?? '–'}</span>}
      <span className="metric-foot">{delta ?? <span className="delta same">{hint}</span>}</span>
      {spark && <span className="metric-spark"><Sparkline values={spark} w={92} h={34} /></span>}
    </Link>
  );
}

/** One live outage in the stage list. Selecting it frames it on the map and opens the detail underneath. */
function StageRow({ o, selected, onSelect }) {
  const { lastBatch } = useRefresh();
  const m = statusMeta(o.status, o.service);
  const fresh = isNewSince(o.latestIngestedAt, lastBatch);
  const areas = o.places.filter((p) => !p.restored).map((p) => nice(p.name));
  return (
    <li className={`srow tone-${m.tone}${selected ? ' is-selected' : ''}`} data-outage={o.id}>
      <button type="button" className="srow-btn" aria-pressed={selected} onClick={() => onSelect(selected ? null : o.id)}>
        <span className="srow-glyph" aria-hidden="true"><Icon name={m.icon} /></span>
        <span className="srow-main">
          <span className="srow-title">{nice(o.title)}{fresh && <em className="new-pill">New</em>}</span>
          <span className="srow-meta">
            <ServiceIdentity service={o.service} compact />
            <b>{m.label}</b>
            {o.sdc && <span>{prettySdc(o.sdc)}</span>}
            <span className="num">{since(o.startedAt)} so far</span>
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
  const map = useApi(withMunicipality('/v1/map', muniParam), { refreshMs: 60_000 });
  const { area } = useMyArea();
  const areaDetail = useApi(area ? `/v1/localities/${area.id}` : null);
  const areaShape = areaDetail.data?.id === area?.id ? areaDetail.data : null;
  const [selectedId, setSelectedId] = useState(null);
  const [filter, setFilter] = useState('all'); // all | ACTIVE | PARTIALLY_RESTORED
  const [tab, setTab] = useState(() => (new URLSearchParams(window.location.search).get('panel') === 'updates' ? 'updates' : 'outages')); // outages | updates (?panel=updates links straight to the feed)
  const updates = useApi(withMunicipality('/v1/updates?limit=30', muniParam), { refreshMs: 60_000 });
  const seen = useSeenUpdates();
  const newCount = seen.cleared ? 0 : countNew(updates.data?.data ?? [], seen.seenAt);

  const outages = useMemo(
    () => [...(map.data?.data ?? [])].sort((a, b) => ORDER[a.status] - ORDER[b.status] || new Date(b.lastUpdateAt) - new Date(a.lastUpdateAt)),
    [map.data],
  );
  const shown = filter === 'all' ? outages : outages.filter((o) => o.status === filter);
  const selected = outages.find((o) => o.id === selectedId) ?? null;

  const points = useMemo(() => {
    const pts = shown.flatMap((o) => o.places.map((p) => ({
      id: `${o.id}:${p.id}`, sub: p.id, oid: o.id, name: nice(p.name), lat: p.lat, lon: p.lon,
      boundary: p.boundary ?? null, inferred: p.inferred, tone: p.restored ? 'good' : TONE[o.status] ?? 'live',
      groups: [o.id], dim: Boolean(selectedId) && o.id !== selectedId, note: nice(o.title),
    })));
    if (areaShape?.lat != null && areaShape.lon != null && !pts.some((p) => p.sub === areaShape.id)) {
      pts.push({
        id: `area:${areaShape.id}`, sub: areaShape.id, oid: null, name: nice(areaShape.name), lat: areaShape.lat, lon: areaShape.lon,
        boundary: areaShape.boundary ?? null, inferred: false, tone: 'plan', groups: [], dim: Boolean(selectedId), note: 'Your saved area',
      });
    }
    return pts;
  }, [shown, selectedId, areaShape]);
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
            <Metric label={water ? 'Supply interruptions now' : 'Outages right now'} value={c?.live} to="/outages" tone="live" spark={daily.map((d) => d.count)} delta={<Delta now={today} before={yesterday} unit="vs yesterday" />} loading={loadingAll} />
            <Metric label="Being restored" value={c?.partial} to="/outages" tone="partial" hint={water ? 'Supply is returning' : 'Some suburbs are back on'} loading={loadingAll} />
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
            <MyArea banner />
          </div>
          <div className="stage-tabs" role="tablist" aria-label="Show">
            <button type="button" role="tab" aria-selected={tab === 'outages'} onClick={() => setTab('outages')}>Live outages <span className="num">{shown.length}</span></button>
            <button type="button" role="tab" aria-selected={tab === 'updates'} onClick={() => setTab('updates')}>Latest updates{newCount > 0 && <span className="tab-badge">{newCount} new</span>}</button>
          </div>
          {tab === 'updates' ? (
            <div className="stage-scroll"><UpdatesFeed all={updates.data?.data} loading={updates.loading && !updates.data} seenAt={seen.seenAt} markSeen={seen.markSeen} /></div>
          ) : (
            <>
          <div className="stage-head">
            <h2>{water ? 'Where water is interrupted' : 'Where power is out'}</h2>
            <div className="seg" role="group" aria-label="Filter">
              {[['all', 'All'], ['ACTIVE', 'Out'], ['PARTIALLY_RESTORED', 'Restoring']].map(([id, label]) => (
                <button key={id} type="button" aria-pressed={filter === id} onClick={() => { setFilter(id); setSelectedId(null); }}>{label}</button>
              ))}
            </div>
          </div>
          {error && !data && <ErrorState error={error} />}
          {map.loading && !map.data ? (
            <div className="stage-skeleton" aria-busy="true">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} h={62} />)}</div>
          ) : shown.length ? (
            <ul className="slist">{shown.map((o) => <StageRow key={o.id} o={o} selected={o.id === selectedId} onSelect={setSelectedId} />)}</ul>
          ) : (
            <EmptyState icon="check" title="No live outages">{Utility} hasn't reported any active outages in the last two days. That's good news.</EmptyState>
          )}
          <Link to="/outages" className="stage-more link">All outages, planned and restored <Icon name="arrow" /></Link>
            </>
          )}
        </aside>
        <div className="stage-map">
          <Suspense fallback={<div className="map-fallback" />}>
            <MapView points={points} layers={LAYERS} height="100%" focus={focus} onPickSuburb={pick} onPickCluster={pickCluster} onClear={() => setSelectedId(null)} label="Map of suburbs with an outage right now" />
          </Suspense>
          {selected && (
            <div className="map-pick">
              <button type="button" className="map-pick-x" aria-label="Clear selection" onClick={() => setSelectedId(null)}><Icon name="close" /></button>
              <StatusBadge status={selected.status} service={selected.service} />
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
          <div className="map-key" aria-hidden="true">
            {areaShape && <span><i className="key-dot tone-plan" /> Your area</span>}
            <span><i className="key-dot tone-live" /> {water ? 'Supply interrupted' : 'Power out'}</span>
            <span><i className="key-dot tone-partial" /> Being restored</span>
            <span><i className="key-dot tone-good" /> {water ? 'Supply restored' : 'Back on'}</span>
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

        <section className="section" aria-labelledby="daily-h">
          <SectionHead id="daily-h" title={water ? 'Water interruptions reported per day' : 'Outages reported per day'} sub="Last 10 days, unplanned incidents only" />
          {data ? <ColumnChart data={data.daily} /> : <Skeleton h={170} />}
        </section>
      </div>
    </>
  );
}
