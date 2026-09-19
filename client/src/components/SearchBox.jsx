import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, nice, prettySdc, statusMeta, typeLabel } from '../lib/api.js';
import Icon from './Icon.jsx';

/**
 * One search for suburbs, outages and equipment.
 *  - onPickSuburb: override what happens when a suburb is chosen (e.g. "save as my area")
 *  - onPickItem:   take over every choice ({ kind: 'suburb' | 'outage' | 'equipment', id, title }), e.g. the map page
 *  - suburbsOnly:  hide outages and equipment
 */
export default function SearchBox({ autoFocus, placeholder = 'Search your suburb, e.g. Fourways', onPickSuburb, onPickItem, suburbsOnly, compact, inline, onDone }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState({ suburbs: [], equipment: [], outages: [] });
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const navigate = useNavigate();
  const box = useRef(null);
  const listId = useId();

  useEffect(() => {
    if (q.trim().length < 2) {
      setRes({ suburbs: [], equipment: [], outages: [] });
      return undefined;
    }
    setBusy(true);
    const t = setTimeout(() => {
      get(`/v1/search?q=${encodeURIComponent(q)}`)
        .then((r) => {
          setRes(r);
          setActive(0);
        })
        .catch(() => setRes({ suburbs: [], equipment: [], outages: [] }))
        .finally(() => setBusy(false));
    }, 160);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const close = (e) => box.current && !box.current.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  // flat list drives keyboard navigation
  const items = useMemo(() => {
    const out = [];
    res.suburbs.forEach((s) => out.push({ kind: 'suburb', id: s.id, lat: s.lat, lon: s.lon, title: nice(s.name), sub: s.region ? `Suburb · Region ${s.region}` : 'Suburb', icon: 'pin' }));
    if (!suburbsOnly) {
      res.outages.forEach((o) => out.push({ kind: 'outage', id: o.id, title: nice(o.title), sub: `${statusMeta(o.status).label}${o.sdc ? ` · ${prettySdc(o.sdc)}` : ''}`, icon: statusMeta(o.status).icon }));
      res.equipment.forEach((n) => out.push({ kind: 'equipment', id: n.id, title: n.name, sub: `Equipment · ${typeLabel(n.type)}`, icon: 'plug' }));
    }
    return out;
  }, [res, suburbsOnly]);

  const pick = (it) => {
    setOpen(false);
    setQ('');
    if (onPickItem) {
      onPickItem(it);
    } else if (it.kind === 'suburb') {
      if (onPickSuburb) onPickSuburb({ id: it.id, name: it.title });
      else navigate(`/suburb/${it.id}`);
    } else if (it.kind === 'outage') navigate(`/outages/${it.id}`);
    else navigate(`/network/${it.id}`);
    onDone?.();
  };

  const onKey = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter' && items[active]) {
      e.preventDefault();
      pick(items[active]);
    } else if (e.key === 'Escape') {
      setOpen(false);
      onDone?.();
    }
  };

  const groups = [
    ['Suburbs', 'suburb'],
    ['Outages', 'outage'],
    ['Equipment', 'equipment'],
  ];
  const showList = (open || inline) && q.trim().length >= 2;

  return (
    <div className={`search${compact ? ' compact' : ''}`} ref={box}>
      <div className="search-field">
        <Icon name="search" />
        <input
          autoFocus={autoFocus}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKey}
          placeholder={placeholder}
          aria-label={placeholder}
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck="false"
        />
        {busy && <span className="small faint">Searching…</span>}
      </div>
      {showList && (
        <div className={`results${inline ? ' inline' : ''}`} id={listId} role="listbox">
          {items.length === 0 && !busy && <div className="res-empty">No match for "{q}". Try the suburb name only.</div>}
          {groups.map(([label, kind]) => {
            const list = items.filter((i) => i.kind === kind);
            if (!list.length) return null;
            return (
              <div key={kind}>
                <div className="res-group">{label}</div>
                {list.map((it) => {
                  const idx = items.indexOf(it);
                  return (
                    <button key={`${kind}-${it.id}`} type="button" role="option" aria-selected={idx === active} className="res-item" onMouseEnter={() => setActive(idx)} onClick={() => pick(it)}>
                      <Icon name={it.icon} />
                      <span className="grow">
                        <span className="t" style={{ display: 'block' }}>{it.title}</span>
                        <span className="small faint">{it.sub}</span>
                      </span>
                      <Icon name="chevron" />
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
