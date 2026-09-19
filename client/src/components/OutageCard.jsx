import { Link } from 'react-router-dom';
import { firstSentence, fmtDay, nice, plural, prettySdc, statusMeta, timeAgo } from '../lib/api.js';
import Icon from './Icon.jsx';
import { Chip, Meter, StatusBadge } from './ui.jsx';

export function scheduleLabel(s) {
  if (!s) return null;
  const d = new Date(`${s.date}T12:00:00Z`);
  const day = d.toLocaleDateString('en-ZA', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
  return s.from ? `${day} · ${s.from}–${s.to}` : day;
}

export default function OutageCard({ outage: o, compact }) {
  const m = statusMeta(o.status);
  const areas = o.localities ?? [];
  const shown = areas.slice(0, compact ? 2 : 3);
  const likely = areas.length === 0 ? o.likelyAreas ?? [] : [];
  const headline = o.latest?.summary || firstSentence(o.cause ? `Cause: ${o.cause}.` : '');
  const planned = o.kind === 'PLANNED' && o.scheduled;

  return (
    <article className={`card ocard tone-${m.tone}${compact ? ' compact' : ''}`}>
      <div className="row between" style={{ gap: 8 }}>
        <StatusBadge status={o.status} kind={o.kind} />
        <span className="small faint">{o.sdc ? prettySdc(o.sdc) : ''}</span>
      </div>
      <h3><Link to={`/outages/${o.id}`} className="stretch">{nice(o.title)}</Link></h3>
      {planned && (
        <div className="row small" style={{ gap: 6, fontWeight: 600 }}>
          <Icon name="calendar" /> {scheduleLabel(o.scheduled)}
        </div>
      )}
      {headline && <p className="latest">{headline}</p>}
      {o.status !== 'RESTORED' && o.restorationPercent != null && o.status !== 'PLANNED' && <Meter value={o.restorationPercent} />}
      {(shown.length > 0 || likely.length > 0) && (
        <div className="chips">
          {shown.map((l) => <Chip key={l.id} to={`/suburb/${l.id}`} restored={l.restored}>{nice(l.canonicalName)}</Chip>)}
          {areas.length > shown.length && <span className="small faint" style={{ alignSelf: 'center' }}>+{areas.length - shown.length} more</span>}
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
