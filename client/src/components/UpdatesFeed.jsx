import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { nice, prettySdc, timeAgo, useApi } from '../lib/api.js';
import { useMyArea } from '../lib/hooks.js';
import { useMunicipality } from '../lib/municipality.jsx';
import Icon from './Icon.jsx';
import { ServiceIdentity, Skeleton } from './ui.jsx';

// what each kind of news is called, drawn as, and coloured
const KIND = {
  opened: { label: 'New outage', icon: 'alert', tone: 'live' },
  restored: { label: 'Power restored', icon: 'check', tone: 'good' },
  progress: { label: 'Being restored', icon: 'half', tone: 'partial' },
  estimate: { label: 'New estimate', icon: 'clock', tone: 'plan' },
  status: { label: 'Status change', icon: 'bolt', tone: 'partial' },
  planned: { label: 'Planned maintenance', icon: 'calendar', tone: 'plan' },
  update: { label: 'Update', icon: 'info', tone: 'idle' },
};

/** The newest update time this browser has already been shown; a small "new since your last visit" marker, not an alert stream. */
const KEY = 'gw:updates-seen';
const read = () => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};
export function useSeenUpdates() {
  const [seenAt] = useState(read); // fixed for this visit, so items stay marked while you read them
  const [cleared, setCleared] = useState(false); // once they have been looked at, the tab badge goes
  const markSeen = (iso) => {
    setCleared(true);
    try {
      if (iso && (!read() || new Date(iso) > new Date(read()))) localStorage.setItem(KEY, iso);
    } catch {
      /* private mode: the marker just resets each visit */
    }
  };
  return { seenAt, markSeen, cleared };
}
export const countNew = (items, seenAt) => (seenAt ? items.filter((u) => new Date(u.postedAt) > new Date(seenAt)).length : 0);

/** Meaningful updates, newest first. "My area" limits them to outages that involve your saved suburb. */
export default function UpdatesFeed({ all, loading, seenAt, markSeen }) {
  const { area } = useMyArea();
  const { service } = useMunicipality();
  const water = service === 'WATER';
  const [scope, setScope] = useState('all');
  const mine = useApi(area && scope === 'area' ? `/v1/updates?limit=30&locality=${area.id}&service=${service}` : null, { refreshMs: 60_000 });
  const items = scope === 'area' ? mine.data?.data : all;
  const busy = scope === 'area' ? mine.loading && !mine.data : loading;
  const seenTimer = useRef(null);

  // once you have had a moment to look, the newest item counts as seen
  useEffect(() => {
    const newest = all?.[0]?.postedAt;
    if (!newest) return undefined;
    seenTimer.current = setTimeout(() => markSeen(newest), 4000);
    return () => clearTimeout(seenTimer.current);
  }, [all]);

  return (
    <div className="updates">
      {area && (
        <div className="seg updates-scope" role="group" aria-label="Which updates">
          <button type="button" aria-pressed={scope === 'all'} onClick={() => setScope('all')}>Everywhere</button>
          <button type="button" aria-pressed={scope === 'area'} onClick={() => setScope('area')}>{nice(area.name)}</button>
        </div>
      )}
      {busy ? (
        <div className="stage-skeleton">{[0, 1, 2, 3].map((i) => <Skeleton key={i} h={70} />)}</div>
      ) : items?.length ? (
        <ul className="ulist">
          {items.map((u, i) => {
            const k = KIND[u.kind] ?? KIND.update;
            const isNew = seenAt ? new Date(u.postedAt) > new Date(seenAt) : false;
            return (
              <li key={`${u.outageId}-${u.postedAt}-${i}`} className={`urow tone-${k.tone}${isNew ? ' is-new' : ''}`}>
                <span className="urow-glyph" aria-hidden="true"><Icon name={k.icon} /></span>
                <div className="urow-main">
                  <div className="urow-meta">
                    <ServiceIdentity service={u.service ?? service} compact />
                    <b>{water && u.kind === 'restored' ? 'Water supply restored' : water && u.kind === 'opened' ? 'New interruption' : k.label}</b>
                    <span>{timeAgo(u.postedAt)}</span>
                    {u.sdc && <span>{prettySdc(u.sdc)}</span>}
                    {isNew && <em className="new-pill">New</em>}
                  </div>
                  <Link to={`/outages/${u.outageId}`} className="urow-title">{nice(u.title)}</Link>
                  {u.summary && <p>{u.summary}</p>}
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="updates-empty">{scope === 'area' ? `Nothing new for ${nice(area?.name ?? 'your area')} in the last week.` : 'No new updates in the last week.'}</p>
      )}
      <Link to="/activity" className="stage-more link">Everything that changed, by fetch <Icon name="arrow" /></Link>
    </div>
  );
}
