import { Link } from 'react-router-dom';
import { FAULT_LINE, dayDiff, duration, fmtDay, timeAgo } from '../lib/api.js';
import Icon from './Icon.jsx';
import { scheduleLabel } from './OutageCard.jsx';

/** Turn a suburb's outages into one plain answer to "is my power out?". */
export function computeAnswer(name, outages = [], possible = []) {
  const active = outages.filter((o) => o.status === 'ACTIVE');
  const partial = outages.filter((o) => o.status === 'PARTIALLY_RESTORED');
  const maybe = possible.filter((o) => o.status === 'ACTIVE' || o.status === 'PARTIALLY_RESTORED');
  const planned = outages.filter((o) => o.status === 'PLANNED' && (!o.scheduled || dayDiff(o.scheduled.date) >= 0));
  const justRestored = outages.filter((o) => o.status === 'RESTORED' && o.restoredAt && Date.now() - new Date(o.restoredAt) < 24 * 3_600_000);

  if (active.length) return { tone: 'live', icon: 'alert', kicker: 'Right now', title: `Power outage reported in ${name}`, outage: active[0], more: active.length - 1 };
  if (partial.length) return { tone: 'partial', icon: 'half', kicker: 'Right now', title: `Power is being restored in ${name}`, outage: partial[0], more: partial.length - 1 };
  if (maybe.length) return { tone: 'partial', icon: 'alert', kicker: 'Possible', title: `There may be an outage affecting ${name}`, note: "City Power's posts didn't name your suburb, but the equipment involved usually supplies it.", outage: maybe[0], more: maybe.length - 1 };
  if (planned.length) return { tone: 'plan', icon: 'calendar', kicker: 'Coming up', title: `Planned maintenance in ${name}`, outage: planned[0], more: planned.length - 1 };
  if (justRestored.length) return { tone: 'good', icon: 'check', kicker: 'Good news', title: `Power was restored in ${name}`, outage: justRestored[0], more: 0 };
  return { tone: 'good', icon: 'check', kicker: 'Right now', title: `No outage reported for ${name}`, note: `City Power hasn't posted about an outage here recently. If your power is out, tell them: ${FAULT_LINE.phone} or ${FAULT_LINE.freephone}.`, outage: null, more: 0 };
}

export function AnswerCard({ answer, big, slim, action }) {
  const o = answer.outage;
  const detail = o?.latest?.summary || (answer.note ?? '');
  if (slim) {
    return (
      <div className={`answer slim tone-${answer.tone}`} role="status">
        <div className="ico"><Icon name={answer.icon} /></div>
        <div className="slim-text">
          <h2><span className="kicker">{answer.kicker}</span> {answer.title}</h2>
          {detail && <p title={detail}>{detail}</p>}
        </div>
        <div className="row slim-actions">
          {o && <Link to={`/outages/${o.id}`} className="btn small primary">Timeline <Icon name="arrow" /></Link>}
          {action}
        </div>
      </div>
    );
  }
  return (
    <div className={`answer tone-${answer.tone}${big ? ' big' : ''}`}>
      <div className="ico"><Icon name={answer.icon} /></div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="kicker">{answer.kicker}</div>
        <h2>{answer.title}</h2>
        {detail && <p>{detail}</p>}
        {answer.note && o && <p className="small faint">{answer.note}</p>}
        {o && (
          <div className="row small muted" style={{ marginTop: 12, gap: 14 }}>
            {o.status === 'PLANNED' && o.scheduled ? (
              <span className="row" style={{ gap: 6, fontWeight: 500 }}><Icon name="calendar" /> {scheduleLabel(o.scheduled)}</span>
            ) : o.status === 'RESTORED' ? (
              <span>Restored {timeAgo(o.restoredAt)}</span>
            ) : (
              <>
                <span>Started {fmtDay(o.startedAt)} · {duration(o.startedAt)} ago</span>
                <span>Updated {timeAgo(o.lastUpdateAt)}</span>
              </>
            )}
            {answer.more > 0 && <span>+{answer.more} more</span>}
          </div>
        )}
        <div className="row" style={{ marginTop: 14 }}>
          {o && <Link to={`/outages/${o.id}`} className="btn small primary">See full timeline <Icon name="arrow" /></Link>}
          {action}
        </div>
      </div>
    </div>
  );
}

