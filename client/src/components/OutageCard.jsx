import { useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { firstSentence, fmtDay, nice, plural, prettySdc, statusMeta, timeAgo } from '../lib/api.js';
import { isNewSince } from '../lib/newness.js';
import { useRefresh } from '../lib/refresh.js';
import Icon from './Icon.jsx';
import { Chip, Meter, ServiceIdentity, StatusBadge } from './ui.jsx';

export function scheduleLabel(s) {
  if (!s) return null;
  const d = new Date(`${s.date}T12:00:00Z`);
  const day = d.toLocaleDateString('en-ZA', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
  return s.from ? `${day} · ${s.from}–${s.to}` : day;
}

/** Two lines of the latest update; "Read more" appears only when there is more to read. */
function Latest({ text }) {
  const ref = useRef(null);
  const [open, setOpen] = useState(false);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !open) setClipped(el.scrollHeight > el.clientHeight + 1);
  }, [text, open]);
  return (
    <div>
      <p ref={ref} className={`latest${open ? ' open' : ''}`}>{text}</p>
      {(clipped || open) && (
        <button type="button" className="more-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? 'Show less' : 'Read more'}
        </button>
      )}
    </div>
  );
}

/** How long an outage has run, or how long it ran, in the fewest words. */
function span(o) {
  const end = o.status === 'RESTORED' && o.restoredAt ? new Date(o.restoredAt) : new Date();
  const mins = Math.max(0, Math.round((end - new Date(o.startedAt)) / 60_000));
  if (mins < 60) return `${mins} min`;
  if (mins < 60 * 48) return `${Math.round(mins / 60)} h`;
  return `${Math.round(mins / 1440)} d`;
}

/** One outage as a line in a ledger: status, what is happening, who reported it, how long, when last heard. */
export function OutageRow({ outage: o, showService }) {
  const m = statusMeta(o.status, o.service, o.waterState);
  const { lastBatch } = useRefresh();
  const fresh = isNewSince(o.latest?.ingestedAt, lastBatch);
  const headline = o.latest?.summary || firstSentence(o.cause ? `Cause: ${o.cause}.` : '');
  const areas = (o.localities ?? []).map((l) => nice(l.canonicalName));
  return (
    <li className={`lrow tone-${m.tone}`}>
      <div className="lrow-status">{showService && <ServiceIdentity service={o.service} compact />}<StatusBadge status={o.status} kind={o.kind} service={o.service} waterState={o.waterState} /></div>
      <div className="lrow-main">
        <h3><Link to={`/outages/${o.id}`} className="stretch">{nice(o.title)}</Link>{fresh && <span className="new-pill" title="Updated in the latest fetch">New</span>}</h3>
        {headline && <p className="lrow-sum">{headline}</p>}
        {areas.length > 0 && <p className="lrow-areas">{areas.slice(0, 4).join(' · ')}{areas.length > 4 ? ` · +${areas.length - 4}` : ''}</p>}
        {o.restorationPercent != null && o.status !== 'RESTORED' && o.status !== 'PLANNED' && <Meter value={o.restorationPercent} />}
      </div>
      <div className="lrow-sdc">{o.sdc ? prettySdc(o.sdc) : ''}</div>
      <div className="lrow-time"><b className="num">{span(o)}</b><span>{o.status === 'RESTORED' ? 'duration' : 'so far'}</span></div>
      <div className="lrow-time"><b className="num">{timeAgo(o.lastUpdateAt)}</b><span>last update</span></div>
    </li>
  );
}

/** `showService` adds the Power/Water tag, for pages that mix both services. */
export default function OutageCard({ outage: o, compact, showService }) {
  const m = statusMeta(o.status, o.service, o.waterState);
  const { lastBatch } = useRefresh();
  const fresh = isNewSince(o.latest?.ingestedAt, lastBatch);
  const areas = o.localities ?? [];
  const cap = compact ? 4 : 8;
  const shown = areas.slice(0, cap);
  const likely = areas.length === 0 ? o.likelyAreas ?? [] : [];
  const headline = o.latest?.summary || firstSentence(o.cause ? `Cause: ${o.cause}.` : '');
  const planned = o.kind === 'PLANNED' && o.scheduled;

  return (
    <article className={`card ocard tone-${m.tone} service-${o.service === 'WATER' ? 'water' : 'power'}${compact ? ' compact' : ''}`}>
      <div className="row between" style={{ gap: 8 }}>
        <span className="outage-card-status">{showService && <ServiceIdentity service={o.service} compact />}<StatusBadge status={o.status} kind={o.kind} service={o.service} waterState={o.waterState} /></span>
        <span className="row small faint" style={{ gap: 8 }}>{fresh && <span className="new-pill" title="Updated in the latest fetch">New update</span>}{o.sdc ? prettySdc(o.sdc) : ''}</span>
      </div>
      <h3><Link to={`/outages/${o.id}`} className="stretch">{nice(o.title)}</Link></h3>
      {planned && (
        <div className="row small" style={{ gap: 6, fontWeight: 500 }}>
          <Icon name="calendar" /> {scheduleLabel(o.scheduled)}
        </div>
      )}
      {headline && <Latest text={headline} />}
      {o.status !== 'RESTORED' && o.restorationPercent != null && o.status !== 'PLANNED' && <Meter value={o.restorationPercent} />}
      {(shown.length > 0 || likely.length > 0) && (
        <div className="chips scroll">
          {shown.map((l) => <Chip key={l.id} to={`/suburb/${l.id}`} restored={l.restored}>{nice(l.canonicalName)}</Chip>)}
          {areas.length > shown.length && <span className="small faint more-count">+{areas.length - shown.length} more</span>}
          {likely.slice(0, 3).map((l) => <Chip key={l.id} to={`/suburb/${l.id}`} soft title="Likely area, based on the equipment involved">{nice(l.canonicalName)}</Chip>)}
        </div>
      )}
      <div className="foot">
        <span>
          {o.status === 'PLANNED' ? `Announced ${fmtDay(o.startedAt)}` : `Updated ${timeAgo(o.lastUpdateAt)}`}
          {o.postCount ? ` · ${plural(o.postCount, 'update')}` : ''}
        </span>
        <Icon name="arrow" />
      </div>
    </article>
  );
}
