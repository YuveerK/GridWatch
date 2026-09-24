import { useEffect, useRef, useState } from 'react';

const BASE = import.meta.env.VITE_API_URL ?? '';

export async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(res.status === 404 ? 'Not found' : `Request failed (${res.status})`);
  return res.json();
}

/**
 * { data, error, loading, refreshing } for a GET path (null path = skip).
 * While a new path loads, the previous data is kept so the layout never jumps.
 */
export function useApi(path, { refreshMs } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: Boolean(path), refreshing: false });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!path) return undefined;
    let cancelled = false;
    const load = (initial) => {
      setState((s) => ({ ...s, loading: initial && !s.data, refreshing: Boolean(s.data), error: null }));
      get(path)
        .then((data) => !cancelled && setState({ data, error: null, loading: false, refreshing: false }))
        .catch((error) => !cancelled && setState((s) => ({ ...s, error, loading: false, refreshing: false })));
    };
    load(true);
    const timer = refreshMs ? setInterval(() => load(false), refreshMs) : null;
    const onRefreshed = () => load(false);
    window.addEventListener('gridwatch:refreshed', onRefreshed);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      window.removeEventListener('gridwatch:refreshed', onRefreshed);
    };
  }, [path, refreshMs]);
  return state;
}

// ───────────── time ─────────────
export function timeAgo(iso, now = Date.now()) {
  const mins = Math.round((now - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

const TZ = 'Africa/Johannesburg';
export const fmtTime = (iso) => new Date(iso).toLocaleTimeString('en-ZA', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
export const fmtDay = (iso) => new Date(iso).toLocaleDateString('en-ZA', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
export const fmtDateTime = (iso) => `${fmtDay(iso)}, ${fmtTime(iso)}`;

export function duration(fromIso, toIso = new Date()) {
  const mins = Math.max(0, Math.round((new Date(toIso) - new Date(fromIso)) / 60000));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  if (h < 48) return `${h} h ${mins % 60 ? `${mins % 60} min` : ''}`.trim();
  return `${Math.round(h / 24)} days`;
}

/** 'YYYY-MM-DD' for now in Johannesburg. */
export const todayISO = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
export function dayDiff(isoDate) {
  const a = Date.parse(`${isoDate}T00:00:00Z`);
  const b = Date.parse(`${todayISO()}T00:00:00Z`);
  return Math.round((a - b) / 86_400_000);
}

// ───────────── text ─────────────
/** The utilities often write names in capitals ("NORTHCLIFF"): show them as ordinary names. */
export const nice = (s) => (s && s.length > 3 && s === s.toUpperCase() && /[A-Z]/.test(s) ? s.toLowerCase().replace(/(^|[\s(/-])([a-z])/g, (_, a, b) => a + b.toUpperCase()) : s);
export const prettySdc = (s) => (s ?? '').replace(/([a-z])([A-Z])/g, '$1 $2');
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const typeLabel = (t) => ({ SWITCHING_STATION: 'Switching station', MINI_SUBSTATION: 'Mini-substation', SDC: 'Service centre' }[t] ?? t.charAt(0) + t.slice(1).toLowerCase());

/** Drop hashtags, t.co links and the standard "how to log a call" boilerplate from a post. */
export function cleanPostText(text) {
  return (text ?? '')
    .replace(/https?:\/\/t\.co\/\S+/g, '')
    .split(/\n{2,}/)
    .map((p) => p.replace(/#\w+/g, '').replace(/\s+\^[A-Z]{2}\s*$/, '').trim())
    .filter((p) => p && !/^(follow|for (isolated|regular|updates)|customers are (advised|encouraged)|updates will also|city power remains committed)/i.test(p))
    .join('\n\n');
}

export function firstSentence(t) {
  const clean = (t ?? '').replace(/\s+/g, ' ').trim();
  const m = clean.match(/^.{20,220}?[.!?](\s|$)/);
  return m ? m[0].trim() : clean.length > 200 ? `${clean.slice(0, 200)}…` : clean;
}

// ───────────── status vocabulary (one place, used everywhere) ─────────────
export const STATUS = {
  ACTIVE: { label: 'Outage', long: 'Power is out', tone: 'live', icon: 'alert', order: 0 },
  PARTIALLY_RESTORED: { label: 'Partly restored', long: 'Some areas are back on', tone: 'partial', icon: 'half', order: 1 },
  PLANNED: { label: 'Planned', long: 'Planned maintenance', tone: 'plan', icon: 'calendar', order: 2 },
  RESTORED: { label: 'Restored', long: 'Power is back on', tone: 'good', icon: 'check', order: 3 },
  STALE: { label: 'No recent update', long: 'No news lately', tone: 'idle', icon: 'clock', order: 4 },
  CLOSED: { label: 'Closed', long: 'Finished', tone: 'idle', icon: 'archive', order: 5 },
  CANCELLED: { label: 'Cancelled', long: 'Planned work cancelled', tone: 'idle', icon: 'x', order: 6 },
};
export const statusMeta = (status) => STATUS[status] ?? { label: status, long: status, tone: 'idle', icon: 'clock', order: 9 };
export const isLive = (s) => s === 'ACTIVE' || s === 'PARTIALLY_RESTORED';

export const ROLE = {
  OPENED: { label: 'First report', tone: 'live' },
  UPDATE: { label: 'Update', tone: 'plan' },
  RESTORATION: { label: 'Power restored', tone: 'good' },
};

