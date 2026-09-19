import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { STATUS, get, prettySdc, timeAgo } from './api.js';

export function StatusBadge({ status, kind }) {
  const s = STATUS[status] ?? { label: status, tone: 'muted' };
  return <span className={`badge tone-${s.tone}`}>{kind === 'PLANNED' && status !== 'PLANNED' ? `Planned · ${s.label}` : s.label}</span>;
}

export function Chip({ to, children, muted, title }) {
  const cls = `chip${muted ? ' chip-muted' : ''}`;
  return to ? (
    <Link to={to} className={cls} title={title}>{children}</Link>
  ) : (
    <span className={cls} title={title}>{children}</span>
  );
}

export function OutageCard({ outage }) {
  const areas = outage.localities ?? [];
  const shown = areas.slice(0, 6);
  return (
    <article className="card">
      <div className="card-head">
        <StatusBadge status={outage.status} kind={outage.kind} />
        <span className="muted small">{outage.sdc ? `${prettySdc(outage.sdc)} SDC · ` : ''}updated {timeAgo(outage.lastUpdateAt)}</span>
      </div>
      <h3><Link to={`/outages/${outage.id}`}>{outage.title}</Link></h3>
      {outage.status === 'STALE' && (
        <p className="small muted">No update from City Power for {timeAgo(outage.lastUpdateAt).replace(' ago', '')}. It may already be resolved.</p>
      )}
      {outage.cause && <p className="small">Cause: {outage.cause}</p>}
      {outage.restorationPercent != null && outage.status !== 'RESTORED' && (
        <div className="bar" title={`${outage.restorationPercent}% restored`}>
          <div style={{ width: `${outage.restorationPercent}%` }} />
        </div>
      )}
      {shown.length === 0 && (outage.likelyAreas?.length ?? 0) > 0 && (
        <div className="chips" title="The post named no suburb. These areas are usually served by this equipment.">
          <span className="muted small">Likely areas:</span>
          {outage.likelyAreas.slice(0, 5).map((l) => <Chip key={l.id} to={`/suburb/${l.id}`} muted>{l.canonicalName}</Chip>)}
        </div>
      )}
      {shown.length > 0 && (
        <div className="chips">
          {shown.map((l) => (
            <Chip key={l.id} to={`/suburb/${l.id}`} muted={l.restored}>{l.canonicalName}{l.restored ? ' ✓' : ''}</Chip>
          ))}
          {areas.length > shown.length && <span className="muted small">+{areas.length - shown.length} more</span>}
        </div>
      )}
    </article>
  );
}

export function Loading() {
  return <p className="empty">Loading…</p>;
}

export function ErrorBox({ error }) {
  return <p className="empty error">Something went wrong: {error.message}</p>;
}

/** Suburb search box with suggestions; selecting a suburb opens its page. */
export function SuburbSearch() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const box = useRef(null);

  useEffect(() => {
    if (q.trim().length < 2) {
      setResults([]);
      return undefined;
    }
    const t = setTimeout(() => {
      get(`/v1/localities?q=${encodeURIComponent(q)}`).then((r) => setResults(r.data)).catch(() => setResults([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const close = (e) => box.current && !box.current.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const go = (id) => {
    setOpen(false);
    setQ('');
    navigate(`/suburb/${id}`);
  };

  return (
    <div className="search" ref={box}>
      <input
        type="search"
        value={q}
        placeholder="Search your suburb, e.g. Fourways"
        aria-label="Search suburb"
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => e.key === 'Enter' && results[0] && go(results[0].id)}
      />
      {open && results.length > 0 && (
        <ul className="suggest">
          {results.map((r) => (
            <li key={r.id}>
              <button type="button" onClick={() => go(r.id)}>
                {r.name} {r.region && <span className="muted small">Region {r.region}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
