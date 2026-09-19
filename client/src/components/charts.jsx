import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import Icon from './Icon.jsx';

/** Headline number. `spark` is an optional array of recent values. */
export function StatTile({ label, value, hint, tone = 'idle', icon, spark, hero, to }) {
  const body = (
    <>
      <div className="k"><Icon name={icon} />{label}</div>
      <div className="v num">{value}</div>
      {hint && <div className="h">{hint}</div>}
      {spark && <Sparkline values={spark} />}
    </>
  );
  const cls = `card tile tone-${tone}${hero ? ' hero-tile' : ''}`;
  return to ? <Link to={to} className={cls}>{body}</Link> : <div className={cls}>{body}</div>;
}

/** 12-ish point trend: earlier points in the muted tone, the latest point in the accent. */
export function Sparkline({ values, w = 84, h = 30 }) {
  if (!values?.length) return null;
  const max = Math.max(...values, 1);
  const step = w / Math.max(values.length - 1, 1);
  const pts = values.map((v, i) => [i * step, h - 3 - (v / max) * (h - 8)]);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const [lx, ly] = pts[pts.length - 1];
  return (
    <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Trend over the last ${values.length} days`}>
      <path d={d} fill="none" stroke="var(--axis)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={lx} cy={ly} r="4" fill="var(--tone, var(--brand))" stroke="var(--card)" strokeWidth="2" />
    </svg>
  );
}

/** Horizontal bars: compare a magnitude across named things. Single hue, value at the tip. */
export function BarList({ items, unit = '', empty = 'Nothing to show yet.' }) {
  const [table, setTable] = useState(false);
  if (!items.length) return <p className="muted">{empty}</p>;
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <div>
      {table ? (
        <table className="data">
          <thead><tr><th>Name</th><th>{unit || 'Value'}</th></tr></thead>
          <tbody>{items.map((i) => <tr key={i.label}><td>{i.label}</td><td className="num">{i.value}</td></tr>)}</tbody>
        </table>
      ) : (
        <div className="barlist">
          {items.map((i) => {
            const row = (
              <>
                <span className="bl-label" title={i.label}>{i.label}</span>
                <span className="bl-track"><span className="bl-bar" style={{ width: `${(i.value / max) * 100}%` }} /></span>
                <span className="bl-val num">{i.value}</span>
              </>
            );
            return i.to ? (
              <Link key={i.label} to={i.to} className="bl-row" title={`${i.label}: ${i.value} ${unit}`}>{row}</Link>
            ) : (
              <div key={i.label} className="bl-row" title={`${i.label}: ${i.value} ${unit}`}>{row}</div>
            );
          })}
        </div>
      )}
      <button type="button" className="btn ghost small tbl-toggle" onClick={() => setTable((t) => !t)}>{table ? 'Show chart' : 'View as table'}</button>
    </div>
  );
}

const fmtShort = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-ZA', { timeZone: 'UTC', day: 'numeric', month: 'short' });
const fmtLong = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-ZA', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });

/** One series over time, as columns. Hover or focus a column for its value. */
export function ColumnChart({ data, unit = 'outages', height = 170 }) {
  const [hover, setHover] = useState(null);
  const [table, setTable] = useState(false);
  const id = useId();
  if (!data?.length) return null;
  const W = 520;
  const pad = { l: 26, r: 6, t: 14, b: 24 };
  const iw = W - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const max = Math.max(...data.map((d) => d.count), 4);
  const top = Math.ceil(max / 4) * 4;
  const slot = iw / data.length;
  const bw = Math.min(24, slot - 8);
  const ticks = [0, top / 2, top];
  const peak = data.reduce((a, d, i) => (d.count > data[a].count ? i : a), 0);
  return (
    <div>
      {table ? (
        <table className="data">
          <thead><tr><th>Day</th><th>Outages reported</th></tr></thead>
          <tbody>{data.map((d) => <tr key={d.date}><td>{fmtLong(d.date)}</td><td className="num">{d.count}</td></tr>)}</tbody>
        </table>
      ) : (
        <div className="colchart" onMouseLeave={() => setHover(null)}>
          <svg viewBox={`0 0 ${W} ${height}`} role="img" aria-labelledby={`${id}-t`}>
            <title id={`${id}-t`}>Outages reported per day over the last {data.length} days. Busiest day: {fmtLong(data[peak].date)} with {data[peak].count}.</title>
            {ticks.map((t) => {
              const y = pad.t + ih - (t / top) * ih;
              return (
                <g key={t}>
                  <line className="gridline" x1={pad.l} x2={W - pad.r} y1={y} y2={y} />
                  <text x={pad.l - 6} y={y + 4} textAnchor="end">{t}</text>
                </g>
              );
            })}
            {data.map((d, i) => {
              const x = pad.l + i * slot + (slot - bw) / 2;
              const h = (d.count / top) * ih;
              const y = pad.t + ih - h;
              const isPeak = i === peak && d.count > 0;
              return (
                <g key={d.date}>
                  {h > 0 && <path className={`bar${hover != null && hover !== i ? ' dim' : ''}`} d={`M${x} ${pad.t + ih} V${y + 4} a4 4 0 0 1 4 -4 h${bw - 8} a4 4 0 0 1 4 4 V${pad.t + ih} Z`} />}
                  {isPeak && <text x={x + bw / 2} y={y - 5} textAnchor="middle" style={{ fill: 'var(--ink)', fontWeight: 700 }}>{d.count}</text>}
                  {(i % 2 === data.length % 2 || i === data.length - 1) && <text x={x + bw / 2} y={height - 6} textAnchor="middle">{fmtShort(d.date)}</text>}
                  <rect className="hit" x={pad.l + i * slot} y={pad.t} width={slot} height={ih + 8} tabIndex={0} role="img" aria-label={`${fmtLong(d.date)}: ${d.count} ${unit}`} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} />
                </g>
              );
            })}
          </svg>
          {hover != null && (
            <div className="tooltip" style={{ left: `${((pad.l + hover * slot + slot / 2) / W) * 100}%`, top: `${((pad.t + ih - (data[hover].count / top) * ih) / height) * 100}%` }}>
              <b className="num">{data[hover].count}</b>
              {fmtLong(data[hover].date)}
            </div>
          )}
        </div>
      )}
      <button type="button" className="btn ghost small tbl-toggle" onClick={() => setTable((t) => !t)}>{table ? 'Show chart' : 'View as table'}</button>
    </div>
  );
}
