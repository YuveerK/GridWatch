import { useRef } from 'react';
import { timeAgo, useApi } from '../lib/api.js';
import { useTick } from '../lib/hooks.js';
import Icon from './Icon.jsx';

const RADIUS = 15;
const CIRC = 2 * Math.PI * RADIUS;
const clock = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * When the site last checked City Power, and a ring that fills up to the next automatic check. The server says when the next
 * check is due; this only counts down to it (against the server's own clock, so a wrong device clock cannot mislead).
 */
export default function SyncStatus() {
  const { data } = useApi('/v1/sync', { refreshMs: 10_000 });
  useTick(1000);
  const got = useRef({ data: null, at: 0 });
  if (data && got.current.data !== data) got.current = { data, at: Date.now() };
  if (!data) return <div className="sync" aria-hidden="true"><span className="sync-ring skeleton" /></div>;

  const serverNow = data.now + (Date.now() - got.current.at);
  const remaining = data.nextRunAt ? data.nextRunAt - serverNow : null;
  const failed = data.latestStatus && data.latestStatus !== 'SUCCEEDED';
  const progress = data.automatic && remaining != null && data.intervalMs ? Math.min(1, Math.max(0, 1 - remaining / data.intervalMs)) : 0;

  let next;
  if (!data.automatic) next = 'Automatic checks are off';
  else if (data.running) next = 'Checking City Power now…';
  else if (remaining == null || remaining <= 0) next = 'Checking any moment now…';
  else next = `Next check in ${clock(remaining)}`;

  return (
    <div className={`sync${failed ? ' is-failed' : ''}`} role="group" aria-label="Sync status">
      <svg className="sync-ring" width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">
        <circle className="track" cx="20" cy="20" r={RADIUS} />
        <circle className="bar" cx="20" cy="20" r={RADIUS} strokeDasharray={CIRC} strokeDashoffset={CIRC * (1 - progress)} transform="rotate(-90 20 20)" />
        <foreignObject x="10" y="10" width="20" height="20"><Icon name={failed ? 'alert' : 'refresh'} className={data.running ? 'spin' : ''} /></foreignObject>
      </svg>
      <div className="sync-text">
        <span className="sync-last">
          {failed ? `Last check failed ${timeAgo(data.latestAt, serverNow)}` : data.lastSyncAt ? `Synced ${timeAgo(data.lastSyncAt, serverNow)}` : 'Not synced yet'}
        </span>
        <span className="sync-next num">{next}</span>
      </div>
    </div>
  );
}
