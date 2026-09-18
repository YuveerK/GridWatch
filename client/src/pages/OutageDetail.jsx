import { Link, useParams } from 'react-router-dom';
import { Chip, ErrorBox, Loading, StatusBadge } from '../components.jsx';
import { cleanPostText, fmtDate, prettySdc, timeAgo, useApi } from '../api.js';

const ROLE = { OPENED: 'First report', UPDATE: 'Update', RESTORATION: 'Restoration' };

export default function OutageDetail() {
  const { id } = useParams();
  const { data: o, error, loading } = useApi(`/v1/outages/${id}`);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;

  const restored = o.localities.filter((l) => l.restored);
  const affected = o.localities.filter((l) => !l.restored);

  return (
    <>
      <p className="small"><Link to="/">← All outages</Link></p>
      <div className="card-head">
        <StatusBadge status={o.status} kind={o.kind} />
        <span className="muted small">{o.sdc ? `${prettySdc(o.sdc)} SDC · ` : ''}started {fmtDate(o.startedAt)} · updated {timeAgo(o.lastUpdateAt)}</span>
      </div>
      <h1>{o.title}</h1>

      <dl className="facts">
        {o.cause && (<><dt>Cause</dt><dd>{o.cause}</dd></>)}
        {o.eta && (<><dt>Estimated restoration</dt><dd>{o.eta}</dd></>)}
        {o.restorationPercent != null && (<><dt>Restored</dt><dd>{o.restorationPercent}%</dd></>)}
        {o.restoredAt && (<><dt>Restored at</dt><dd>{fmtDate(o.restoredAt)}</dd></>)}
      </dl>

      {affected.length > 0 && (
        <section>
          <h2>Affected areas</h2>
          <div className="chips">{affected.map((l) => <Chip key={l.id} to={`/suburb/${l.id}`}>{l.canonicalName}</Chip>)}</div>
        </section>
      )}
      {restored.length > 0 && (
        <section>
          <h2>Restored areas</h2>
          <div className="chips">{restored.map((l) => <Chip key={l.id} to={`/suburb/${l.id}`} muted>{l.canonicalName} ✓</Chip>)}</div>
        </section>
      )}
      {o.infrastructure.length > 0 && (
        <section>
          <h2>Infrastructure involved</h2>
          <div className="chips">
            {o.infrastructure.map((n) => (
              <Chip key={n.id} to={`/infrastructure/${n.id}`} title={n.lifecycle === 'CONFIRMED' ? 'Confirmed by multiple posts' : 'Seen once so far'}>
                {n.name} <span className="muted small">{n.type.replace('_', ' ').toLowerCase()}</span>
              </Chip>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2>Timeline ({o.timeline.length} post{o.timeline.length === 1 ? '' : 's'})</h2>
        <ol className="timeline">
          {o.timeline.map((t) => (
            <li key={t.url}>
              <div className="tl-head">
                <strong>{ROLE[t.role] ?? t.role}</strong>
                <span className="muted small">{fmtDate(t.postedAt)}</span>
              </div>
              <p className="post-text">{cleanPostText(t.text) || t.text}</p>
              {t.images.length > 0 && (
                <div className="images">
                  {t.images.map((src) => (
                    <a key={src} href={src} target="_blank" rel="noreferrer"><img src={`${src}?name=small`} alt="Image attached to the City Power post" loading="lazy" /></a>
                  ))}
                </div>
              )}
              {t.imageText && (
                <details>
                  <summary>Text read from the image</summary>
                  <p className="post-text small">{t.imageText}</p>
                </details>
              )}
              <p className="small">
                <a href={t.url} target="_blank" rel="noreferrer">View on X ↗</a>
                {t.reasons?.length > 0 && <span className="muted"> · linked because: {t.reasons.join(', ')}</span>}
              </p>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
