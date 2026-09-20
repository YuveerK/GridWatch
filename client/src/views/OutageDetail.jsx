import { Link, useParams } from 'react-router-dom';
import Icon from '../components/Icon.jsx';
import { scheduleLabel } from '../components/OutageCard.jsx';
import { Chip, Crumbs, ErrorState, Meter, Skeleton, StatusBadge } from '../components/ui.jsx';
import { ROLE, nice, cleanPostText, duration, firstSentence, fmtDateTime, fmtDay, fmtTime, plural, prettySdc, statusMeta, timeAgo, typeLabel, useApi } from '../lib/api.js';
import { useDocumentTitle } from '../lib/hooks.js';

function TimelineItem({ t, last }) {
  const role = ROLE[t.role] ?? ROLE.UPDATE;
  const text = cleanPostText(t.text) || t.text;
  return (
    <li className={`tone-${role.tone}`}>
      <div className="top">
        <span className="role">{role.label}</span>
        <span className="when">{fmtDay(t.postedAt)}, {fmtTime(t.postedAt)} · {timeAgo(t.postedAt)}</span>
        {last && <span className="badge tone-plan" style={{ padding: '1px 8px', fontSize: 11 }}>Latest</span>}
      </div>
      <p className="sum">{t.summary || firstSentence(text)}</p>
      <details className="orig">
        <summary>
          <Icon name="eye" /> City Power's original post{t.images.length > 0 ? ` · ${plural(t.images.length, 'image')}` : ''}
        </summary>
        <div className="body">
          <p className="post-text">{text}</p>
          {t.images.length > 0 && (
            <div className="images">
              {t.images.map((src) => (
                <a key={src} href={src} target="_blank" rel="noreferrer"><img src={`${src}?name=small`} alt="Graphic attached to City Power's post" loading="lazy" /></a>
              ))}
            </div>
          )}
          {t.imageText && (
            <details className="orig" style={{ marginTop: 10, background: 'var(--card)' }}>
              <summary>Text read from the image</summary>
              <div className="body"><p className="post-text small muted">{t.imageText}</p></div>
            </details>
          )}
          <p className="small" style={{ marginTop: 12 }}>
            <a className="link" href={t.url} target="_blank" rel="noreferrer">Open on X <Icon name="external" /></a>
            {t.reasons?.length > 0 && <span className="faint"> · linked to this outage because: {t.reasons.join(', ')}</span>}
          </p>
        </div>
      </details>
    </li>
  );
}

/** Reported, then being restored, then restored: where this outage is in its life. */
function Progression({ status }) {
  const at = status === 'ACTIVE' || status === 'STALE' ? 0 : status === 'PARTIALLY_RESTORED' ? 1 : 2;
  const steps = [['Reported', 'live'], ['Being restored', 'partial'], ['Restored', 'good']];
  return (
    <ol className="progress" aria-label="Progress of this outage">
      {steps.map(([label, tone], i) => (
        <li key={label} className={`${i < at ? 'done' : i === at ? 'now' : 'todo'}${i <= at ? ` reached tone-${tone}` : ''}`} aria-current={i === at ? 'step' : undefined}>
          <i aria-hidden="true" />
          <span>{label}</span>
        </li>
      ))}
    </ol>
  );
}

export default function OutageDetail() {
  const { id } = useParams();
  const { data: o, error, loading } = useApi(`/v1/outages/${id}`, { refreshMs: 60_000 });
  useDocumentTitle(o?.title);

  if (error && !o) return <div className="container page"><ErrorState error={error} /></div>;
  if (loading || !o) {
    return (
      <div className="container page stack" aria-busy="true">
        <Skeleton h={16} w="30%" />
        <Skeleton h={220} r={22} />
        <Skeleton h={300} />
      </div>
    );
  }

  const m = statusMeta(o.status);
  const restored = o.localities.filter((l) => l.restored);
  const affected = o.localities.filter((l) => !l.restored);
  const last = o.timeline.at(-1);
  const isPlanned = o.kind === 'PLANNED';
  const ended = o.status === 'RESTORED' || o.status === 'CLOSED' || o.status === 'CANCELLED';
  const headline = o.latest?.summary || last?.summary || firstSentence(cleanPostText(last?.text ?? ''));

  return (
    <div className="container page">
      <Crumbs items={[{ label: 'Outages', to: '/outages' }, ...(o.sdcNode ? [{ label: prettySdc(o.sdc), to: `/network/${o.sdcNode.id}` }] : []), { label: nice(o.title) }]} />

      <div className={`dhero tone-${m.tone}`}>
        <div className="row between">
          <div className="row" style={{ gap: 10 }}>
            <StatusBadge status={o.status} kind={o.kind} large />
            <span className="small muted">{m.long}</span>
          </div>
          <span className="small faint">Last update {timeAgo(o.lastUpdateAt)}</span>
        </div>
        {!isPlanned && ['ACTIVE', 'PARTIALLY_RESTORED', 'RESTORED', 'CLOSED', 'STALE'].includes(o.status) && <Progression status={o.status} />}
        <h1>{nice(o.title)}</h1>
        {o.sdc && <div className="muted small">Reported by the {prettySdc(o.sdc)} service centre</div>}

        <div className="callout" style={{ '--tint': `var(--${m.tone === 'idle' ? 'idle' : m.tone === 'live' ? 'live' : m.tone === 'plan' ? 'plan' : m.tone}-tint)` }}>
          <div className="lab"><Icon name="bolt" /> {ended ? 'How it ended' : 'What is happening now'}</div>
          <p>{headline}</p>
          <div className="when">
            {isPlanned && o.scheduled && <span className="row" style={{ gap: 6, fontWeight: 500 }}><Icon name="calendar" /> {scheduleLabel(o.scheduled)}</span>}
            {o.eta && <span className="row" style={{ gap: 6 }}><Icon name="clock" /> Estimated: {o.eta}</span>}
            {o.latest?.url && <a className="link" href={o.latest.url} target="_blank" rel="noreferrer">City Power's post <Icon name="external" /></a>}
          </div>
          {!ended && o.restorationPercent != null && !isPlanned && (
            <div style={{ marginTop: 14 }}><Meter value={o.restorationPercent} /></div>
          )}
        </div>

        {o.status === 'STALE' && (
          <div className="notice" style={{ marginTop: 16 }}>
            <Icon name="clock" />
            <div>City Power hasn't posted about this for {timeAgo(o.lastUpdateAt).replace(' ago', '')}. It may already be fixed, but there's no announcement to confirm it.</div>
          </div>
        )}
      </div>

      <div className="two-col" style={{ marginTop: 22 }}>
        <section className="card card-pad" aria-labelledby="tl-h">
          <div className="section-head" style={{ marginBottom: 20 }}>
            <div>
              <h2 id="tl-h">Timeline</h2>
              <p>{plural(o.timeline.length, 'update')} from City Power, oldest first</p>
            </div>
          </div>
          <ol className="tl">
            {o.timeline.map((t, i) => <TimelineItem key={t.url} t={t} last={i === o.timeline.length - 1} />)}
          </ol>
        </section>

        <aside className="stack">
          <div className="card card-pad side-card">
            <h3>Key facts</h3>
            <dl className="facts">
              <dt>Started</dt><dd>{fmtDateTime(o.startedAt)}</dd>
              {ended && o.restoredAt ? (<><dt>Restored</dt><dd>{fmtDateTime(o.restoredAt)}</dd><dt>Lasted</dt><dd>{duration(o.startedAt, o.restoredAt)}</dd></>) : !isPlanned && !ended ? (<><dt>Duration</dt><dd>{duration(o.startedAt)} so far</dd></>) : null}
              {o.cause && (<><dt>Cause</dt><dd style={{ textTransform: 'capitalize' }}>{o.cause}</dd></>)}
              {o.eta && !ended && (<><dt>Estimate</dt><dd>{o.eta}</dd></>)}
              <dt>Updates</dt><dd>{o.postCount}</dd>
            </dl>
          </div>

          <div className="card card-pad side-card">
            <h3>Areas</h3>
            <div className="stack" style={{ gap: 14 }}>
              {affected.length > 0 && (
                <div>
                  <div className="small muted" style={{ marginBottom: 6 }}>{ended ? 'Affected' : 'Still affected'}</div>
                  <div className="chips">{affected.map((l) => <Chip key={l.id} to={`/suburb/${l.id}`}>{nice(l.canonicalName)}</Chip>)}</div>
                </div>
              )}
              {restored.length > 0 && (
                <div>
                  <div className="small muted" style={{ marginBottom: 6 }}>Power back on</div>
                  <div className="chips">{restored.map((l) => <Chip key={l.id} to={`/suburb/${l.id}`} restored>{nice(l.canonicalName)}</Chip>)}</div>
                </div>
              )}
              {o.localities.length === 0 && o.likelyAreas.length > 0 && (
                <div>
                  <div className="small muted" style={{ marginBottom: 6 }}>Likely areas (a guess)</div>
                  <div className="chips">{o.likelyAreas.map((l) => <Chip key={l.id} to={`/suburb/${l.id}`} soft>{nice(l.canonicalName)}</Chip>)}</div>
                  <p className="small faint" style={{ marginTop: 8 }}>City Power's posts didn't name a suburb. These are places this equipment usually supplies.</p>
                </div>
              )}
              {o.localities.length === 0 && o.likelyAreas.length === 0 && <p className="small muted">City Power's posts didn't name any suburbs.</p>}
            </div>
          </div>

          {(o.sdcNode || o.infrastructure.length > 0) && (
            <div className="card card-pad side-card">
              <h3>Equipment involved</h3>
              <ol className="chain">
                {o.sdcNode && (
                  <li>
                    <div className="rail"><span className="node" /></div>
                    <div><div className="lvl">Service centre</div><Link className="nm" to={`/network/${o.sdcNode.id}`}>{prettySdc(o.sdcNode.name)}</Link></div>
                  </li>
                )}
                {o.infrastructure.map((n) => (
                  <li key={n.id}>
                    <div className="rail"><span className="node" /></div>
                    <div><div className="lvl">{typeLabel(n.type)}</div><Link className="nm" to={`/network/${n.id}`}>{nice(n.name)}</Link></div>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
