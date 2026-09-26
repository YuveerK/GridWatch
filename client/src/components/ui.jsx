import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { statusMeta, timeAgo } from '../lib/api.js';
import { useTick } from '../lib/hooks.js';
import { useUtility } from '../lib/municipality.jsx';
import Icon from './Icon.jsx';
import ServiceIdentity from './ServiceIdentity.jsx';

/** Lifecycle status as a badge. For Water, pass `waterState` so a live incident says what customers face ("Low pressure",
 * "Recovering") instead of a blanket "Supply interrupted". */
export function StatusBadge({ status, kind, large, service, waterState }) {
  const m = statusMeta(status, service, waterState);
  const label = kind === 'PLANNED' && status !== 'PLANNED' && status !== 'CANCELLED' ? `Planned · ${m.label.toLowerCase()}` : m.label;
  return (
    <span className={`badge tone-${m.tone}${large ? ' lg' : ''}`} title={m.long}>
      <Icon name={m.icon} />
      {label}
    </span>
  );
}

export { ServiceIdentity };

/** Suburb / equipment chip. `to` makes it a link. */
export function Chip({ to, children, restored, soft, title }) {
  const cls = `chip${soft ? ' soft' : ''}`;
  const inner = (
    <>
      {restored && <Icon name="check" />}
      {children}
    </>
  );
  return to ? (
    <Link to={to} className={cls} title={title}>{inner}</Link>
  ) : (
    <span className={cls} title={title}>{inner}</span>
  );
}

export function Meter({ value, label = 'restored' }) {
  return (
    <div className="meter-row" role="img" aria-label={`${value}% ${label}`}>
      <div className="meter"><i style={{ width: `${Math.min(100, Math.max(0, value))}%` }} /></div>
      <b className="num">{value}%</b>
    </div>
  );
}

export function Skeleton({ h = 18, w = '100%', r }) {
  return <div className="skeleton" style={{ height: h, width: w, borderRadius: r }} aria-hidden="true" />;
}

export function CardSkeleton({ n = 3 }) {
  return (
    <div className="grid-cards" aria-busy="true" aria-label="Loading">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="card card-pad stack" style={{ gap: 12 }}>
          <Skeleton h={22} w="40%" r={999} />
          <Skeleton h={22} w="80%" />
          <Skeleton h={14} />
          <Skeleton h={14} w="70%" />
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ icon = 'check', title, children, action }) {
  return (
    <div className="card empty">
      <div className="ico"><Icon name={icon} /></div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action && <div style={{ marginTop: 16 }}>{action}</div>}
    </div>
  );
}

export function ErrorState({ error, retry }) {
  return (
    <div className="card empty" role="alert">
      <div className="ico"><Icon name="alert" /></div>
      <h3>We couldn't load this</h3>
      <p>{error?.message === 'Not found' ? "We couldn't find what you're looking for." : 'Check your connection and try again. If it keeps happening, the service may be restarting.'}</p>
      {retry && <div style={{ marginTop: 16 }}><button className="btn" onClick={retry}>Try again</button></div>}
    </div>
  );
}

export function SectionHead({ title, sub, action, id }) {
  return (
    <div className="section-head">
      <div>
        <h2 id={id}>{title}</h2>
        {sub && <p>{sub}</p>}
      </div>
      {action}
    </div>
  );
}

export function Crumbs({ items }) {
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      {items.map((it, i) => (
        <span key={i} className="row" style={{ gap: 6 }}>
          {i > 0 && <Icon name="chevron" />}
          {it.to ? <Link to={it.to}>{it.label}</Link> : <span aria-current="page">{it.label}</span>}
        </span>
      ))}
    </nav>
  );
}

/** A "?" that explains a term in plain language. */
export function InfoTip({ label, children }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    const esc = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <span className="infotip" ref={ref}>
      <button type="button" aria-label={`What is ${label}?`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>?</button>
      {open && <span className="pop" role="tooltip">{children}</span>}
    </span>
  );
}

/** How recent the newest post from the utility in scope is: the honest "is this live?" signal. */
export function Freshness({ lastPostAt }) {
  useTick();
  const { utility, single } = useUtility();
  if (!lastPostAt) return null;
  const hrs = (Date.now() - new Date(lastPostAt).getTime()) / 3_600_000;
  const stale = hrs > 3;
  return (
    <span className="fresh" title={`Time of the newest post we have read from ${utility}'s account on X`}>
      <span className={`dot${stale ? ' warn' : ''}`} />
      Latest {single ? `${utility} ` : ''}post {timeAgo(lastPostAt)}
    </span>
  );
}
