import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Icon from '../components/Icon.jsx';
import MicroLegend from '../components/MicroLegend.jsx';
import MyArea from '../components/MyArea.jsx';
import RefreshButton from '../components/RefreshButton.jsx';
import OutageCard from '../components/OutageCard.jsx';
import SearchBox from '../components/SearchBox.jsx';
import { BarList, ColumnChart, StatTile } from '../components/charts.jsx';
import { CardSkeleton, EmptyState, ErrorState, Freshness, InfoTip, SectionHead, Skeleton } from '../components/ui.jsx';
import { nice, prettySdc, statusMeta, timeAgo, useApi } from '../lib/api.js';
import { useDocumentTitle, useTick } from '../lib/hooks.js';
import { isNewSince } from '../lib/newness.js';
import { useRefresh } from '../lib/refresh.js';

function Feed({ items }) {
  const { lastBatch } = useRefresh();
  if (!items.length) return <p className="muted card-pad">No updates yet.</p>;
  return (
    <ul className="feed">
      {items.map((u, i) => {
        const m = statusMeta(u.status);
        return (
          <li key={`${u.outageId}-${u.externalId}-${i}`}>
            <div className="meta">
              <span className={`badge tone-${m.tone}`} style={{ padding: '2px 8px', fontSize: 11.5 }}><Icon name={m.icon} />{m.label}</span>
              {isNewSince(u.ingestedAt, lastBatch) && <span className="new-pill">New</span>}
              <span>{timeAgo(u.postedAt)}</span>
              {u.sdc && <span>· {prettySdc(u.sdc)}</span>}
            </div>
            <Link to={`/outages/${u.outageId}`} className="t">{nice(u.title)}</Link>
            {u.summary && <p>{u.summary}</p>}
          </li>
        );
      })}
    </ul>
  );
}

export default function Overview() {
  useDocumentTitle();
  useTick(60_000);
  const { data, error, loading } = useApi('/v1/overview', { refreshMs: 60_000 });
  // wide screens: a side column you can fold away; phones: a drawer that starts closed
  const [feedOpen, setFeedOpen] = useState(() => typeof matchMedia !== 'function' || !matchMedia('(max-width: 960px)').matches);
  useEffect(() => {
    const esc = (e) => e.key === 'Escape' && matchMedia('(max-width: 960px)').matches && setFeedOpen(false);
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, []);

  const c = data?.counts;
  const behindHrs = data?.lastPostAt ? (Date.now() - new Date(data.lastPostAt).getTime()) / 3_600_000 : 0;

  return (
    <>
      <section className="hero tight">
        <div className="container">
          <span className="eyebrow"><Icon name="bolt" /> Johannesburg · from City Power's posts on X</span>
          <div className="hero-head">
            <h1>Is your power out?</h1>
            <p className="lede">City Power posts a lot. GridWatch reads every post and image, then turns them into one clear picture for each outage.</p>
          </div>
          <div className="search-wrap"><SearchBox placeholder="Search your suburb, e.g. Fourways" /></div>
          <div className="hero-meta">
            <Freshness lastPostAt={data?.lastPostAt} />
            <RefreshButton />
          </div>
          {behindHrs > 6 && (
            <div className="notice" role="status">
              <Icon name="clock" />
              <div><b>This may be out of date.</b> The newest City Power post we have is {timeAgo(data.lastPostAt)}. Check <a className="link" href="https://x.com/CityPowerJhb" target="_blank" rel="noreferrer">@CityPowerJhb</a> for anything newer.</div>
            </div>
          )}
          <MyArea banner />
          {error && !data && <div style={{ marginTop: 16 }}><ErrorState error={error} /></div>}
          <div className="kpis">
            {loading && !data ? (
              [0, 1, 2, 3].map((i) => <div key={i} className="card tile"><Skeleton h={14} w="50%" /><Skeleton h={38} w="40%" /><Skeleton h={12} w="70%" /></div>)
            ) : c && (
              <>
                <StatTile hero to="/outages?status=live" tone="live" icon="alert" label="Outages right now" value={c.live} hint="Power is out here" spark={data.daily.map((d) => d.count)} />
                <StatTile to="/outages?status=live" tone="partial" icon="half" label="Being restored" value={c.partial} hint="Some suburbs are back on" />
                <StatTile to="/outages?status=restored" tone="good" icon="check" label="Restored in 24 h" value={c.restored24h} hint="Power is back on" />
                <StatTile to="/planned" tone="plan" icon="calendar" label="Planned work ahead" value={c.plannedUpcoming} hint="Scheduled maintenance" />
              </>
            )}
          </div>
        </div>
      </section>

      <div className="container">
        <MicroLegend />
        <div className={`two-col section live-layout${feedOpen ? '' : ' feed-closed'}`}>
          <section aria-labelledby="live-h">
            <SectionHead
              id="live-h"
              title="Live outages"
              sub="Most recently updated first"
              action={<span className="row" style={{ gap: 12 }}><button type="button" className="btn small feed-toggle" aria-expanded={feedOpen} aria-controls="feed-panel" onClick={() => setFeedOpen((o) => !o)}><Icon name="list" /> Latest updates <span className="faint">{feedOpen ? 'Hide' : 'Show'}</span></button><Link to="/outages?status=live" className="link">View all <Icon name="arrow" /></Link></span>}
            />
            {loading && !data ? (
              <CardSkeleton n={4} />
            ) : data?.live.length ? (
              <div className="grid-cards" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 300px), 1fr))' }}>
                {data.live.slice(0, 6).map((o) => <OutageCard key={o.id} outage={o} />)}
              </div>
            ) : (
              <EmptyState icon="check" title="No live outages">City Power hasn't reported any active outages in the last two days. That's good news.</EmptyState>
            )}
          </section>

          <div className={`drawer-back${feedOpen ? ' open' : ''}`} onClick={() => setFeedOpen(false)} aria-hidden="true" />
          <aside id="feed-panel" className={`feed-panel${feedOpen ? ' open' : ''}`} aria-labelledby="feed-h">
            <SectionHead id="feed-h" title="Latest updates" sub="Straight from City Power, in one line" action={<span className="row" style={{ gap: 10 }}><Link to="/activity" className="link">What changed <Icon name="arrow" /></Link><button type="button" className="icon-btn drawer-close" onClick={() => setFeedOpen(false)} aria-label="Close latest updates"><Icon name="close" /></button></span>} />
            <div className="card">
              {loading && !data ? <div className="card-pad stack">{[0, 1, 2, 3].map((i) => <Skeleton key={i} h={44} />)}</div> : <Feed items={data?.latestUpdates ?? []} />}
            </div>
          </aside>
        </div>

        <section className="section" aria-labelledby="charts-h">
          <SectionHead id="charts-h" title="The bigger picture" sub="Where outages are and how busy it's been" />
          <div className="cols-2">
            <div className="card chart-card">
              <div className="row between">
                <h3>Outages in progress by service centre</h3>
                <InfoTip label="a service centre"><b>SDC = Service Delivery Centre.</b> City Power splits Johannesburg into about ten areas, each run from a local centre that sends out repair teams.</InfoTip>
              </div>
              <p className="sub">Live and partly-restored outages right now</p>
              <MicroLegend items={['ACTIVE', 'PARTIALLY_RESTORED']} help={false} />
              {data ? (
                <BarList
                  unit="outages"
                  empty="No outages in progress."
                  items={data.bySdc.filter((s) => s.live + s.partial > 0).map((s) => ({ label: prettySdc(s.sdc), value: s.live + s.partial, segments: [{ value: s.live, tone: 'live' }, { value: s.partial, tone: 'partial' }], to: `/outages?status=live&sdc=${encodeURIComponent(s.sdc)}` }))}
                />
              ) : <Skeleton h={160} />}
            </div>
            <div className="card chart-card">
              <h3>Outages reported per day</h3>
              <p className="sub">Last 10 days, unplanned faults only</p>
              {data ? <ColumnChart data={data.daily} /> : <Skeleton h={170} />}
            </div>
          </div>
        </section>

        <section className="section" aria-labelledby="plan-h">
          <SectionHead id="plan-h" title="Planned maintenance" sub="Scheduled power interruptions coming up" action={<Link to="/planned" className="link">See the schedule <Icon name="arrow" /></Link>} />
          {data?.planned.length ? (
            <div className="card">
              <ul className="rows">
                {data.planned.slice(0, 4).map((o) => {
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
            </div>
          ) : data ? <EmptyState icon="calendar" title="Nothing scheduled">No planned maintenance has been announced.</EmptyState> : <Skeleton h={120} />}
        </section>
      </div>
    </>
  );
}

