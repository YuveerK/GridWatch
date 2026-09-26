import { Link } from 'react-router-dom';
import { dayDiff, duration, fmtDay, statusMeta, timeAgo, useApi } from '../lib/api.js';
import { useServicesFor, useUtility } from '../lib/municipality.jsx';
import { inService } from '../lib/service.jsx';
import Icon from './Icon.jsx';
import { scheduleLabel } from './OutageCard.jsx';
import ServiceIdentity from './ServiceIdentity.jsx';

/** "011 490 7484 or 0800 202 925" for one utility; each utility named when there are several. */
export function faultLines(contacts = []) {
  const lines = (c) => [c.contact.phone, c.contact.freephone].filter(Boolean).join(' or ');
  if (contacts.length === 1) return lines(contacts[0]);
  return contacts.map((c) => `${c.utility.replace(/^the /, '')}: ${lines(c)}`).join('; ');
}

/** Turn a suburb's outages into one plain answer to "is my power out?". `who` is useUtility() for the suburb's municipality. */
export function computeAnswer(name, outages = [], possible = [], localityId = null, who = { Utility: 'The utility', contacts: [] }, service = 'ELECTRICITY') {
  const water = service === 'WATER';
  // A partly restored outage can already be over for THIS suburb: judge each outage by the suburb's own flag, not the outage's overall status.
  const restoredHere = (o) => localityId != null && o.localities?.some((l) => l.id === localityId && l.restored);
  const live = outages.filter((o) => (o.status === 'ACTIVE' || o.status === 'PARTIALLY_RESTORED') && !restoredHere(o));
  // worst first: for Water, an incident with no supply outranks one that is recovering or on low pressure
  const rank = (o) => (statusMeta(o.status, o.service, o.waterState).tone === 'live' ? 0 : 1);
  const active = live.filter((o) => o.status === 'ACTIVE').sort((a, b) => rank(a) - rank(b));
  const partial = live.filter((o) => o.status === 'PARTIALLY_RESTORED');
  const maybe = possible.filter((o) => o.status === 'ACTIVE' || o.status === 'PARTIALLY_RESTORED');
  const planned = outages.filter((o) => o.status === 'PLANNED' && (!o.scheduled || dayDiff(o.scheduled.date) >= 0));
  const recent = (t) => t && Date.now() - new Date(t) < 24 * 3_600_000;
  const justRestored = outages.filter((o) => (o.status === 'RESTORED' && recent(o.restoredAt)) || ((o.status === 'ACTIVE' || o.status === 'PARTIALLY_RESTORED') && restoredHere(o) && recent(o.lastUpdateAt)));

  if (active.length && water) {
    const m = statusMeta(active[0].status, 'WATER', active[0].waterState);
    return { tone: m.tone, icon: m.tone === 'live' ? 'drop' : 'half', kicker: `Right now · ${m.label}`, title: `Water supply affected in ${name}`, short: m.label, outage: active[0], more: active.length - 1 };
  }
  if (active.length) return { tone: 'live', icon: 'alert', kicker: 'Right now', title: `Power outage reported in ${name}`, short: 'Outage reported', outage: active[0], more: active.length - 1 };
  if (partial.length) return { tone: 'partial', icon: 'half', kicker: 'Right now', title: `${water ? 'Water supply' : 'Power'} is being restored in ${name}`, short: 'Being restored', outage: partial[0], more: partial.length - 1 };
  if (maybe.length) return { tone: 'partial', icon: 'alert', kicker: 'Possible', title: `There may be ${water ? 'a water supply problem' : 'an outage'} affecting ${name}`, short: 'Possibly affected', note: `${who.Utility}'s posts didn't name your suburb, but the equipment involved usually supplies it.`, outage: maybe[0], more: maybe.length - 1 };
  if (planned.length) return { tone: 'plan', icon: 'calendar', kicker: 'Coming up', title: `Planned maintenance in ${name}`, short: 'Planned work coming up', outage: planned[0], more: planned.length - 1 };
  if (justRestored.length) return { tone: 'good', icon: 'check', kicker: 'Good news', title: `${water ? 'Water supply' : 'Power'} was restored in ${name}`, short: 'Restored recently', outage: justRestored[0], more: 0 };
  return { tone: 'good', icon: 'check', kicker: 'Right now', title: `No ${water ? 'water supply problem' : 'power outage'} reported for ${name}`, short: 'Nothing reported', note: `${who.Utility} hasn't posted about an interruption here recently.${who.contacts.length ? ` If your ${water ? 'water supply is affected' : 'power is out'}, tell them: ${faultLines(who.contacts)}.` : ''}`, outage: null, more: 0 };
}

/** One answer as a card. `service` adds the Power/Water tag (for pages showing both); `extra` sits under a slim answer. */
export function AnswerCard({ answer, big, slim, action, service, extra }) {
  const o = answer.outage;
  const detail = o?.latest?.summary || (answer.note ?? '');
  if (slim) {
    return (
      <div className={`answer slim tone-${answer.tone}`} role="status">
        <div className="ico"><Icon name={answer.icon} /></div>
        <div className="slim-text">
          <h2>{service && <ServiceIdentity service={service} compact />} <span className="kicker">{answer.kicker}</span> {answer.title}</h2>
          {detail && <p title={detail}>{detail}</p>}
          {extra}
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
        <div className="kicker">{service && <ServiceIdentity service={service} compact />} {answer.kicker}</div>
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


/**
 * Power and, where the suburb's city has Water coverage, Water for one suburb: [{ service, answer, data }] with Power
 * first. `answer` is null while that service loads. `code` is the suburb's municipality when already known; otherwise
 * it is taken from the Power response, and Water is only asked for once we know the city has it.
 */
export function useAreaStatus(localityId, name, code = null) {
  const power = useApi(localityId ? `/v1/localities/${localityId}/outages?service=ELECTRICITY` : null, { refreshMs: 60_000 });
  const city = code ?? power.data?.municipality?.code ?? null;
  const hasWater = useServicesFor(city).includes('WATER');
  const water = useApi(localityId && hasWater ? `/v1/localities/${localityId}/outages?service=WATER` : null, { refreshMs: 60_000 });
  const whoPower = useUtility(city, 'ELECTRICITY');
  const whoWater = useUtility(city, 'WATER');
  const row = (service, res, who) => ({ service, data: res.data, answer: res.data ? computeAnswer(name, res.data.data, res.data.possible, localityId, who, service) : null });
  return [row('ELECTRICITY', power, whoPower), ...(hasWater ? [row('WATER', water, whoWater)] : [])];
}

/** "Water: Low pressure", a one-line pointer to the other service's answer for the same suburb. */
export function OtherService({ row, localityId }) {
  if (!row?.answer) return null;
  return (
    <Link to={inService(`/suburb/${localityId}`, row.service)} className={`area-other tone-${row.answer.tone}`}>
      <ServiceIdentity service={row.service} compact />
      <b>{row.answer.short}</b>
      <Icon name="arrow" />
    </Link>
  );
}
