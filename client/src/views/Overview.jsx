import { Link } from 'react-router-dom';
import Icon from '../components/Icon.jsx';
import MyArea from '../components/MyArea.jsx';
import RefreshButton from '../components/RefreshButton.jsx';
import OutageCard from '../components/OutageCard.jsx';
import SearchBox from '../components/SearchBox.jsx';
import { BarList, ColumnChart, StatTile } from '../components/charts.jsx';
import { CardSkeleton, EmptyState, ErrorState, Freshness, InfoTip, SectionHead, Skeleton, StatusBadge } from '../components/ui.jsx';
import { nice, prettySdc, statusMeta, timeAgo, useApi } from '../lib/api.js';
import { useDocumentTitle, useTick } from '../lib/hooks.js';

function Feed({ items }) {
  if (!items.length) return <p className="muted card-pad">No updates yet.</p>;
  return (
    <ul className="feed">
      {items.map((u, i) => {
        const m = statusMeta(u.status);
        return (
          <li key={`${u.outageId}-${u.externalId}-${i}`}>
            <div className="meta">
              <span className={`badge tone-${m.tone}`} style={{ padding: '2px 8px', fontSize: 11.5 }}><Icon name={m.icon} />{m.label}</span>
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

  const c = data?.counts;
  const behindHrs = data?.lastPostAt ? (Date.now() - new Date(data.lastPostAt).getTime()) / 3_600_000 : 0;

  return (
    <>
      <section className="hero">
        <div className="container hero-grid">
          <div>
            <span className="eyebrow"><Icon name="bolt" /> Johannesburg · from City Power's posts on X</span>
            <h1>Is your power out?</h1>
            <p className="lede">City Power posts a lot. GridWatch reads every post and image, then turns them into one clear picture for each outage.</p>
            <div className="search-wrap"><SearchBox placeholder="Search your suburb, e.g. Fourways" /></div>
            <div className="row" style={{ marginTop: 16, gap: 18, alignItems: 'flex-start' }}>
              <Freshness lastPostAt={data?.lastPostAt} />
            </div>
            <div style={{ marginTop: 12 }}><RefreshButton /></div>
          </div>
          <MyArea />
        </div>
      </section>

      <div className="container">
        {behindHrs > 6 && (
          <div className="notice" role="status" style={{ marginTop: 22 }}>
            <Icon name="clock" />
            <div><b>This may be out of date.</b> The newest City Power post we have is {timeAgo(data.lastPostAt)}. Check <a className="link" href="https://x.com/CityPowerJhb" target="_blank" rel="noreferrer">@CityPowerJhb</a> for anything newer.</div>
          </div>
        )}

        {error && !data && <div style={{ marginTop: 24 }}><ErrorState error={error} /></div>}

        <div className="kpis" style={behindHrs > 6 ? { marginTop: 22 } : undefined}>
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

        <div className="two-col section">
          <section aria-labelledby="live-h">
            <SectionHead
              id="live-h"
              title="Live outages"
              sub="Most recently updated first"
              action={<Link to="/outages?status=live" className="link">View all <Icon name="arrow" /></Link>}
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

          <aside aria-labelledby="feed-h">
            <SectionHead id="feed-h" title="Latest updates" sub="Straight from City Power, in one line" />
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
              {data ? (
                <BarList
                  unit="outages"
                  empty="No outages in progress."
                  items={data.bySdc.filter((s) => s.live + s.partial > 0).map((s) => ({ label: prettySdc(s.sdc), value: s.live + s.partial, to: `/outages?status=live&sdc=${encodeURIComponent(s.sdc)}` }))}
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

        <section className="section" aria-labelledby="legend-h">
          <SectionHead id="legend-h" title="How to read the colours" sub="Every status has a colour, an icon and a name, so it never relies on colour alone" />
          <div className="card card-pad">
            <div className="cols-3" style={{ gap: 18 }}>
              {['ACTIVE', 'PARTIALLY_RESTORED', 'RESTORED', 'PLANNED', 'STALE'].map((s) => (
                <div key={s} className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
                  <StatusBadge status={s} />
                  <span className="small muted">{{
                    ACTIVE: 'City Power has reported a fault and repairs are not finished.',
                    PARTIALLY_RESTORED: 'Some suburbs have power again; others are still waiting.',
                    RESTORED: 'City Power reported that supply is back.',
                    PLANNED: 'Scheduled maintenance with an announced date.',
                    STALE: `No news for ${2} days. It may be fixed, but City Power hasn't said.`,
                  }[s]}</span>
                </div>
              ))}
              <div className="small muted" style={{ alignSelf: 'center' }}>Unsure about a term? See <Link to="/about" className="link">how GridWatch works</Link>.</div>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}

