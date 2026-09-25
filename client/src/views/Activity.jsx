import { useState } from 'react';
import WhatChanged from '../components/WhatChanged.jsx';
import RefreshButton from '../components/RefreshButton.jsx';
import { useDocumentTitle } from '../lib/hooks.js';
import { useRefresh } from '../lib/refresh.js';
import { useMunicipality } from '../lib/municipality.jsx';
import { ServiceIdentity } from '../components/ui.jsx';

const HOUR = 3_600_000;

export default function Activity() {
  useDocumentTitle('What changed');
  const s = useRefresh();
  const { service } = useMunicipality();
  const [range, setRange] = useState('batch');
  const hasBatch = Boolean(s.lastBatch);

  const options = [
    ...(hasBatch ? [{ id: 'batch', label: 'Latest fetch', since: () => s.lastBatch.startedAt, text: 'Since the latest fetch that found new posts' }] : []),
    { id: '24h', label: 'Last 24 hours', since: () => new Date(Date.now() - 24 * HOUR).toISOString(), text: 'In the last 24 hours' },
    { id: '3d', label: '3 days', since: () => new Date(Date.now() - 72 * HOUR).toISOString(), text: 'In the last 3 days' },
    { id: '7d', label: '7 days', since: () => new Date(Date.now() - 168 * HOUR).toISOString(), text: 'In the last 7 days' },
  ];
  const active = options.find((o) => o.id === range) ?? options[0];

  return (
    <div className="container page">
      <header className="page-head">
        <ServiceIdentity service={service} />
        <h1>What changed</h1>
        <p>Every {service === 'WATER' ? 'water interruption' : 'electricity outage'} GridWatch opened or updated, with the one-line update from each new post. Use it after fetching to see exactly what's new.</p>
      </header>
      <div className="toolbar">
        <div className="seg" role="group" aria-label="Time period">
          {options.map((o) => <button key={o.id} aria-pressed={active.id === o.id} onClick={() => setRange(o.id)}>{o.label}</button>)}
        </div>
        <RefreshButton />
      </div>
      <WhatChanged key={active.id + (s.lastBatch?.startedAt ?? '')} since={active.since()} label={active.text} />
    </div>
  );
}
