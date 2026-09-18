import { Link, useParams } from 'react-router-dom';
import { Chip, ErrorBox, Loading } from '../components.jsx';
import { useApi } from '../api.js';

const label = (t) => t.replace('_', ' ').toLowerCase();

export default function NodeDetail() {
  const { id } = useParams();
  const { data: n, error, loading } = useApi(`/v1/infrastructure/${id}`);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;

  return (
    <>
      <p className="small"><Link to="/infrastructure">← Infrastructure</Link></p>
      <h1>{n.name}</h1>
      <p className="muted small">
        {label(n.type)} · seen in {n.evidenceCount} post{n.evidenceCount === 1 ? '' : 's'} · {n.lifecycle === 'CONFIRMED' ? 'confirmed' : 'not yet confirmed'}
      </p>

      {n.parents.length > 0 && (
        <section>
          <h2>Fed from</h2>
          <div className="chips">
            {n.parents.map((e) => <Chip key={e.parentId} to={`/infrastructure/${e.parentId}`}>{e.parent.name} <span className="muted small">{label(e.parent.type)}</span></Chip>)}
          </div>
        </section>
      )}
      {n.children.length > 0 && (
        <section>
          <h2>Feeds</h2>
          <div className="chips">
            {n.children.map((e) => <Chip key={e.childId} to={`/infrastructure/${e.childId}`}>{e.child.name} <span className="muted small">{label(e.child.type)}</span></Chip>)}
          </div>
        </section>
      )}
      {n.localities.length > 0 && (
        <section>
          <h2>Areas affected when it fails</h2>
          <div className="chips">
            {n.localities.map((l) => <Chip key={l.localityId} to={`/suburb/${l.localityId}`}>{l.locality.canonicalName}</Chip>)}
          </div>
        </section>
      )}
      {n.aliases.length > 0 && <p className="muted small">Also written as: {n.aliases.map((a) => a.alias).join(', ')}</p>}
    </>
  );
}
