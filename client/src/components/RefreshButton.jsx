import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTick } from '../lib/hooks.js';
import { cooldownSeconds, describeResult, signIn, startRefresh, useRefresh } from '../lib/refresh.js';
import Icon from './Icon.jsx';
import WhatChanged from './WhatChanged.jsx';

const STEPS = [
  ['fetching', 'Fetch from X'],
  ['reading', 'Read posts'],
  ['tidying', 'Update outages'],
];

/** Where the run is right now: three steps, a bar that fills as posts are read, and how long it has taken. */
function RunProgress({ s }) {
  const at = Math.max(0, STEPS.findIndex(([k]) => k === s.step));
  const total = s.progress?.total ?? null;
  const done = s.progress?.done ?? 0;
  const determinate = s.step === 'reading' && total > 0;
  const elapsed = Math.max(0, Math.round(((s.now ?? Date.now()) - (s.startedAt ?? Date.now()) + (Date.now() - s.receivedAt)) / 1000));
  const detail = (k) => {
    if (k === 'fetching') return s.found != null ? `${s.found} new post${s.found === 1 ? '' : 's'}` : null;
    if (k === 'reading') return determinate ? `${Math.min(done, total)} of ${total}` : s.found === 0 ? 'nothing new' : null;
    return null;
  };
  return (
    <div className="run" aria-label="Progress">
      <ol className="run-steps">
        {STEPS.map(([k, name], i) => {
          const state = i < at ? 'done' : i === at ? 'now' : 'todo';
          return (
            <li key={k} className={`run-step ${state}`}>
              <span className="run-ico">{state === 'done' ? <Icon name="check" /> : state === 'now' ? <Icon name="refresh" className="spin" /> : <i />}</span>
              <span>{name}{detail(k) && state !== 'todo' ? <b> · {detail(k)}</b> : null}</span>
            </li>
          );
        })}
      </ol>
      <div className={`meter run-bar${determinate ? '' : ' indeterminate'}`}>
        <i style={determinate ? { width: `${Math.max(6, (Math.min(done, total) / total) * 100)}%`, background: 'var(--brand)' } : undefined} />
      </div>
      <div className="faint" style={{ marginTop: 4 }}>{elapsed}s</div>
    </div>
  );
}

const STEP = { fetching: 'Fetching from X…', reading: 'Reading posts…', tidying: 'Updating outages…' };

function label(s, wait) {
  if (s.state === 'running') {
    if (s.step === 'reading' && s.progress?.total) return `Reading ${Math.min(s.progress.done, s.progress.total)} of ${s.progress.total}…`;
    return STEP[s.step] ?? 'Working…';
  }
  if (wait > 0) return `Wait ${wait}s`;
  return 'Fetch latest posts';
}

/** Operator sign-in: paste the operator token once; the server keeps you signed in with a cookie. */
function SignIn({ compact }) {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState('');
  const [message, setMessage] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    const r = await signIn(token);
    if (r.ok) setToken('');
    else setMessage(r.message);
  };
  if (!open) {
    return (
      <button type="button" className={compact ? 'icon-btn' : 'btn ghost small'} onClick={() => setOpen(true)} title="Operators can sign in to fetch the newest posts">
        <Icon name="refresh" />
        <span className="label">Operator sign-in</span>
      </button>
    );
  }
  return (
    <form onSubmit={submit} className="row" style={{ gap: 8 }}>
      <input type="password" autoComplete="off" aria-label="Operator token" placeholder="Operator token" value={token} onChange={(e) => setToken(e.target.value)} />
      <button type="submit" className="btn small" disabled={!token}>Sign in</button>
      {message && <span className="small" role="alert" style={{ color: 'var(--live)' }}>{message}</span>}
    </form>
  );
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
  if (!s.operator) return s.signInAvailable ? <SignIn compact={compact} /> : null; // nothing to offer visitors

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
        {running && <RunProgress s={s} />}
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
