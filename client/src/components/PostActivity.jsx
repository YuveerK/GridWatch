import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { EmptyState, ErrorState, Skeleton } from './ui.jsx';
import { get, plural, useApi } from '../lib/api.js';
import { useMunicipality, useUtility, withMunicipality } from '../lib/municipality.jsx';
import './post-activity.css';

const PAGE = 30;
const ZONE = 'Africa/Johannesburg';

const dayLabel = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const timeLabel = (iso) => new Date(iso).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: ZONE });

/** The text with what was searched for marked, so it is clear why a post matched. */
function Marked({ text, q }) {
  if (!q) return text;
  const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'i'));
  return parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : p));
}

/** How many posts the utility in scope made each day, by kind; pick a day or a kind, or search, to read the posts themselves. */
export default function PostActivity({ days }) {
  const { param: muniParam, service } = useMunicipality();
  const water = service === 'WATER';
  const { utility } = useUtility();
  const { data, error, loading } = useApi(withMunicipality(`/v1/posts/daily?days=${days}`, muniParam));
  const [type, setType] = useState(null);
  const [day, setDay] = useState(null);
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [list, setList] = useState({ items: [], total: 0, hasMore: false, loading: true, error: null });

  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);
  // a day chosen on a longer window may not exist on a shorter one
  useEffect(() => {
    if (day && data && !data.daily.some((d) => d.date === day)) setDay(null);
  }, [data, day]);

  const query = useMemo(() => {
    const p = new URLSearchParams({ limit: String(PAGE) });
    if (day) {
      p.set('from', day);
      p.set('to', day);
    } else if (data?.daily.length) {
      p.set('from', data.daily[0].date);
      p.set('to', data.daily.at(-1).date);
    }
    if (type) p.set('type', type);
    if (q) p.set('q', q);
    const s = p.toString();
    return muniParam ? `${s}&${muniParam}` : s;
  }, [day, type, q, data, muniParam]);

  useEffect(() => {
    if (!data) return undefined;
    let cancelled = false;
    setList((l) => ({ ...l, loading: true, error: null }));
    get(`/v1/posts?${query}`)
      .then((r) => !cancelled && setList({ items: r.data, total: r.total, hasMore: r.hasMore, loading: false, error: null }))
      .catch((e) => !cancelled && setList((l) => ({ ...l, loading: false, error: e })));
    return () => {
      cancelled = true;
    };
  }, [query, data]);

  const more = () => {
    setList((l) => ({ ...l, loading: true }));
    get(`/v1/posts?${query}&offset=${list.items.length}`)
      .then((r) => setList((l) => ({ items: [...l.items, ...r.data], total: r.total, hasMore: r.hasMore, loading: false, error: null })))
      .catch((e) => setList((l) => ({ ...l, loading: false, error: e })));
  };

  if (error && !data) return <ErrorState error={error} />;
  if (loading && !data) return <Skeleton h={320} />;
  if (!data) return null;

  const cats = data.categories.map((c) => water && c.id === 'OUTAGE' ? { ...c, label: 'New interruptions' } : water && c.id === 'SUMMARY' ? { ...c, label: 'Supply summaries' } : c);
  const catLabel = Object.fromEntries(cats.map((c) => [c.id, c.label]));
  const totalsByCat = Object.fromEntries(cats.map((c) => [c.id, data.daily.reduce((n, d) => n + d.byCategory[c.id], 0)]));
  const shown = (d) => (type ? d.byCategory[type] : d.total);
  const max = Math.max(1, ...data.daily.map(shown));
  const busiest = data.daily.reduce((b, d) => (d.total > b.total ? d : b), data.daily[0]);
  const rows = [...data.daily].filter((d) => !data.collectedSince || d.date >= data.collectedSince).reverse(); // days before the first collected post are not "quiet", just unknown
  const filtered = Boolean(type || day || q);
  const heading = `${list.total.toLocaleString('en-ZA')} ${list.total === 1 ? 'post' : 'posts'}${type ? ` · ${catLabel[type]}` : ''} · ${day ? dayLabel(day) : `last ${days} days`}${q ? ` · matching “${q}”` : ''}`;

  return (
    <div className="pa">
      <p className="pa-summary">
        <b className="num">{data.total.toLocaleString('en-ZA')}</b> posts in the last {days} days
        {busiest?.total > 0 && <> · busiest day {dayLabel(busiest.date)} ({busiest.total})</>}
        {data.collectedSince && data.collectedSince > data.daily[0].date && <> · collected since {dayLabel(data.collectedSince)}</>}
      </p>

      <div className="pa-kinds" role="group" aria-label="Kind of post">
        <button type="button" className="pa-kind" aria-pressed={!type} onClick={() => setType(null)}>All <span className="num">{data.total}</span></button>
        {cats.filter((c) => totalsByCat[c.id] > 0).map((c) => (
          <button key={c.id} type="button" className="pa-kind" data-kind={c.id} aria-pressed={type === c.id} onClick={() => setType(type === c.id ? null : c.id)}>
            <i className="pa-dot" aria-hidden="true" />{c.label} <span className="num">{totalsByCat[c.id]}</span>
          </button>
        ))}
      </div>

      <ol className="pa-days" aria-label="Posts per day">
        {rows.map((d) => (
          <li key={d.date}>
            <button type="button" className="pa-day" aria-pressed={day === d.date} onClick={() => setDay(day === d.date ? null : d.date)} disabled={!shown(d)} title={`${dayLabel(d.date)}: ${plural(d.total, 'post')}`}>
              <span className="pa-day-name">{dayLabel(d.date)}</span>
              <span className="pa-bar" aria-hidden="true" style={{ width: `${(shown(d) / max) * 100}%` }}>
                {(type ? [type] : cats.map((c) => c.id)).map((id) => (d.byCategory[id] ? <i key={id} data-kind={id} style={{ flexGrow: d.byCategory[id] }} title={`${catLabel[id]}: ${d.byCategory[id]}`} /> : null))}
              </span>
              <span className="pa-day-n num">{shown(d)}</span>
            </button>
          </li>
        ))}
      </ol>

      <div className="pa-search">
        <label htmlFor="pa-q" className="sr-only">Search {utility}'s posts</label>
        <input id="pa-q" type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search the posts, for example a suburb or a substation" autoComplete="off" />
        {filtered && <button type="button" className="pa-clear" onClick={() => { setType(null); setDay(null); setText(''); }}>Clear filters</button>}
      </div>

      <h3 className="pa-list-head" aria-live="polite">{list.loading && !list.items.length ? 'Loading…' : heading}</h3>
      {list.error && <ErrorState error={list.error} />}
      {!list.error && !list.loading && list.items.length === 0 && <EmptyState icon="search" title="No posts match">Try a different day, kind or search.</EmptyState>}
      <ul className="pa-list">
        {list.items.map((p) => (
          <li key={p.id} className="pa-post" data-kind={p.kind}>
            <div className="pa-meta">
              <time dateTime={p.postedAt} className="num">{day ? timeLabel(p.postedAt) : `${dayLabel(p.day)} ${timeLabel(p.postedAt)}`}</time>
              <span className="pa-tag" data-kind={p.kind}><i className="pa-dot" aria-hidden="true" />{catLabel[p.kind] ?? p.kind}</span>
              <a href={p.url} target="_blank" rel="noopener noreferrer" className="pa-x">Open on X ↗</a>
            </div>
            <p className="pa-text"><Marked text={p.text} q={q} /></p>
            {p.outages.length > 0 && (
              <p className="pa-outages">
                <span className="muted small">In {water ? 'water incident' : 'outage'}:</span>
                {p.outages.map((o) => <Link key={o.id} to={`/outages/${o.id}`}>{o.title}</Link>)}
              </p>
            )}
          </li>
        ))}
      </ul>
      {list.hasMore && <button type="button" className="pa-more" onClick={more} disabled={list.loading}>{list.loading ? 'Loading…' : `Show ${Math.min(PAGE, list.total - list.items.length)} more`}</button>}
    </div>
  );
}
