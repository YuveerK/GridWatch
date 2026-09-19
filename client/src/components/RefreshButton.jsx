import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTick } from '../lib/hooks.js';
import { cooldownSeconds, describeResult, startRefresh, useRefresh } from '../lib/refresh.js';
import Icon from './Icon.jsx';
import WhatChanged from './WhatChanged.jsx';

const STEP = { fetching: 'Fetching from X…', reading: 'Reading posts…', tidying: 'Updating outages…' };

function label(s, wait) {
  if (s.state === 'running') {
    if (s.step === 'reading' && s.progress?.total) return `Reading ${Math.min(s.progress.done, s.progress.total)} of ${s.progress.total}…`;
    return STEP[s.step] ?? 'Working…';
  }
  if (wait > 0) return `Wait ${wait}s`;
  return 'Fetch latest posts';
}

/**
 * Operator button: pull the newest City Power posts from X, read them and refresh the site.
 * `compact` is the header version; the full version also explains the outcome in words.
 */
export default function RefreshButton({ compact }) {
  const s = useRefresh();
  const [open, setOpen] = useState(false);
  useTick(1000);
  useEffect(() => {
    if (s.state === 'running') setOpen(false);
  }, [s.state]);
  if (!s.loaded || s.enabled === false) return null;

  const running = s.state === 'running';
  const wait = cooldownSeconds(s);
  const disabled = running || wait > 0;
  const text = label(s, wait);

  const outcome =
    s.state === 'error' ? { tone: 'live', icon: 'alert', msg: s.error } :
    s.state === 'done' && s.result ? { tone: 'good', icon: 'check', msg: describeResult(s.result) } :
    null;

  if (compact) {
    return (
      <button className="icon-btn" onClick={startRefresh} disabled={disabled} aria-label={text} title={outcome?.msg ?? 'Fetch the newest posts from City Power on X and update the site'}>
        <Icon name="refresh" className={running ? 'spin' : ''} />
        <span className="label">{running ? text : wait > 0 ? text : 'Refresh'}</span>
      </button>
    );
  }

  return (
    <div className="refresh">
      <button className="btn" onClick={startRefresh} disabled={disabled} aria-busy={running}>
        <Icon name="refresh" className={running ? 'spin' : ''} />
        {text}
      </button>
      <div className="small" aria-live="polite" role="status" style={{ minHeight: 20 }}>
        {running && s.progress?.total > 0 && (
          <div className="meter" style={{ width: 160, marginTop: 8 }}><i style={{ width: `${(s.progress.done / s.progress.total) * 100}%`, background: 'var(--brand)' }} /></div>
        )}
        {!running && outcome && (
          <span className="row" style={{ gap: 6, color: outcome.tone === 'live' ? 'var(--live)' : 'var(--ink-2)' }}>
            <Icon name={outcome.icon} /> {outcome.msg}
            {s.state === 'done' && s.result?.newPosts > 0 && (
              <button className="link small" style={{ background: 'none', border: 0, cursor: 'pointer', padding: 0 }} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
                {open ? 'Hide what changed' : 'See what changed'}
              </button>
            )}
          </span>
        )}
      </div>
      {open && s.state === 'done' && s.startedAt && (
        <div className="card card-pad" style={{ marginTop: 12, maxWidth: 560, width: '100%' }}>
          <WhatChanged since={new Date(s.startedAt).toISOString()} label="From this fetch" />
          <p className="small" style={{ marginTop: 12 }}><Link to="/activity" className="link">Open the full activity page <Icon name="arrow" /></Link></p>
        </div>
      )}
    </div>
  );
}
