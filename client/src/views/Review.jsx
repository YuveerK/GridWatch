import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useApi, get, operatorRequest, fmtDateTime, timeAgo, typeLabel, waterStateLabel } from '../lib/api.js';
import { useRefresh, REFRESHED_EVENT } from '../lib/refresh.js';
import { OperatorSignIn } from '../components/RefreshButton.jsx';
import { StatusBadge, EmptyState, CardSkeleton } from '../components/ui.jsx';
import Icon from '../components/Icon.jsx';
import { ACTION_LABELS, REVIEW_TABS, RELEVANCE_LABELS, reviewQuery, queryString, newFault, readingDiff, timelineChanges } from '../lib/review.js';
import './review.css';

const date = (v) => v ? fmtDateTime(v) : 'Not recorded';
const notifyChanged = () => window.dispatchEvent(new Event(REFRESHED_EVENT));
const word = (s) => s?.toLowerCase().replaceAll('_',' ') ?? 'unknown';
const title = (s) => word(s).replace(/^./,(c) => c.toUpperCase());
const electricityTypes = ['SDC','SUBSTATION','DISTRIBUTOR','MINI_SUBSTATION','FEEDER','SWITCHING_STATION','KIOSK','TRANSFORMER','CABLE','LINE','OTHER'];
const waterTypes = ['WATER_SYSTEM','RESERVOIR','WATER_TOWER','PUMP_STATION','DIRECT_FEED','BULK_CONNECTION','BULK_METER','BOOSTER_STATION','TREATMENT_WORKS','PRV','WATER_PIPELINE','WATER_OTHER'];
const waterStates = ['NORMAL','STABLE','CONSTRAINED','LOW','CRITICAL','EMPTY','NO_INCOMING_SUPPLY','NO_PUMPING','PUMPING_REDUCED','OUTLET_CLOSED','PARTIAL_SUPPLY','LOW_PRESSURE','NO_SUPPLY','BYPASS','THROTTLED','RECOVERING','UNKNOWN'];
function ErrorMessage({ error }) { return error ? <div className="review-alert" role="alert">{error.message || String(error)}</div> : null; }
function Select({ label,value,onChange,options }) { return <label className="review-field"><span>{label}</span><select value={value ?? ''} onChange={(e) => onChange(e.target.value)}>{options.map(([v,l]) => <option key={v} value={v}>{l}</option>)}</select></label>; }
function JsonDetails({ children }) { return <pre className="review-json">{JSON.stringify(children,null,2)}</pre>; }

export default function Review() {
  const session = useRefresh();
  const { caseId } = useParams();
  const summary = useApi(session.operator ? '/admin/review-cases/summary' : null,{ refreshMs: 60000,keepPrevious: false });
  if (!session.loaded) return <div className="container page"><CardSkeleton n={2} /></div>;
  if (!session.operator) return <div className="container page review-page"><div className="review-heading"><span className="eyebrow">Operator workspace</span><h1>Needs review</h1><p>Sign in to inspect source evidence and resolve uncertain incident decisions.</p></div>
    <div className="card card-pad">{session.signInAvailable ? <OperatorSignIn /> : <p>Operator sign-in is not configured on this server. Set the existing operator token in the API configuration to enable it.</p>}</div></div>;
  return <div className="container page review-page"><div className="review-heading"><span className="eyebrow">Operator workspace · both services</span><h1>Needs review</h1><p>Understand the evidence. Choose what should happen. Check the result.</p></div>
    <ErrorMessage error={summary.error} />{summary.data && <ReviewSummary data={summary.data} />}
    {caseId ? <ReviewDetail key={caseId} id={caseId} correctionsEnabled={summary.data?.correctionsEnabled === true} /> : <ReviewQueue summary={summary.data} />}
    <details className="card card-pad review-help"><summary>How GridWatch reaches an incident decision</summary><p>Fetch utility posts → read their meaning → separate faults → associate incidents → recompute timelines → check results → review exceptions.</p><p>A blocked fault has no reliable result yet. A published result can also be flagged for checking. Confirming a result acknowledges the evidence; correcting a result changes its reading or association and recomputes the affected incidents.</p><p>Water recovery describes equipment or system progress. Only explicit customer supply evidence establishes restoration. A quiet incident has an unknown outcome.</p></details>
  </div>;
}

function ReviewSummary({ data }) {
  const unhealthy = data.pipeline.problems.length || data.accounts.some((a) => a.problems.length);
  return <section aria-label="Review and pipeline summary"><div className="review-stats">
    <Link to="/review?tab=decision" className="card review-stat"><strong>{data.counts.decision}</strong><span>Need your decision</span></Link>
    <Link to="/review?tab=waiting" className="card review-stat"><strong>{data.counts.waiting}</strong><span>Waiting automatically</span></Link>
    <Link to="/review?tab=engineering" className="card review-stat"><strong>{data.counts.engineering}</strong><span>Need engineering</span></Link>
    <div className={`card review-stat ${unhealthy ? 'review-health-warning' : ''}`}><strong>{unhealthy ? 'Check pipeline' : data.pipeline.quality ? 'Checks recorded' : 'Unknown'}</strong><span>{date(data.pipeline.quality?.finishedAt)}</span></div>
  </div>{data.pipeline.problems.length > 0 && <div className="review-alert">{data.pipeline.problems.map((p) => <p key={p}>{p}</p>)}</div>}
  <details className="card card-pad review-sources" open={Boolean(unhealthy)}><summary>Source coverage and freshness</summary><div className="review-source-grid">{data.accounts.map((a) => <article key={a.id}><b>{a.displayName}</b><span className="small faint">{title(a.serviceType)}</span><dl><dt>Last complete fetch</dt><dd>{date(a.lastCompletedFetch)}</dd><dt>Last post processing/check</dt><dd>{date(a.lastCheck)}</dd><dt>Latest fetch</dt><dd>{title(a.latestFetchStatus)}{a.latestFetchStatus === 'SUCCEEDED' ? ` · ${a.latestPostsInserted} new posts` : ''}</dd></dl>{a.problems.map((p) => <p className="review-warning" key={p}>{p}</p>)}</article>)}</div></details>
  </section>;
}

function ReviewQueue({ summary }) {
  const [search,setSearch] = useSearchParams();
  const q = reviewQuery(search);
  const update = (key,value) => { const next = new URLSearchParams(search); value ? next.set(key,value) : next.delete(key); if (key !== 'offset') next.delete('offset'); setSearch(next); };
  const queue = useApi(`/admin/review-cases?${queryString(q)}`,{ refreshMs: 60000,keepPrevious: false });
  const municipalityOptions = [...new Map((summary?.accounts ?? []).filter((a) => a.Municipality).map((a) => [a.Municipality.code,a.Municipality.name])).entries()];
  return <section aria-label="Review inbox"><div className="review-tabs" role="navigation" aria-label="Review categories">{REVIEW_TABS.map(([key,label]) => <button key={key} className={q.tab === key ? 'active' : ''} onClick={() => update('tab',key)} aria-current={q.tab === key ? 'page' : undefined}>{label}<span>{queue.data?.counts?.[key] ?? summary?.counts[key] ?? '–'}</span></button>)}</div>
    <div className="card card-pad review-filters">
      <label className="review-field review-search"><span>Search</span><input value={q.q} onChange={(e) => update('q',e.target.value)} placeholder="Post text, area or post ID" /></label>
      <Select label="Service" value={q.service} onChange={(v) => update('service',v)} options={[[ 'ALL','All services'],['ELECTRICITY','Electricity'],['WATER','Water']]} />
      <Select label="Source" value={q.source} onChange={(v) => update('source',v)} options={[[ '','All sources'],...(summary?.accounts ?? []).map((a) => [a.displayName,a.displayName])]} />
      <Select label="Municipality" value={q.municipality} onChange={(v) => update('municipality',v)} options={[[ '','All municipalities'],...municipalityOptions]} />
      <Select label="Issue" value={q.category} onChange={(v) => update('category',v)} options={[[ '','All issues'],['BLOCKED','Association blocked'],['UNCERTAIN_READING','Uncertain reading'],['READING_FAILURE','Reading failed'],['MISSING_DISPOSITION','Missing result'],['PROCESSING_ERROR','Processing failed'],['NEW_NEAR_ACTIVE','Possible duplicate'],['RESTORATION_SPLIT_FROM_INCIDENT','Restoration association'],['RESTORATION_OTHER_SUBURB_ONLY_OPEN','Missing restoration'],['CHANGED_SCOPE','Changed areas'],['KIND_CONFLICT','Planned/unplanned conflict'],['EQUIPMENT_IDENTITY','Equipment identity'],['OPERATIONAL','Pipeline health'],['TIEBREAK_GAVE_UP','Retries exhausted']]} />
      <Select label="Age" value={q.age} onChange={(v) => update('age',v)} options={[[ 'all','Any age'],['day','Last 24 hours'],['week','Last 7 days'],['older','Older than 7 days']]} />
      <label className="review-checkbox"><input type="checkbox" checked={q.sampled === 'true'} onChange={(e) => update('sampled',e.target.checked ? 'true' : 'false')} />Include routine spot checks</label>
    </div><ErrorMessage error={queue.error} />
    {queue.loading && <CardSkeleton n={3} />}
    {queue.data && <><p className="small faint review-total">{queue.data.total} matching {queue.data.total === 1 ? 'issue' : 'issues'} · all matching records counted</p>
    {!queue.data.data.length && <EmptyState icon="check" title={q.tab === 'decision' ? 'No issues need your decision in this view' : 'No issues in this view'}>Source coverage and processing freshness are shown above. Change the filters to inspect other work.</EmptyState>}
    <div className="review-list">{queue.data.data.map((c) => <article key={c.id} className="card review-row"><div><div className="review-meta"><span>{c.serviceType ? title(c.serviceType) : 'Pipeline'}</span><span>{c.source ?? 'All sources'}</span><span>{timeAgo(c.createdAt)}</span><span className={c.blocked ? 'review-warning' : ''}>{c.tab === 'history' ? title(c.workflow) : c.outageId ? 'Published · check needed' : c.blocked ? 'Blocked' : c.tab === 'waiting' ? 'Waiting automatically' : 'Published · check needed'}</span></div><h2><Link to={`/review/${c.id}?${search.toString()}`}>{c.title}</Link></h2>{c.label && <p className="small review-label">{c.label}</p>}<p>{c.consequence}</p>{c.nextRetryAt && <p className="small">Next retry: {date(c.nextRetryAt)} · {c.retryAttempts} attempts so far</p>}{c.note && <p className="small faint">Your note: {c.note}</p>}</div><Link className="btn" to={`/review/${c.id}?${search.toString()}`}>Review <Icon name="arrow" /></Link></article>)}</div>
    <div className="review-pagination"><button className="btn" disabled={q.offset === 0} onClick={() => update('offset',String(Math.max(0,q.offset-q.limit)))}>Previous</button><span>{queue.data.total ? `${q.offset+1}–${Math.min(q.offset+q.limit,queue.data.total)} of ${queue.data.total}` : '0 issues'}</span><button className="btn" disabled={!queue.data.hasMore} onClick={() => update('offset',String(q.offset+q.limit))}>Next</button></div></>}
  </section>;
}

function SourceImage({ media }) {
  const [failed,setFailed] = useState(false);
  if (media.type !== 'photo') return <a className="link" href={media.url} target="_blank" rel="noreferrer">Open source attachment</a>;
  return failed ? <p className="small faint">Image unavailable here. Open the utility’s original post to inspect it.</p> : <a href={media.url} target="_blank" rel="noreferrer"><img className="review-image" src={media.url} alt="Original utility notice attached to the source post" onError={() => setFailed(true)} /></a>;
}
function UtilityEvidence({ post }) { return <><p className="small faint">{post.source} · {date(post.publishedAt)}</p><p className="review-original">{post.text}</p><a href={post.url} target="_blank" rel="noreferrer" className="link">Open original utility post ↗</a><div className="review-images">{post.media.map((m) => <SourceImage key={m.mediaKey} media={m} />)}</div>{post.imageText && <details open><summary>Image transcription</summary><p className="review-original">{post.imageText}</p></details>}{post.related.map((p) => <details key={p.id}><summary>Related utility post · {date(p.publishedAt)}</summary><p className="review-original">{p.noteTweetText || p.text}</p><a className="link" target="_blank" rel="noreferrer" href={`https://x.com/${p.sourceAccount}/status/${p.externalId}`}>Open related post</a></details>)}</>; }

function Incident({ incident,select,selected }) {
  return <article className={`card card-pad review-incident ${selected ? 'selected' : ''}`}><div className="review-incident-head"><Link className="link" to={`/outages/${incident.id}`} target="_blank">{incident.title}</Link><StatusBadge status={incident.status} kind={incident.kind} service={incident.serviceType} waterState={incident.waterState} /></div><p className="small">Opened {date(incident.startedAt)} · last update {date(incident.lastUpdateAt)}</p><p><b>Equipment:</b> {incident.equipment.map((n) => n.name).join(', ') || 'None named'}</p><p><b>Areas:</b> {incident.localities.map((l) => `${l.name}${l.restored ? ' (restored)' : ''}`).join(', ') || 'None named'}</p>
    <details><summary>Compare source timeline ({incident.timeline.length} sections)</summary>{incident.timeline.map((p) => <div className="review-timeline" key={`${p.postId}:${p.faultIndex}`}><b>{title(p.role)} · {date(p.postedAt)}</b><p>{p.text}</p><a href={`https://x.com/${p.source}/status/${p.externalId}`} className="link" target="_blank" rel="noreferrer">Original post</a></div>)}</details>
    {incident.match && <details><summary>Technical matching reasons</summary><p className="small">This is a matching score, not a probability.</p><JsonDetails>{incident.match}</JsonDetails></details>}
    {select && <button className={`btn ${selected ? 'primary' : ''}`} onClick={() => select(incident.id)}>{selected ? 'Selected incident' : 'Choose this incident'}</button>}
  </article>;
}

function ReviewDetail({ id,correctionsEnabled }) {
  const [search] = useSearchParams();
  const detail = useApi(`/admin/review-cases/${id}`,{ refreshMs: 60000,keepPrevious: false });
  const [copied,setCopied] = useState(false);
  const [error,setError] = useState(null);
  const [undo,setUndo] = useState(null);
  const [working,setWorking] = useState(false);
  const copy = async () => { try { await navigator.clipboard.writeText(detail.data.brief); setCopied(true); } catch { setError(new Error('Clipboard access is unavailable. Expand the investigation brief below and copy its text.')); } };
  const exportFixture = async () => {
    try { const fixture = await get(`/admin/review-cases/${id}/fixtures`);const url = URL.createObjectURL(new Blob([JSON.stringify(fixture,null,2)],{ type: 'application/json' }));const a = document.createElement('a');a.href = url;a.download = `gridwatch-review-${id}.json`;a.click();URL.revokeObjectURL(url); } catch (e) { setError(e); }
  };
  const undoAction = async (action,apply = false) => {
    setWorking(true);setError(null);
    try { const result = await operatorRequest(`/admin/review-cases/${id}/actions/${action.id}/undo`,{ apply,...(apply ? { fingerprint: undo.fingerprint } : {}) }); if (apply) { setUndo(null);notifyChanged(); } else setUndo({ ...result,action }); }
    catch (e) { setError(e);if (e.code === 'undo_conflict') notifyChanged(); } finally { setWorking(false); }
  };
  const d = detail.data;
  return <section><Link to={`/review?${search.toString()}`} className="link review-back">← Back to the review inbox</Link><ErrorMessage error={detail.error} />{detail.loading && <CardSkeleton n={3} />}
  {d && <><div className="card card-pad review-case-heading"><div className="review-meta"><span>{title(d.serviceType ?? 'pipeline')}</span><span>{d.source ?? 'All sources'}</span><span>{d.outageId ? 'Published · check needed' : d.blocked ? 'Blocked' : title(d.workflow)}</span></div><h2>{d.title}</h2><p>{d.consequence}</p>{d.note && <p>Your note: {d.note}</p>}<button className="btn" onClick={copy}>{copied ? 'Investigation brief copied' : 'Copy investigation brief'}</button></div>
    <div className="review-detail-grid"><div className="review-evidence">
    <section className="card card-pad"><h3>What the utility said</h3>{d.sourcePost ? <UtilityEvidence post={d.sourcePost} /> : d.evidencePosts?.length ? <><p>This concern spans the incident timeline. Compare each utility post before changing its interpretation or status.</p>{d.evidencePosts.map((p,i) => <details key={p.id} open={i === d.evidencePosts.length-1}><summary>{p.source} · {date(p.publishedAt)}</summary><UtilityEvidence post={p} /></details>)}</> : <p>This issue concerns fetching, processing or checking. Inspect the source-coverage information above and the recorded technical evidence below.</p>}</section>
    <section className="card card-pad"><h3>What GridWatch understood</h3>{d.reading ? <><p><b>{RELEVANCE_LABELS[d.reading.relevance] ?? title(d.reading.relevance)}</b> · {title(d.reading.status)}</p><p>{d.reading.update_summary || d.reading.summary}</p><p><b>Equipment:</b> {d.reading.entities?.map((a) => a.name).join(', ') || 'None named'}</p><p><b>Areas:</b> {d.reading.localities?.map((a) => `${a.name} (${word(a.impact ?? a.state)})`).join(', ') || 'None named'}</p>{d.serviceType === 'WATER' && <p><b>Water operating state:</b> {waterStateLabel(d.reading.water_state)} · <b>Customer supply:</b> {d.reading.customer_supply ? title(d.reading.customer_supply) : 'Restoration not established'}</p>}<p><b>Cause:</b> {d.reading.cause || 'Not stated'}<br/><b>Schedule / estimate:</b> {d.reading.eta_text || 'Not stated'}</p><p className="small faint">{d.readingOrigin === 'human' ? 'Human interpretation is active and survives reprocessing.' : 'Machine interpretation. Original source evidence is shown separately above.'}</p></> : d.evidenceInterpretations?.length ? <><p>This incident combines the following accepted source sections. Original utility evidence is shown above.</p>{d.evidenceInterpretations.map((p) => p.sections?.map((f) => <details key={`${p.postId}:${f.faultIndex}`}><summary>{f.label} · {RELEVANCE_LABELS[f.meaning] ?? title(f.meaning)}</summary><p>{title(f.status)}{f.restorationPercent != null ? ` · ${f.restorationPercent}% restored` : ''}</p><p>{f.summary}</p>{f.waterState && <p>Operating state: {waterStateLabel(f.waterState)} · Customer supply: {f.customerSupply ? title(f.customerSupply) : 'Restoration not established'}</p>}</details>))}</> : <p>No accepted current interpretation is available. A historical reading may exist in technical details.</p>}
    {d.faults?.length > 1 && <details><summary>Other sections in this post</summary>{d.faults.map((f) => <p key={f.faultIndex}><b>{f.label}</b>: {RELEVANCE_LABELS[f.relevance]} · {f.decision ? title(f.decision.outcome) : 'No decision'}</p>)}</details>}</section>
    <section className="card card-pad"><h3>What GridWatch did</h3><p>{d.decision?.outageId ? d.decision.outcome === 'NEW' ? 'Opened an incident for this section.' : 'Attached this section to an existing incident.' : !d.sourcePost && d.incidents?.length ? 'The published incident needs an investigation across its source timeline.' : d.blocked ? 'Stopped without a reliable result.' : d.decision ? 'Did not create an incident for this section.' : d.sourcePost ? 'Check the results of each section below.' : 'An operational stage needs attention.'}</p>{d.incidents?.map((o) => <Incident key={o.id} incident={o} />)}</section>
    <section className="card card-pad"><h3>Why this needs checking</h3>{d.explanations.map((r) => <div key={r.code}><p>{r.explanation}</p>{r.detail && <p className="small faint">Recorded evidence: {r.detail}</p>}</div>)}{d.verifier && <details><summary>Recorded independent check</summary><p>{d.verifier.reason}</p><blockquote>{d.verifier.quote ?? d.verifier.evidence_quote}</blockquote><p className="small">A second opinion is evidence to inspect, not a final decision.</p></details>}</section>
    <details className="card card-pad"><summary>Technical details</summary><JsonDetails>{{ caseId: d.id,subjectKey: d.subjectKey,faultIndex: d.faultIndex,decision: d.decision,readingVersion: d.readingVersion,historicalReadings: d.historicalReadings,retries: d.retries,overrides: d.overrides,readingOverride: d.readingOverride,proposals: d.proposals,health: d.health,evidenceInterpretations: d.evidenceInterpretations }}</JsonDetails></details>
    <button className="btn" onClick={exportFixture}>Export regression evidence</button><details className="card card-pad"><summary>Investigation brief</summary><pre className="review-json">{d.brief}</pre></details>
    </div><div className="review-resolution"><Resolution key={d.id} detail={d} enabled={correctionsEnabled} /></div></div>
    <section className="card card-pad review-history"><h3>History for this issue</h3><ErrorMessage error={error} />{!d.actions.length && <p>No human actions have been recorded.</p>}{d.actions.map((a) => <article key={a.id}><div className="review-meta"><b>{ACTION_LABELS[a.type] ?? title(a.type)}</b><span>{title(a.state)}</span><span>{date(a.createdAt)}</span></div><p>{a.note}</p>{a.result?.message && <p>{a.result.message}</p>}{a.type === 'REREAD' && a.result?.reading && <details><summary>Proposed reading (not applied)</summary><JsonDetails>{a.result.reading}</JsonDetails></details>}{a.state === 'APPLIED' && !['DEFER','ENGINEERING','CONFIRM','RECHECK','UNDO','LEGACY_REVIEW'].includes(a.type) && <button className="btn" disabled={!correctionsEnabled || working} onClick={() => undoAction(a)}>Preview undo</button>}{['APPLYING','RECOVERY_REQUIRED'].includes(a.state) && <button className="btn" disabled={!correctionsEnabled || working} onClick={() => undoAction(a)}>Inspect recovery</button>}<details><summary>Before, after and validation</summary><JsonDetails>{{ before: a.before,after: a.after,validation: a.validation }}</JsonDetails></details></article>)}</section>
    {undo && <section className="card card-pad review-preview" aria-label="Undo preview"><h3>Undo preview</h3><p>{undo.message}</p><JsonDetails>{{ current: undo.before,restored: undo.after }}</JsonDetails><div className="row"><button className="btn" onClick={() => setUndo(null)}>Cancel</button><button className="btn primary" disabled={working} onClick={() => undoAction(undo.action,true)}>Undo this correction</button></div></section>}
  </>}
  </section>;
}

function Resolution({ detail: d,enabled }) {
  const [type,setType] = useState(d.allowedActions.includes('JOIN') ? 'JOIN' : d.allowedActions.includes('READING') ? 'READING' : 'ENGINEERING');
  const [target,setTarget] = useState('');
  const [reading,setReading] = useState(d.readingDraft);
  const [placements,setPlacements] = useState(Object.fromEntries((d.faults ?? []).map((f) => [f.faultIndex,f.decision?.outageId ?? ''])));
  const [note,setNote] = useState('');
  const [evidence,setEvidence] = useState({ kind: d.sourcePost ? 'TEXT' : 'TEXT',quote: '',...(d.sourcePost?.media[0] ? { mediaKey: d.sourcePost.media[0].mediaKey } : {}) });
  const [preview,setPreview] = useState(null);
  const [requestId,setRequestId] = useState(null);
  const [result,setResult] = useState(null);
  const [error,setError] = useState(null);
  const [working,setWorking] = useState(false);
  const [query,setQuery] = useState('');
  const candidates = useApi(d.sourcePost && ['JOIN','READING'].includes(type) ? `/admin/review-cases/${d.id}/candidates?${queryString({ q: query,limit: 20 })}` : null,{ keepPrevious: false });
  const corrections = !['CONFIRM','DEFER','ENGINEERING','RECHECK'].includes(type);
  const change = (fn) => { fn();setPreview(null);setResult(null);setError(null); };
  const input = () => ({ correction: type === 'JOIN' ? { type,targetOutageId: target } : type === 'READING' ? { type,reading,placements: reading.faults.map((f) => ({ faultIndex: f.faultIndex,targetOutageId: placements[f.faultIndex] || null })) } : { type },note,evidence: evidence.kind === 'TEXT' ? { kind: 'TEXT',quote: evidence.quote } : evidence });
  const run = async (apply) => {
    setWorking(true);setError(null);
    try {
      const out = await operatorRequest(`/admin/review-cases/${d.id}/${apply ? 'actions' : 'preview'}`,apply ? { ...input(),fingerprint: preview.fingerprint,requestId } : input());
      if (apply) {
        setResult(out);setPreview(null);notifyChanged();
        if (out.type === 'REREAD' && out.result?.reading) { setReading(out.result.reading);setType('READING');setPlacements(Object.fromEntries(out.result.reading.faults.map((f) => [f.faultIndex,d.faults?.find((p) => p.faultIndex === f.faultIndex)?.decision?.outageId ?? '']))); }
      } else { setPreview(out);setRequestId(crypto.randomUUID()); }
    } catch (e) { setError(e);if (e.status) setPreview(null); } finally { setWorking(false); }
  };
  const storedCandidates = [...(d.candidates ?? []),...(d.incidents ?? []).filter((o) => !d.candidates?.some((a) => a.id === o.id))];
  const showCandidates = [...storedCandidates,...(candidates.data?.data ?? []).filter((o) => !storedCandidates.some((a) => a.id === o.id))];
  return <section className="card card-pad review-action-card"><h3>How to resolve it</h3><p className="small">Choose an action, identify its utility evidence, then inspect the preview.</p>
    {!enabled && <p className="review-warning">Incident corrections are disabled on this server. You can inspect, confirm valid results, save notes and prepare an engineering handoff.</p>}
    <Select label="What should happen?" value={type} onChange={(v) => change(() => setType(v))} options={d.allowedActions.map((a) => [a,ACTION_LABELS[a]])} />
    {d.blocked && <p className="small faint">A blocked result cannot be dismissed. Correct its evidence or keep it visible for investigation.</p>}
    {type === 'SPLIT' && <p>This section will get a separate incident. The decision is stored so future reprocessing keeps it separate.</p>}
    {type === 'REREAD' && <p>This requests a fresh AI reading of the stored utility post and available images. It may use up to two provider calls. The proposed reading must be reviewed before it changes any incident.</p>}
    {type === 'RETRY_STORED' && <p>Reapply the accepted reading to its existing incident assignments. Unresolved associations still need an explicit incident choice.</p>}
    {type === 'READING' && reading && <><ReadingEditor value={reading} onChange={(v) => change(() => setReading(v))} originalMax={Math.max(-1,...(d.faults ?? []).map((f) => f.faultIndex))} placements={placements} onPlacement={(index,value) => change(() => setPlacements({ ...placements,[index]: value }))} incidents={showCandidates} />
      {readingDiff(d.readingDraft,reading).length > 0 && <details><summary>What changed in this interpretation</summary>{readingDiff(d.readingDraft,reading).map((r) => <div key={r.index}><p><b>{r.after?.entities?.[0]?.name || r.after?.localities?.[0]?.name || 'Source section'}:</b> {r.before ? r.after ? 'Edited' : 'Removed' : 'Added'}</p><JsonDetails>{{ before: r.before,after: r.after }}</JsonDetails></div>)}</details>}</>}
    {['JOIN','READING'].includes(type) && d.sourcePost && <div className="review-candidate-search"><label className="review-field"><span>Find a compatible incident</span><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Area, equipment or source post ID" /></label><p className="small faint">Stored candidates first, then other incidents in this service and municipality. Open a timeline to compare the utility evidence.</p><ErrorMessage error={candidates.error} />{candidates.loading && <p>Loading incidents…</p>}{showCandidates.map((o) => <Incident key={o.id} incident={o} select={type === 'JOIN' ? (id) => change(() => setTarget(id)) : null} selected={target === o.id && type === 'JOIN'} />)}{candidates.data?.hasMore && <p className="small faint">Showing the first 20 matching incidents. Narrow the search to find the right one.</p>}</div>}
    <label className="review-field"><span>{type === 'DEFER' ? 'What information is missing?' : 'Why is this the right decision?'}</span><textarea rows={3} maxLength={1000} value={note} onChange={(e) => change(() => setNote(e.target.value))} placeholder="Explain the decision in your own words" /></label>
    <Select label="Evidence" value={evidence.kind} onChange={(v) => change(() => setEvidence({ ...evidence,kind: v }))} options={[[ 'TEXT',d.sourcePost ? 'Words from the original post' : 'Recorded pipeline problem'],...(d.sourcePost?.media.some((m) => m.type === 'photo') ? [['IMAGE','Words from an attached image']] : [])]} />
    {evidence.kind === 'IMAGE' && <Select label="Utility image" value={evidence.mediaKey} onChange={(v) => change(() => setEvidence({ ...evidence,mediaKey: v }))} options={d.sourcePost.media.filter((m) => m.type === 'photo').map((m,i) => [m.mediaKey,`Attached image ${i+1}`])} />}
    <label className="review-field"><span>Quote the relevant evidence</span><textarea rows={3} maxLength={3000} value={evidence.quote} onChange={(e) => change(() => setEvidence({ ...evidence,quote: e.target.value }))} placeholder={d.sourcePost ? 'Copy the words that support your decision' : 'Describe the recorded failure you inspected'} /></label>
    <ErrorMessage error={error} />
    {result && <div className={result.state === 'FAILED' ? 'review-alert' : 'review-result'} role="status"><b>{title(result.state)}</b><p>{result.result?.message}</p>{result.result?.incidents?.map((o) => <p key={o.id}><Link className="link" to={`/outages/${o.id}`}>{o.title}</Link> · {title(o.status)}{o.waterState ? ` · ${waterStateLabel(o.waterState)}` : ''}</p>)}{result.result?.remainingConcerns?.length > 0 && <><b>Still needs checking</b>{result.result.remainingConcerns.map((c) => <p key={c.id}><Link className="link" to={`/review/${c.id}`}>{c.title}</Link></p>)}</>}<p className="small">The action and its validation are recorded in the history below.</p></div>}
    {!preview && <button className="btn primary" disabled={working || note.trim().length < 3 || evidence.quote.trim().length < 3 || type === 'JOIN' && !target} onClick={() => run(false)}>{working ? 'Working…' : 'Preview this decision'}</button>}
    {preview && <div className="review-preview" aria-label="Correction preview"><h4>Review the change</h4><p>{preview.providerCalls}</p>{preview.changes.map((c) => <p key={c.faultIndex}><b>{c.label || "Source section"}:</b> {preview.before.find((o) => o.id === c.from)?.title || "No incident"} → {preview.after.find((o) => o.id === c.to)?.title || "No incident"}<br /><b>{c.role === 'EXCLUDED' ? 'Exclude section from incidents' : c.from === c.to ? 'Update the current incident' : c.to ? 'Move section to selected incident' : 'Remove section'}:</b> {RELEVANCE_LABELS[c.meaning]}</p>)}
      {preview.after.map((o) => { const before = preview.before.find((b) => b.id === o.id);return <div className="review-preview-incident" key={o.id}><b>{o.title}</b><p>{before ? title(before.status) : 'New incident'} → {o.deleted ? 'Removed: no evidence remains' : title(o.status)}{o.waterState && !o.deleted ? ` · ${waterStateLabel(o.waterState)}` : ''}</p>{!o.deleted && <p className="small">Areas: {o.areas.map((a) => `${a.name}${a.restored ? ' (restored)' : ''}`).join(', ') || 'None'}</p>}<p className="small">Previously affected areas: {before?.areas.map((a) => `${a.name}${a.restored ? ' (restored)' : ''}`).join(', ') || 'None'}</p>
        <p className="small">Timeline sections: {before?.entries.length ?? 0} → {o.entries.length}</p>
        {timelineChanges(before?.entries,o.entries).map((change) => { const entry = change.after || change.before;return <div className="review-timeline" key={change.id}><b>{!change.before ? 'Add' : !change.after ? 'Remove' : 'Change'} {word(entry.role)} · {date(entry.postedAt)}</b>{change.before && change.after && <p>{title(change.before.effect?.status)} → {title(change.after.effect?.status)}</p>}{entry.text && <p>{entry.text}</p>}{entry.source && entry.externalId && <a className="link" href={`https://x.com/${entry.source}/status/${entry.externalId}`} target="_blank" rel="noreferrer">Utility evidence</a>}</div>;})}
        </div>;})}
      {preview.siblings.length > 0 && <p className="small">{preview.siblings.length} other {preview.siblings.length === 1 ? 'section remains' : 'sections remain'} unchanged.</p>}
      <details><summary>Full change details</summary><JsonDetails>{preview}</JsonDetails></details><div className="row"><button className="btn" disabled={working} onClick={() => setPreview(null)}>Back to editing</button><button className="btn primary" disabled={working || corrections && !enabled} onClick={() => run(true)}>{working ? 'Applying…' : preview.label}</button></div></div>}
  </section>;
}

function ReadingEditor({ value,onChange,originalMax,placements,onPlacement,incidents }) {
  const water = value.serviceType === 'WATER';
  const patchFault = (index,patch) => onChange({ ...value,faults: value.faults.map((f) => f.faultIndex === index ? { ...f,...patch } : f) });
  const add = () => { const f = newFault(value);f.faultIndex = Math.max(originalMax+1,f.faultIndex);onChange({ ...value,faults: [...value.faults,f] }); };
  return <div className="review-reading-editor"><p className="small">Use only information stated in the utility post or its image. Section identities are preserved when other sections are edited.</p>{!water && <label className="review-field"><span>Service centre (if stated)</span><input value={value.sdc ?? ''} onChange={(e) => onChange({ ...value,sdc: e.target.value || null })} /></label>}
  {value.faults.map((f,i) => <fieldset key={f.faultIndex} className="review-fault"><legend>{f.entities[0]?.name || f.localities[0]?.name || `Source section ${i+1}`}</legend>
    <Select label="What does this section report?" value={f.relevance} onChange={(v) => patchFault(f.faultIndex,{ relevance: v })} options={Object.entries(RELEVANCE_LABELS).filter(([v]) => v !== 'SDC_SUMMARY')} />
    <Select label="Progress / status" value={f.status} onChange={(v) => patchFault(f.faultIndex,{ status: v })} options={['INVESTIGATING','CREW_DISPATCHED','REPAIRING','PARTIALLY_RESTORED','RESTORED','PLANNED','CANCELLED','UNKNOWN'].map((v) => [v,title(v)])} />
    {water && <><Select label="Water operating state" value={f.water_state} onChange={(v) => patchFault(f.faultIndex,{ water_state: v })} options={waterStates.map((v) => [v,title(v)])} /><Select label="Customer supply evidence" value={f.customer_supply ?? ''} onChange={(v) => patchFault(f.faultIndex,{ customer_supply: v || null })} options={[[ '','Restoration not established'],['PARTIAL','Some customers restored'],['RESTORED','Customer supply restored']]} /><p className="small faint">Pumping, completed repairs, bypass and improving levels do not establish customer restoration.</p><label className="review-field"><span>Named systems (one per line)</span><textarea defaultValue={f.systems.join('\n')} onBlur={(e) => patchFault(f.faultIndex,{ systems: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })} /></label></>}
    <label className="review-field"><span>Plain-language summary</span><textarea value={f.summary} maxLength={1000} onChange={(e) => patchFault(f.faultIndex,{ summary: e.target.value })} /></label>
    <label className="review-field"><span>Cause (as stated)</span><input value={f.cause ?? ''} onChange={(e) => patchFault(f.faultIndex,{ cause: e.target.value || null })} /></label>
    <label className="review-field"><span>Schedule / restoration estimate (as stated)</span><input value={f.eta_text ?? ''} onChange={(e) => patchFault(f.faultIndex,{ eta_text: e.target.value || null })} /></label>
    <label className="review-field"><span>Restoration percentage (if stated)</span><input type="number" min="0" max="100" value={f.restoration_percent ?? ''} onChange={(e) => patchFault(f.faultIndex,{ restoration_percent: e.target.value === '' ? null : Number(e.target.value) })} /></label>
    <h4>Named equipment</h4>{f.entities.map((a,n) => <div className="review-editor-row" key={n}><Select label="Type" value={a.type} options={(water ? waterTypes : electricityTypes).map((t) => [t,typeLabel(t)])} onChange={(v) => patchFault(f.faultIndex,{ entities: f.entities.map((x,j) => j === n ? { ...x,type: v } : x) })} /><label className="review-field"><span>Name</span><input value={a.name} onChange={(e) => patchFault(f.faultIndex,{ entities: f.entities.map((x,j) => j === n ? { ...x,name: e.target.value } : x) })} /></label><label className="review-field"><span>Parent (only if stated)</span><input value={a.parent_name ?? ''} onChange={(e) => patchFault(f.faultIndex,{ entities: f.entities.map((x,j) => j === n ? { ...x,parent_name: e.target.value || null } : x) })} /></label>
      {water && <><Select label="Operator" value={a.operator ?? ''} options={[[ '','Not stated'],...['JOHANNESBURG_WATER','RAND_WATER','UNKNOWN'].map((v) => [v,title(v)])]} onChange={(v) => patchFault(f.faultIndex,{ entities: f.entities.map((x,j) => j === n ? { ...x,operator: v || null } : x) })} /><Select label="Relationship to parent" value={a.relationType ?? ''} options={[[ '','Not stated'],...['SUPPLIES','PUMPS_TO','DIRECTLY_SUPPLIES','PART_OF','UPSTREAM_OF','BYPASSES','BACKFEEDS'].map((v) => [v,title(v)])]} onChange={(v) => patchFault(f.faultIndex,{ entities: f.entities.map((x,j) => j === n ? { ...x,relationType: v || null } : x) })} /></>}
      <button type="button" className="btn small" onClick={() => patchFault(f.faultIndex,{ entities: f.entities.filter((_,j) => j !== n) })}>Remove equipment</button></div>)}<button type="button" className="btn small" onClick={() => patchFault(f.faultIndex,{ entities: [...f.entities,{ type: water ? 'RESERVOIR' : 'SUBSTATION',name: '',parent_name: null,...(water ? { operator: null,relationType: null } : {}) }] })}>Add named equipment</button>
    <h4>Explicitly named areas</h4>{f.localities.map((l,n) => <div className="review-editor-row" key={n}><label className="review-field"><span>Area name</span><input value={l.name} onChange={(e) => patchFault(f.faultIndex,{ localities: f.localities.map((x,j) => j === n ? { ...x,name: e.target.value } : x) })} /></label><Select label="Customer impact" value={water ? l.impact : l.state} options={(water ? ['NO_SUPPLY','LOW_PRESSURE','AFFECTED','RESTORED','UNKNOWN'] : ['AFFECTED','RESTORED','UNKNOWN']).map((v) => [v,title(v)])} onChange={(v) => patchFault(f.faultIndex,{ localities: f.localities.map((x,j) => j === n ? { ...x,[water ? 'impact' : 'state']: v } : x) })} /><button type="button" className="btn small" onClick={() => patchFault(f.faultIndex,{ localities: f.localities.filter((_,j) => j !== n) })}>Remove area</button></div>)}<button type="button" className="btn small" onClick={() => patchFault(f.faultIndex,{ localities: [...f.localities,{ name: '',[water ? 'impact' : 'state']: 'AFFECTED' }] })}>Add named area</button>
    {!['GENERAL_NOTICE','IRRELEVANT'].includes(f.relevance) && <Select label="Incident for this section" value={placements[f.faultIndex] ?? ''} onChange={(v) => onPlacement(f.faultIndex,v)} options={[[ '','A separate incident'],...incidents.map((o) => [o.id,o.title])]} />}
    {value.faults.length > 1 && <button type="button" className="btn small" onClick={() => onChange({ ...value,faults: value.faults.filter((a) => a.faultIndex !== f.faultIndex) })}>Remove this section</button>}
  </fieldset>)}<button className="btn" type="button" onClick={add}>Add a separate source section</button><p className="small faint">To combine sections, copy their source-supported details into the retained section and remove the redundant section. The preview shows all affected incidents.</p></div>;
}
