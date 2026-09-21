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
    const next = statusFor({ result: { status: e.status, localities: e.headlineLocalities, restoration_percent: e.pct } }, status);
    const nextStatus = i === 0 ? initialStatus(e.retroactive, next) : next;
    // one effective transition drives every restoration field
    if (nextStatus === 'RESTORED') {
      if (status !== 'RESTORED') restoredAt = p.postedAt; // the first confirmed restoration time is kept
      pct = 100; // full restoration is 100%: an earlier "48%" no longer applies
    } else {
      restoredAt = null;
      if (e.pct != null) pct = e.pct;
    }
    status = nextStatus;
    if (e.cause) cause = e.cause;
    if (e.eta) eta = e.eta;
    if (e.sdcName) sdcName = e.sdcName;
    if (e.schedule) schedule = e.schedule;

    const partial = e.pct != null && e.pct < 100 && status !== 'RESTORED';
    for (const l of e.locs ?? []) {
      const restored = suburbRestored({ status, partial, locs: e.locs ?? [], restored: l.restored });
      if (e.expand) localities.set(l.id, restored);
      else if (restored && localities.has(l.id)) localities.set(l.id, true);
    }
    if (e.expand) for (const id of e.nodeIds ?? []) nodeIds.add(id);
    if (status === 'RESTORED') for (const id of localities.keys()) localities.set(id, true);
  }
  return {
    status,
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
export async function refoldOutage(tx, outageId) {
  const outage = await tx.outage.findUnique({ where: { id: outageId }, select: { status: true, kind: true, lastUpdateAt: true } });
  if (!outage) return 'deleted';
  const posts = await tx.outagePost.findMany({ where: { outageId }, select: { postId: true, postedAt: true, faultIndex: true, effect: true } });
  if (!posts.length) {
    await tx.outage.delete({ where: { id: outageId } });
    return 'deleted';
  }
  if (posts.some((p) => !p.effect)) return 'legacy';

  const f = foldEffects(posts);
  // a sweep that already marked the outage STALE/CLOSED stands unless newer news arrived
  // (except planned work whose corrected window still lies ahead: a wrong date must not leave it closed)
  const windowAhead = outage.kind === 'PLANNED' && f.schedule?.end && new Date(f.schedule.end) > new Date();
  const swept = ['STALE', 'CLOSED'].includes(outage.status) && f.lastUpdateAt <= outage.lastUpdateAt && !windowAhead;
  await tx.outage.update({
    where: { id: outageId },
    data: {
      status: swept ? outage.status : f.status,
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
    await tx.outageLocality.upsert({ where: { outageId_localityId: { outageId, localityId } }, create: { outageId, localityId, restored }, update: { restored } });
  }
  return 'folded';
}
