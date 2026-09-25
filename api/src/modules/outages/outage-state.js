import { foldWaterStatus, waterStateFromText } from './water-state.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A window that is exactly one Johannesburg calendar day, midnight to midnight: a date was read and no hours were. */
function isWholeLocalDay(schedule) {
  const start = new Date(schedule.start);
  const end = new Date(schedule.end);
  if (end - start !== DAY) return false;
  const sast = new Date(start.getTime() + 2 * HOUR);
  return sast.getUTCHours() === 0 && sast.getUTCMinutes() === 0 && sast.getUTCSeconds() === 0;
}

const covers = (outer, inner) => new Date(inner.start) >= new Date(outer.start) && new Date(inner.end) <= new Date(outer.end);

/** Keep a known precise window when a later notice only repeats the date. */
export function mergeSchedule(known, incoming) {
  if (!known) return incoming;
  if (incoming.reschedule) return incoming;
  if (isWholeLocalDay(incoming) && !isWholeLocalDay(known) && covers(incoming, known)) return known;
  if (isWholeLocalDay(known) && !isWholeLocalDay(incoming) && covers(known, incoming)) return incoming;
  if (covers(known, incoming)) return known;
  return incoming;
}

/**
 * Lifecycle after a fold. A quiet unplanned incident stays STALE: a later refold must not turn it back into a
 * permanent ACTIVE just because the timeline still describes an unresolved condition. Planned work is left to
 * its own window rule. A newer post (a later lastUpdateAt) is real news and may make a stale incident live again.
 */
export function keptLifecycleStatus({ foldedStatus, kind, lastUpdateAt, previousStatus, previousLastUpdateAt, windowAhead = false }) {
  const newerNews = new Date(lastUpdateAt) > new Date(previousLastUpdateAt);
  const swept = ['STALE', 'CLOSED'].includes(previousStatus) && !newerNews && !windowAhead;
  // Refolding an old water bulletin can reveal an explicit restoration that a shared recovery
  // headline previously hid. A corrected, confirmed restoration must not remain STALE.
  if (previousStatus === 'STALE' && foldedStatus === 'RESTORED') return 'RESTORED';
  if (swept) return previousStatus;
  return kind === 'PLANNED' && foldedStatus === 'ACTIVE' ? 'PLANNED' : foldedStatus;
}

// An outage's current state is FOLDED from the effects of its posts, in time order, instead of being overwritten by
// whichever post happened to be processed last. That is what makes a late or historical post harmless (it joins the
// timeline but cannot become "the latest word"), makes reprocessing a matter of removing one effect and re-folding, and
// makes replaying everything give the same answer as processing it live.
//
// An effect is stored on OutagePost.effect:
//   { status, pct, cause, eta, headlineLocalities, locs: [{ id, restored }], nodeIds, sdcName, expand, retroactive, schedule }
// Outages opened before effects existed have posts with a null effect: those keep the older, additive behaviour
// and are never re-folded, because their history cannot be reconstructed from the row alone.

export function statusFor(extraction, current) {
  const { status: s, localities = [], restoration_percent: pct } = extraction.result;
  // "restored to 48 percent" is partial no matter how the suburbs were tagged
  if (pct != null && pct < 100 && !['RESTORED', 'PLANNED', 'CANCELLED'].includes(s)) return pct > 0 ? 'PARTIALLY_RESTORED' : 'ACTIVE';
  // The suburbs are the ground truth for customers: "restored to Willowbrook, but a further fault must be located"
  // is still a restoration, even if the headline status reads INVESTIGATING.
  const restoredAll = localities.length > 0 && localities.every((l) => l.state === 'RESTORED');
  const restoredSome = localities.some((l) => l.state === 'RESTORED');
  // Only override the headline when it is silent about restoration (a post that itself says "partially restored" stays partial).
  const headlineSilent = !['RESTORED', 'PARTIALLY_RESTORED', 'PLANNED', 'CANCELLED'].includes(s);
  if (s === 'RESTORED' || (headlineSilent && restoredAll)) return 'RESTORED';
  if (s === 'PARTIALLY_RESTORED' || (headlineSilent && restoredSome)) return 'PARTIALLY_RESTORED';
  if (s === 'CANCELLED') return 'CANCELLED';
  if (s === 'PLANNED') return 'PLANNED';
  // a fresh "still being repaired" update does not un-restore a restored outage
  return current === 'RESTORED' || current === 'PARTIALLY_RESTORED' ? current : 'ACTIVE'; // a STALE outage that gets news is live again
}

/** A restoration post with no outage to attach to opens a restored outage, unless the post itself says restoration is only partial. */
/**
 * Is one suburb back on, given what the post said? An overall partial percentage ("restored to 75% of customers in X and Y") says not
 * everyone is back, so when EVERY named suburb is tagged restored those tags contradict it and the percentage wins. When the tags are mixed
 * ("Alpha restored, Beta still affected") they are explicit per-suburb statements and stay as stated, even alongside an overall percentage.
 */
export function suburbRestored({ status, partial, locs, restored }) {
  if (status === 'RESTORED') return true;
  if (!restored) return false;
  if (!partial) return true;
  const everyoneTagged = locs.length > 0 && locs.every((l) => l.restored);
  return !everyoneTagged;
}

export const initialStatus = (retroactive, status) => (retroactive && status !== 'PARTIALLY_RESTORED' ? 'RESTORED' : status);

/** What one fault said about its outage, in the shape stored on OutagePost.effect. */
export function buildEffect({ extraction, facts, post, retroactive, expand, revision = null }) {
  const r = extraction.result;
  const restoredIds = new Set(facts.restoredLocalityIds ?? []);
  return {
    status: r.status ?? null,
    pct: r.restoration_percent ?? null,
    cause: r.cause ?? null,
    eta: r.eta_text ?? null,
    // the extractor's own per-suburb states drive the headline status; the matched ids drive the per-suburb flags
    headlineLocalities: (r.localities ?? []).map((l) => ({ state: l.state })),
    locs: facts.localityIds.map((id) => ({ id, restored: restoredIds.has(id) })),
    nodeIds: facts.nodes.map((n) => n.id),
    sdcName: facts.sdcNode?.name ?? null,
    expand: Boolean(expand),
    retroactive: Boolean(retroactive),
    schedule: post.schedule ?? null,
    waterState: r.water_state ?? r.waterState ?? null,
    customerSupply: r.customer_supply ?? r.customerSupply ?? null,
    splitFault: Boolean(facts.fromDigest),
    // which reading this effect was built from (see lib/reading-revision.js): a later reading that differs is detectable
    reading: revision,
  };
}

const order = (a, b) => a.postedAt - b.postedAt || (a.faultIndex ?? 0) - (b.faultIndex ?? 0) || String(a.postId).localeCompare(String(b.postId));

/**
 * Pure fold. `posts` = [{ postId, postedAt, faultIndex, effect }] (any order). Returns the outage's scalar state plus the
 * equipment and suburb sets its posts justify.
 */
export function foldEffects(posts) {
  const sorted = [...posts].sort(order);
  let status = null;
  let waterState = null;
  let restoredAt = null;
  let pct = null;
  let cause = null;
  let eta = null;
  let sdcName = null;
  let schedule = null;
  const nodeIds = new Set();
  const localities = new Map();

  for (const [i, p] of sorted.entries()) {
    const e = p.effect;
    const water = e.waterState || e.customerSupply ? foldWaterStatus(e, status) : null;
    const next = water ? water.status : statusFor({ result: { status: e.status, localities: e.headlineLocalities, restoration_percent: e.pct } }, status);
    if (water?.waterState) waterState = water.waterState;
    // A lone electricity restoration opens as RESTORED. A water fold already decided the lifecycle, and pumping
    // recovery must not be rewritten into a customer restoration just because the post was the first one.
    const nextStatus = water ? water.status : (i === 0 ? initialStatus(e.retroactive, next) : next);
    // one effective transition drives every restoration field
    if (nextStatus === 'RESTORED') {
      if (status !== 'RESTORED') restoredAt = p.postedAt; // the first confirmed restoration time is kept
      pct = 100; // full restoration is 100%: an earlier "48%" no longer applies
    } else {
      restoredAt = null;
      if (e.pct != null) pct = e.pct;
      else if (water && status === 'RESTORED' && nextStatus !== 'RESTORED') pct = null;
    }
    status = nextStatus;
    if (e.cause) cause = e.cause;
    if (e.eta) eta = e.eta;
    if (e.sdcName) sdcName = e.sdcName;
    // A later window replaces the known one, except two reminders that must not:
    // a narrower window nested inside a known one, with no reschedule wording (Klipfontein, 22 Sept), and a date-only
    // whole day that would wipe hours already known for that same day (Heriotdale and Nancefield, 23 Sept).
    // A later window that does state the hours replaces a previous date-only day.
    if (e.schedule) schedule = mergeSchedule(schedule, e.schedule);

    const partial = e.pct != null && e.pct < 100 && status !== 'RESTORED';
    // The earliest post defines the incident. A later digest that only updates it must not add suburbs,
    // and must not be the reason a refold forgets the equipment after the opening post is gone.
    const establishes = i === 0 || e.expand;
    for (const l of e.locs ?? []) {
      const restored = suburbRestored({ status, partial, locs: e.locs ?? [], restored: l.restored });
      if (establishes) localities.set(l.id, restored);
      else if (restored && localities.has(l.id)) localities.set(l.id, true);
    }
    if (establishes) for (const id of e.nodeIds ?? []) nodeIds.add(id);
    if (status === 'RESTORED') for (const id of localities.keys()) localities.set(id, true);
  }
  return {
    status,
    waterState,
    restoredAt,
    restorationPercent: pct,
    cause,
    etaText: eta,
    sdcName,
    schedule,
    startedAt: sorted[0]?.postedAt ?? null,
    lastUpdateAt: sorted.at(-1)?.postedAt ?? null,
    nodeIds,
    localities,
  };
}

/**
 * Recompute an outage from its posts inside `tx`. Returns 'deleted' (no posts left), 'legacy' (some post has no stored
 * effect, so the row is left as it is) or 'folded'.
 */
/** Pumping or asset recovery in the notice wins over a reading that treated "restored" as customer supply. */
function noticeEffect(p) {
  if (p.post?.serviceType !== 'WATER' || !p.effect) return p.effect;
  // Once a bulletin is split, its headline describes several assets. An explicit state on
  // one fault must not be overwritten by recovery words in the shared post text.
  if ((p.effect.splitFault || p.post?.faultCount > 1) && p.effect.waterState && p.effect.waterState !== 'UNKNOWN') return p.effect;
  const fromText = waterStateFromText(p.post.noteTweetText || p.post.text);
  if (fromText.waterState !== 'RECOVERING' || fromText.customerSupply === 'RESTORED') return p.effect;
  return { ...p.effect, waterState: 'RECOVERING', customerSupply: null, status: 'INVESTIGATING' };
}

export async function refoldOutage(tx, outageId, now = new Date()) {
  const outage = await tx.outage.findUnique({ where: { id: outageId }, select: { status: true, kind: true, lastUpdateAt: true } });
  if (!outage) return 'deleted';
  const posts = await tx.outagePost.findMany({
    where: { outageId },
    select: { postId: true, postedAt: true, faultIndex: true, effect: true, post: { select: { serviceType: true, text: true, noteTweetText: true } } },
  });
  if (!posts.length) {
    await tx.outage.delete({ where: { id: outageId } });
    return 'deleted';
  }
  if (posts.some((p) => !p.effect)) return 'legacy';

  // Older water effects predate splitFault. Other timeline entries from the same source post
  // identify those multi-asset bulletins without relying on the shared headline text.
  const waterPostIds = [...new Set(posts.filter((p) => p.post?.serviceType === 'WATER' && !p.effect?.splitFault).map((p) => p.postId))];
  const siblings = waterPostIds.length ? await tx.outagePost.findMany({ where: { postId: { in: waterPostIds } }, select: { postId: true, faultIndex: true } }) : [];
  const faultCounts = new Map();
  for (const p of siblings) faultCounts.set(p.postId, (faultCounts.get(p.postId) ?? new Set()).add(p.faultIndex));
  const f = foldEffects(posts.map((p) => ({ ...p, effect: noticeEffect({ ...p, post: { ...p.post, faultCount: faultCounts.get(p.postId)?.size ?? 1 } }) })));
  // a sweep that already marked the outage STALE/CLOSED stands unless newer news arrived
  // (except planned work whose corrected window still lies ahead: a wrong date must not leave it closed)
  const windowAhead = outage.kind === 'PLANNED' && f.schedule?.end && new Date(f.schedule.end) > now;
  const status = keptLifecycleStatus({
    foldedStatus: f.status,
    kind: outage.kind,
    lastUpdateAt: f.lastUpdateAt,
    now,
    previousStatus: outage.status,
    previousLastUpdateAt: outage.lastUpdateAt,
    windowAhead,
  });
  await tx.outage.update({
    where: { id: outageId },
    data: {
      status,
      waterState: f.waterState,
      startedAt: f.startedAt,
      lastUpdateAt: f.lastUpdateAt,
      restoredAt: f.restoredAt,
      restorationPercent: f.restorationPercent,
      cause: f.cause,
      etaText: f.etaText,
      sdcName: f.sdcName,
      scheduledStart: f.schedule?.start ? new Date(f.schedule.start) : null,
      scheduledEnd: f.schedule?.end ? new Date(f.schedule.end) : null,
    },
  });
  await tx.outageNode.deleteMany({ where: { outageId, nodeId: { notIn: [...f.nodeIds] } } });
  for (const nodeId of f.nodeIds) await tx.outageNode.upsert({ where: { outageId_nodeId: { outageId, nodeId } }, create: { outageId, nodeId }, update: {} });
  await tx.outageLocality.deleteMany({ where: { outageId, localityId: { notIn: [...f.localities.keys()] } } });
  for (const [localityId, restored] of f.localities) {
    await tx.outageLocality.upsert({ where: { outageId_localityId: { outageId, localityId } }, create: { outageId, localityId, restored, impactBasis: 'EXPLICIT_SOURCE' }, update: { restored, impactBasis: 'EXPLICIT_SOURCE' } });
  }
  return 'folded';
}
