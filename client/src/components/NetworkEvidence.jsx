import { useState } from 'react';
import { fmtDay, useApi } from '../lib/api.js';
import { safeSourceUrl } from '../lib/network.js';
import { ErrorState } from './ui.jsx';

export default function NetworkEvidence({ nodeId, target = {}, title = 'Asset sources' }) {
  const [kind, setKind] = useState('documents');
  const [offset, setOffset] = useState(0);
  const query = new URLSearchParams({ ...target, kind, offset, limit: 10 });
  const { data, error } = useApi(`/v1/infrastructure/${nodeId}/evidence?${query}`, { keepPrevious: false });
  return <section className="card card-pad network-evidence" aria-label={title}>
    <h3>{title}</h3>
    <p className="small muted">Sources supporting this asset or connection. A reported association does not establish a physical supply route.</p>
    <div className="seg" role="group" aria-label="Source type">{['documents', 'posts'].map((value) => <button key={value} aria-pressed={kind === value} onClick={() => { setKind(value); setOffset(0); }}>{value === 'documents' ? 'Documents / curated sources' : 'Social posts'}{data ? ` (${data[value]})` : ''}</button>)}</div>
    {error ? <ErrorState error={error} /> : !data ? <p role="status">Loading sources…</p> : <>
      {data.data.length === 0 && <p className="muted">No {kind === 'posts' ? 'individual posts' : 'documents or curated sources'} are available for this selection. Legacy report counts may have no retained source link.</p>}
      <ul className="network-sources">{data.data.map((source) => {
        const url = safeSourceUrl(source.url);
        return <li key={source.id}>
          <span className="eyebrow">{source.sourceType.replaceAll('_', ' ')}</span>
          <div>{url ? <a href={url} target="_blank" rel="noreferrer">{source.title || 'Open source'} ↗</a> : source.title || 'Source link unavailable'}</div>
          {source.text && <p className="small source-text">{source.text}</p>}
          <span className="small faint">{source.publishedAt ? `Published ${fmtDay(source.publishedAt)}` : source.fetchedAt ? `Collected ${fmtDay(source.fetchedAt)}` : 'Date unknown'}</span>
        </li>;
      })}</ul>
      {data.total > 10 && <div className="row between"><button className="btn small" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 10))}>Previous sources</button><span className="small">{offset + 1}–{offset + data.data.length} of {data.total}</span><button className="btn small" disabled={!data.hasMore} onClick={() => setOffset(offset + 10)}>Next sources</button></div>}
    </>}
  </section>;
}
