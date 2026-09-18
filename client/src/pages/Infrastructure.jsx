import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ErrorBox, Loading } from '../components.jsx';
import { useApi } from '../api.js';

const TYPES = ['', 'SDC', 'SUBSTATION', 'SWITCHING_STATION', 'DISTRIBUTOR', 'MINI_SUBSTATION', 'FEEDER', 'TRANSFORMER', 'KIOSK', 'CABLE', 'OTHER'];
const label = (t) => (t ? t.replace('_', ' ').toLowerCase() : 'all types');

export default function Infrastructure() {
  const [type, setType] = useState('');
  const [q, setQ] = useState('');
  const { data, error, loading } = useApi(`/v1/infrastructure?${type ? `type=${type}&` : ''}${q.trim().length > 1 ? `q=${encodeURIComponent(q)}` : ''}`);

  return (
    <>
      <h1>Infrastructure</h1>
      <p className="muted">Equipment GridWatch has learned from City Power's posts. It grows as more posts arrive.</p>
      <div className="toolbar">
        <input className="plain" type="search" placeholder="Filter by name" aria-label="Filter by name" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="select">
          <span className="sr">Type</span>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            {TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}
          </select>
        </label>
      </div>
      {loading && <Loading />}
      {error && <ErrorBox error={error} />}
      {data && (
        <ul className="rows">
          {data.data.map((n) => (
            <li key={n.id}>
              <Link to={`/infrastructure/${n.id}`}>{n.name}</Link>
              <span className="muted small">{label(n.type)} · seen in {n.evidenceCount} post{n.evidenceCount === 1 ? '' : 's'}{n.lifecycle === 'CONFIRMED' ? '' : ' · unconfirmed'}</span>
            </li>
          ))}
          {data.data.length === 0 && <li className="muted">Nothing matches.</li>}
        </ul>
      )}
    </>
  );
}
