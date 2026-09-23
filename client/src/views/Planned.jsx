import { Link } from 'react-router-dom';
import Icon from '../components/Icon.jsx';
import { CardSkeleton, EmptyState, ErrorState, StatusBadge } from '../components/ui.jsx';
import { dayDiff, nice, prettySdc, useApi } from '../lib/api.js';
import { useDocumentTitle } from '../lib/hooks.js';
import { useMunicipality, withMunicipality } from '../lib/municipality.jsx';

const GROUPS = [
  ['today', 'Today', (d) => d === 0],
  ['tomorrow', 'Tomorrow', (d) => d === 1],
  ['week', 'This week', (d) => d > 1 && d <= 7],
  ['later', 'Later', (d) => d > 7],
  ['past', 'Recently passed', (d) => d < 0],
];

function Row({ o }) {
  const d = o.scheduled ? new Date(`${o.scheduled.date}T12:00:00Z`) : null;
  return (
    <li>
      <div className="datebox">
        {d ? (<><b className="num">{d.getUTCDate()}</b><span>{d.toLocaleDateString('en-ZA', { timeZone: 'UTC', month: 'short' })}</span></>) : (<><b><Icon name="calendar" /></b><span>TBC</span></>)}
      </div>
      <div className="grow">
        <Link to={`/outages/${o.id}`} className="t">{nice(o.title)}</Link>
        <div className="small muted">
          {d && <b>{d.toLocaleDateString('en-ZA', { timeZone: 'UTC', weekday: 'long' })}{o.scheduled.from ? ` ${o.scheduled.from}–${o.scheduled.to}` : ''}</b>}
          {d ? ' · ' : ''}{prettySdc(o.sdc)}
        </div>
        {o.latest?.summary && <p className="small muted" style={{ marginTop: 3 }}>{o.latest.summary}</p>}
        {o.localities.length > 0 && <div className="chips" style={{ marginTop: 8 }}>{o.localities.slice(0, 4).map((l) => <Link key={l.id} to={`/suburb/${l.id}`} className="chip">{nice(l.canonicalName)}</Link>)}{o.localities.length > 4 && <span className="small faint">+{o.localities.length - 4} more</span>}</div>}
      </div>
      <Icon name="chevron" />
    </li>
  );
}

export default function Planned() {
  useDocumentTitle('Planned maintenance');
  const { param: muniParam, name } = useMunicipality();
  const { data, error, loading } = useApi(withMunicipality('/v1/outages?status=PLANNED&limit=100&sort=updated', muniParam));

  const rows = data?.data ?? [];
  const dated = rows.filter((o) => o.scheduled).map((o) => ({ o, d: dayDiff(o.scheduled.date) }));
  const undated = rows.filter((o) => !o.scheduled);

  return (
    <div className="container page">
      <header className="page-head">
        <h1>Planned maintenance</h1>
        <p>Scheduled power interruptions{name ? ` announced for ${name}` : ' that have been announced'}. Dates and times come from the utility's own posts.</p>
      </header>
      {error && !data && <ErrorState error={error} />}
      {loading && !data && <CardSkeleton n={3} />}
      {data && rows.length === 0 && <EmptyState icon="calendar" title="Nothing scheduled">No planned maintenance{name ? ` for ${name}` : ''} that we know of.</EmptyState>}
      {data && rows.length > 0 && (
        <>
          {GROUPS.map(([key, label, test]) => {
            const items = dated.filter((x) => test(x.d)).sort((a, b) => a.o.scheduled.date.localeCompare(b.o.scheduled.date) || (a.o.scheduled.from ?? '').localeCompare(b.o.scheduled.from ?? ''));
            if (!items.length) return null;
            return (
              <section key={key} aria-label={label}>
                <div className="group-title">{label} <span className="badge tone-plan" style={{ padding: '1px 8px' }}>{items.length}</span></div>
                <div className="card"><ul className="rows">{items.map(({ o }) => <Row key={o.id} o={o} />)}</ul></div>
              </section>
            );
          })}
          {undated.length > 0 && (
            <section aria-label="Date not stated">
              <div className="group-title">Date not stated <span className="badge tone-idle" style={{ padding: '1px 8px' }}>{undated.length}</span></div>
              <div className="card"><ul className="rows">{undated.map((o) => <Row key={o.id} o={o} />)}</ul></div>
            </section>
          )}
          <p className="small faint" style={{ marginTop: 22 }}><StatusBadge status="PLANNED" /> &nbsp;Plans can change. Check the utility's latest notice before relying on a date.</p>
        </>
      )}
    </div>
  );
}
