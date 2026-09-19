import { Link } from 'react-router-dom';
import { ROLE, fmtDay, fmtTime, nice, plural, prettySdc, timeAgo, useApi } from '../lib/api.js';
import Icon from './Icon.jsx';
import { StatusBadge } from './ui.jsx';

function OutageChange({ o }) {
  const shown = o.updates.slice(-3);
  const hidden = o.updates.length - shown.length;
  return (
    <li className="chg">
      <div className="row between" style={{ gap: 8, alignItems: 'flex-start' }}>
        <Link to={`/outages/${o.id}`} className="t">{nice(o.title)}</Link>
        <StatusBadge status={o.status} kind={o.kind} />
      </div>
      {o.sdc && <div className="small faint">{prettySdc(o.sdc)}</div>}
      <ul className="chg-updates">
        {hidden > 0 && <li className="small faint">+{plural(hidden, 'earlier update')}</li>}
        {shown.map((u, i) => (
          <li key={i}>
            <span className={`chg-dot tone-${(ROLE[u.role] ?? ROLE.UPDATE).tone}`} />
            <div>
              <div className="small faint">{(ROLE[u.role] ?? ROLE.UPDATE).label} · {fmtDay(u.postedAt)}, {fmtTime(u.postedAt)}</div>
              <div>{u.summary || 'Update from City Power.'} <a className="link small" href={u.url} target="_blank" rel="noreferrer">post <Icon name="external" /></a></div>
            </div>
          </li>
        ))}
      </ul>
    </li>
  );
}

/** Everything the engine did since a moment in time: new outages, updated outages, and what it ignored. */
export default function WhatChanged({ since, label }) {
  const { data, error, loading } = useApi(since ? `/v1/changes?since=${encodeURIComponent(since)}` : null);
  if (!since) return <p className="muted">Nothing to compare against yet.</p>;
  if (loading && !data) return <p className="muted" aria-busy="true">Loading changes…</p>;
  if (error && !data) return <p className="muted">Couldn't load the changes.</p>;

  const { counts: c, outages } = data;
  const fresh = outages.filter((o) => o.isNew);
  const updated = outages.filter((o) => !o.isNew);
  const ignored = c.replies + c.notices;

  return (
    <div className="stack" style={{ gap: 18 }}>
      <p className="small muted">
        {label ?? `Since ${timeAgo(data.since)}`}: <b>{plural(c.newPosts, 'new post')}</b> read
        {ignored > 0 && <> · {ignored} not about a specific outage (customer replies and general notices)</>}
        {c.needsReview > 0 && <> · <b>{c.needsReview}</b> need a human look</>}.
      </p>
      {outages.length === 0 && (
        <div className="card card-pad muted">No outages were opened or updated in this period.</div>
      )}
      {fresh.length > 0 && (
        <section>
          <h3 className="chg-h"><Icon name="alert" /> New outages <span className="badge tone-live">{fresh.length}</span></h3>
          <ul className="chg-list">{fresh.map((o) => <OutageChange key={o.id} o={o} />)}</ul>
        </section>
      )}
      {updated.length > 0 && (
        <section>
          <h3 className="chg-h"><Icon name="clock" /> Updated outages <span className="badge tone-plan">{updated.length}</span></h3>
          <ul className="chg-list">{updated.map((o) => <OutageChange key={o.id} o={o} />)}</ul>
        </section>
      )}
    </div>
  );
}
