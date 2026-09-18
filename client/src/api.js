import { useEffect, useState } from 'react';

const BASE = import.meta.env.VITE_API_URL ?? '';

export async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(res.status === 404 ? 'Not found' : `Request failed (${res.status})`);
  return res.json();
}

/** { data, error, loading } for a GET path (null path = skip). */
export function useApi(path) {
  const [state, setState] = useState({ data: null, error: null, loading: Boolean(path) });
  useEffect(() => {
    if (!path) return undefined;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    get(path)
      .then((data) => !cancelled && setState({ data, error: null, loading: false }))
      .catch((error) => !cancelled && setState({ data: null, error, loading: false }));
    return () => {
      cancelled = true;
    };
  }, [path]);
  return state;
}

export function timeAgo(iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export const fmtDate = (iso) =>
  new Date(iso).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export const prettySdc = (s) => (s ?? '').replace(/([a-z])([A-Z])/g, '$1 $2');

/** Drop hashtags, t.co links and the standard "how to log a call" boilerplate from a post. */
export function cleanPostText(text) {
  return text
    .replace(/https?:\/\/t\.co\/\S+/g, '')
    .split(/\n{2,}/)
    .map((p) => p.replace(/#\w+/g, '').replace(/\s+\^[A-Z]{2}\s*$/, '').trim())
    .filter((p) => p && !/^(follow|for (isolated|regular|updates)|customers are (advised|encouraged)|updates will also|city power remains committed)/i.test(p))
    .join('\n\n');
}

export const STATUS = {
  ACTIVE: { label: 'Active outage', tone: 'bad' },
  PARTIALLY_RESTORED: { label: 'Partially restored', tone: 'warn' },
  RESTORED: { label: 'Restored', tone: 'good' },
  PLANNED: { label: 'Planned', tone: 'info' },
  CANCELLED: { label: 'Cancelled', tone: 'muted' },
  CLOSED: { label: 'Closed', tone: 'muted' },
};
