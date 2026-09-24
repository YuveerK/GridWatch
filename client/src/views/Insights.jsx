import { useState } from 'react';
import { Link } from 'react-router-dom';
import Icon from '../components/Icon.jsx';
import PostActivity from '../components/PostActivity.jsx';
import { EmptyState, ErrorState, SectionHead, Skeleton } from '../components/ui.jsx';
import { nice, plural, prettySdc, useApi } from '../lib/api.js';
import { useDocumentTitle } from '../lib/hooks.js';
import { useMunicipality, useUtility, withMunicipality } from '../lib/municipality.jsx';

const WINDOWS = [7, 14, 30];
// short column names for the cause-by-area grid
const SHORT = { THEFT_VANDALISM: 'Theft', EXTERNAL: 'Accident', MAINTENANCE: 'Isolation', CABLE: 'Cable', EQUIPMENT: 'Equipment', OVERLOAD: 'Overload', OTHER: 'Other', UNKNOWN: 'Not stated' };
const pct = (x) => `${Math.round(x * 100)}%`;

function hoursLabel(h) {
  if (h == null) return null;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${h < 10 ? h.toFixed(1).replace(/\.0$/, '') : Math.round(h)} h`;
  return `${Math.round(h / 24)} d`;
}

/** Each cause as a bar with its share, and (on request) the exact words the posts used for it. */
function CauseList({ causes, total }) {
  const max = Math.max(1, ...causes.map((c) => c.count));
  return (
    <ul className="causes">
      {causes.map((c) => (
        <li key={c.id} className={c.id === 'UNKNOWN' ? 'is-unknown' : undefined}>
          <details>
            <summary>
              <span className="cause-name">{c.label}</span>
              <span className="cause-bar" aria-hidden="true"><i style={{ width: `${(c.count / max) * 100}%` }} /></span>
              <span className="cause-n num">{c.count}</span>
              <span className="cause-share num">{pct(c.count / total)}</span>
            </summary>
            {c.wordings.length > 0 ? (
              <p className="cause-words">The posts said: {c.wordings.map((w) => `“${w.text}”${w.count > 1 ? ` ×${w.count}` : ''}`).join(', ')}</p>
            ) : (
              <p className="cause-words">These posts did not say what caused the outage.</p>
            )}
          </details>
        </li>
      ))}
    </ul>
  );
}

/** One row per cause, one square per day: when each kind of fault happened. */
function Trend({ rows }) {
  const days = rows[0]?.days ?? [];
  const max = Math.max(1, ...rows.flatMap((r) => r.days.map((d) => d.count)));
  return (
    <div className="strips" style={{ '--cells': days.length }}>
      <div className="strips-head"><span /><span className="num"><span>{days[0]?.date.slice(5)}</span><span>{days.at(-1)?.date.slice(5)}</span></span><span /></div>
      {rows.map((r) => {
        const total = r.days.reduce((n, d) => n + d.count, 0);
        return (
          <div key={r.id} className="strip">
            <span className="strip-name">{r.label}</span>
            <div className="strip-cells" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }} role="img" aria-label={`${r.label}: ${plural(total, 'outage')} in this period`}>
              {r.days.map((d) => (
                <i key={d.date} className={d.count ? 'on' : ''} style={d.count ? { '--level': 0.25 + 0.75 * (d.count / max) } : undefined} title={`${d.date}: ${plural(d.count, 'outage')}`} />
              ))}
            </div>
            <span className="strip-total num">{total}</span>
          </div>
        );
      })}
    </div>
  );
}

/** What the area rows are: City Power posts name a service centre, Tshwane's are grouped by region. */
function areaKind(rows) {
  const kinds = new Set(rows.flatMap((r) => Object.keys(r.filter ?? {})));
  if (kinds.has('region')) return kinds.has('sdc') ? { title: 'By service centre or region', column: 'Area' } : { title: 'By region', column: 'Region' };
  return { title: 'By service centre', column: 'Service centre' };
}

const areaLink = (filter) => `/outages?${new URLSearchParams({ ...filter, status: 'all' })}`;

/** Areas down the side, causes across the top. Darker = a bigger share of that area's outages. */
function AreaGrid({ rows, causes }) {
  const cols = causes.filter((c) => c.id !== 'UNKNOWN').slice(0, 6).map((c) => c.id);
  return (
    <div className="matrix-wrap">
      <table className="matrix">
        <thead>
          <tr>
            <th scope="col">{areaKind(rows).column}</th>
            {cols.map((id) => <th key={id} scope="col" className="num-col">{SHORT[id]}</th>)}
            <th scope="col" className="num-col">Total</th>
            <th scope="col">More than usual here</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.area}>
              <th scope="row">{r.filter ? <Link to={areaLink(r.filter)}>{prettySdc(r.area)}</Link> : prettySdc(r.area)}</th>
              {cols.map((id) => {
                const n = r.cells[id] ?? 0;
                return <td key={id} className="num-col"><span className={n ? 'heat on' : 'heat'} style={n ? { '--level': 0.15 + 0.85 * (n / r.total) } : undefined}>{n || ''}</span></td>;
              })}
              <td className="num-col num">{r.total}</td>
              <td className="stand">{r.standout ? <><b>{r.standout.label}</b> <span className="faint num">{r.standout.lift.toFixed(1)}× the overall rate</span></> : <span className="faint">Nothing stands out</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** This week against last week, per cause. Held back until there are two weeks of history to compare. */
function Weekly({ weekly, dataDays }) {
  if (!weekly.available) {
    return <p className="muted weekly-wait">The week-on-week comparison appears once there are 14 days of history and a full previous week to compare with. There are {dataDays} so far.</p>;
  }
  return (
    <table className="matrix weekly">
      <thead><tr><th scope="col">Cause</th><th scope="col" className="num-col">Last week</th><th scope="col" className="num-col">This week</th><th scope="col" className="num-col">Change</th></tr></thead>
      <tbody>
        {weekly.byCause.map((c) => {
          const d = c.thisWeek - c.lastWeek;
          return (
            <tr key={c.id}>
              <th scope="row">{c.label}</th>
              <td className="num-col num">{c.lastWeek}</td>
              <td className="num-col num">{c.thisWeek}</td>
              <td className="num-col num">{d === 0 ? '–' : `${d > 0 ? '▲' : '▼'} ${Math.abs(d)}`}</td>
            </tr>
          );
        })}
        <tr className="weekly-total"><th scope="row">All unplanned outages</th><td className="num-col num">{weekly.lastWeek}</td><td className="num-col num">{weekly.thisWeek}</td><td className="num-col num">{weekly.thisWeek - weekly.lastWeek === 0 ? '–' : `${weekly.thisWeek > weekly.lastWeek ? '▲' : '▼'} ${Math.abs(weekly.thisWeek - weekly.lastWeek)}`}</td></tr>
      </tbody>
    </table>
  );
}

/** Median hours from "reported" to "power back". A number is only shown when there are enough cases to call it typical. */
function Restore({ byCause, minimum }) {
  const max = Math.max(1, ...byCause.map((r) => r.medianHours ?? 0));
  return (
    <ul className="restore">
      {byCause.map((r) => (
        <li key={r.id}>
          <span className="restore-name">{r.label}</span>
          {r.medianHours != null ? (
            <>
              <span className="cause-bar" aria-hidden="true"><i style={{ width: `${(r.medianHours / max) * 100}%` }} /></span>
              <span className="restore-val num">{hoursLabel(r.medianHours)}</span>
            </>
          ) : (
            <span className="restore-few">Too few to call typical</span>
          )}
          <span className="restore-n num">{plural(r.n, 'case')}</span>
        </li>
      ))}
      <li className="restore-note">Median time from the first post to the post saying power is back. Shown only with at least {minimum} cases.</li>
    </ul>
  );
}

export default function Insights() {
  useDocumentTitle('Insights');
  const [days, setDays] = useState(14);
  const { param: muniParam, name } = useMunicipality();
  const { utility, Utility, single } = useUtility();
  const { data, error, loading, refreshing } = useApi(withMunicipality(`/v1/insights?days=${days}`, muniParam));

  return (
    <div className="container page">
      <header className="page-head">
        <h1>Insights{name ? ` · ${name}` : ''}</h1>
        <p>What is causing the outages, where, and how long they take to fix. Built from the causes {utility} states in its posts.</p>
      </header>

      <div className="toolbar">
        <div className="seg" role="group" aria-label="Time window">
          {WINDOWS.map((d) => <button key={d} type="button" aria-pressed={d === days} onClick={() => setDays(d)}>Last {d} days</button>)}
        </div>
        {data && <span className="small muted">History: {plural(data.dataDays, 'day')} · {plural(data.total, 'unplanned outage')} · cause stated for {plural(data.stated, 'outage')} ({pct(1 - data.unknownShare)})</span>}
      </div>

      {error && !data && <ErrorState error={error} />}
      {loading && !data && <div className="stack"><Skeleton h={260} /><Skeleton h={200} /></div>}
      {data && data.total === 0 && <EmptyState icon="search" title="No outages in this period">Try a longer window.</EmptyState>}

      {data && data.total > 0 && (
        <div className={refreshing ? 'fading' : undefined}>
          <div className="notice" role="note">
            <Icon name="info" />
            <div>Causes are <b>as stated by {utility}</b>, sorted into groups by GridWatch. A post naming a cause is not confirmation of it. Small groups over a short period are noisy, so treat differences as hints, not conclusions.</div>
          </div>

          <section className="section" aria-labelledby="cause-h">
            <SectionHead id="cause-h" title="What is causing outages" sub="Share of unplanned outages by stated cause. Open a row to see the exact wording." />
            <CauseList causes={data.causes} total={data.total} />
          </section>

          <section className="section" aria-labelledby="trend-h">
            <SectionHead id="trend-h" title="Day by day" sub="One square per day, darker means more outages of that kind began" />
            <Trend rows={data.trend} />
          </section>

          <section className="section" aria-labelledby="week-h">
            <SectionHead id="week-h" title="This week against last week" sub="Is anything getting better or worse?" />
            <Weekly weekly={data.weekly} dataDays={data.dataDays} />
          </section>

          <section className="section" aria-labelledby="area-h">
            <SectionHead id="area-h" title={areaKind(data.byArea).title} sub="How many outages of each kind, and what each area has more of than everywhere shown here" />
            <AreaGrid rows={data.byArea} causes={data.causes} />
          </section>

          <p className="history-note">This page stands on {plural(data.dataDays, 'day')} of collected posts. Differences firm up as more is collected: with only a few cases in a group, treat it as a hint.</p>

          <div className="cols-2 lower">
            <section className="section" aria-labelledby="fix-h">
              <SectionHead id="fix-h" title="How long power takes to come back" sub="Typical time by cause" />
              {data.restore.byCause.length ? <Restore byCause={data.restore.byCause} minimum={data.restore.minimum} /> : <p className="muted">No restorations recorded in this period yet.</p>}
            </section>
            <section className="section" aria-labelledby="rep-h">
              <SectionHead id="rep-h" title="Equipment that keeps failing" sub="Involved in more than one outage in this period" />
              {data.repeat.length ? (
                <ul className="repeat">
                  {data.repeat.map((n) => (
                    <li key={n.id}>
                      <div className="repeat-main">
                        <Link to={`/network/${n.id}`} className="t">{nice(n.name)}</Link>
                        <span className="small muted">{n.type.replace('_', ' ').toLowerCase()}{n.area ? ` · ${prettySdc(n.area)}` : ''}</span>
                        <span className="small faint">{n.causes.slice(0, 2).map((c) => `${c.label.toLowerCase()} ×${c.count}`).join(', ')}</span>
                      </div>
                      <b className="repeat-n num">{n.count}×</b>
                    </li>
                  ))}
                </ul>
              ) : <p className="muted">No equipment appears in more than one outage in this period.</p>}
            </section>
          </div>

          {data.unsorted.length > 0 && (
            <details className="unsorted">
              <summary>Causes we could not sort yet ({data.unsorted.length})</summary>
              <p>These wordings are counted as “Other stated cause”. Each is a candidate for a new rule.</p>
              <ul>{data.unsorted.map((u) => <li key={u.text}>“{u.text}”{u.count > 1 ? ` ×${u.count}` : ''}</li>)}</ul>
            </details>
          )}
        </div>
      )}

      <section className="section" aria-labelledby="posts-h">
        <SectionHead id="posts-h" title={`How much ${single ? Utility : 'each utility'} posts`} sub="Posts per day by kind. Pick a day or a kind, or search, to read the posts themselves." />
        <PostActivity days={days} />
      </section>
    </div>
  );
}
