import { Link, useParams } from 'react-router-dom';
import { Chip, ErrorBox, Loading, OutageCard, SuburbSearch } from '../components.jsx';
import { useApi } from '../api.js';

const LIVE = new Set(['ACTIVE', 'PARTIALLY_RESTORED', 'PLANNED']);

export default function Suburb() {
  const { id } = useParams();
  const suburb = useApi(`/v1/localities/${id}`);
  const outages = useApi(`/v1/localities/${id}/outages`);
  if (suburb.loading || outages.loading) return <Loading />;
  if (suburb.error) return <ErrorBox error={suburb.error} />;
  if (outages.error) return <ErrorBox error={outages.error} />;

  const list = outages.data.data;
  const live = list.filter((o) => LIVE.has(o.status));
  const past = list.filter((o) => !LIVE.has(o.status));
  const s = suburb.data;

  return (
    <>
      <p className="small"><Link to="/">← All outages</Link></p>
      <SuburbSearch />
      <h1>{s.name}</h1>
      <p className="muted small">
        {s.region ? `Region ${s.region}` : 'Region unknown'}
        {s.learned && ' · added automatically from City Power posts'}
      </p>

      {live.length === 0 ? (
        <p className="empty ok">No current outage reported for {s.name}.</p>
      ) : (
        <>
          <h2>Current</h2>
          <div className="grid">{live.map((o) => <OutageCard key={o.id} outage={o} />)}</div>
        </>
      )}

      {past.length > 0 && (
        <>
          <h2>History</h2>
          <div className="grid">{past.map((o) => <OutageCard key={o.id} outage={o} />)}</div>
        </>
      )}

      {s.infrastructure.length > 0 && (
        <section>
          <h2>Equipment that has supplied this area</h2>
          <p className="muted small">Learned from past posts, so it may be incomplete.</p>
          <div className="chips">
            {s.infrastructure.map((n) => (
              <Chip key={n.id} to={`/infrastructure/${n.id}`}>
                {n.name} <span className="muted small">{n.type.replace('_', ' ').toLowerCase()}</span>
              </Chip>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
