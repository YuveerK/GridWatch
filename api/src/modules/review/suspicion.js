import { createHash } from 'node:crypto';

// What makes a change worth a person's (or an independent check's) time. Pure helpers; the database queries are in review.service.js.
// The queue never changes an outage: it only points at things that look wrong so nobody has to read every post to find them.

/** Reason codes and how much attention each deserves (higher = look sooner). */
export const REASONS = {
  NEW_NEAR_ACTIVE: { weight: 3, label: 'opened a new outage next to a similar one that is still live' },
  RESTORATION_SPLIT_FROM_INCIDENT: { weight: 3, label: 'a restoration opened its own outage although a similar incident exists' },
  KIND_CONFLICT: { weight: 3, label: 'a similar outage of the other kind (planned/unplanned) exists nearby' },
  DISCARDED_FAULT: { weight: 2, label: 'a fault of this post produced no outage' },
  EQUIPMENT_IDENTITY: { weight: 2, label: 'a new piece of equipment has a name very like a known one' },
  UNCERTAIN_READING: { weight: 2, label: 'the reading was uncertain, or a picture could not be read' },
  CHANGED_SCOPE: { weight: 1, label: 'this post added many new suburbs to an existing outage' },
  RESTORATION_NO_PRECEDING_INCIDENT: { weight: 1, label: 'a restoration with no earlier incident on record' },
  TIEBREAK_GAVE_UP: { weight: 3, label: 'the AI tie-break kept failing; the decision needs a person' },
  RESTORATION_OTHER_SUBURB_ONLY_OPEN: { weight: 3, label: 'a restoration was placed by its equipment, but an older report naming only the same suburbs is still open' },
  SAMPLE: { weight: 0, label: 'a routine spot check of an apparently clean post' },
};

/** The priority of an item: the sum of its reasons' weights (a verifier disagreement adds 5, applied where it is recorded). */
export const priorityOf = (reasons) => reasons.reduce((n, r) => n + (REASONS[r.code]?.weight ?? 1), 0);

/**
 * Deterministic sampling of clean posts (about `rate` of them per day) to notice blind spots: the same post on the same day is always in or out.
 */
export function isSampled(postId, rate, day) {
  if (!(rate > 0)) return false;
  const h = createHash('sha256').update(`${postId}|${day}`).digest();
  return h.readUInt32BE(0) / 0xffffffff < rate;
}

const PARENT_STATION = new Set(['SUBSTATION', 'SWITCHING_STATION']);

/**
 * Two live incidents that share only a parent substation, and name different suburbs, are the concurrent faults a
 * station can host (Gresswold / Wynberg North beside Granville, 28 Sept). A shared reservoir or a shared suburb still counts.
 */
export function sharesOnlyParentStation(outageNodeIds, outageLocalityIds, other) {
  const shared = (other.nodes ?? []).filter((n) => outageNodeIds.includes(n.nodeId));
  if (!shared.length) return false;
  const otherLocalities = other.localities ?? [];
  const sharedLocalities = otherLocalities.filter((l) => outageLocalityIds.includes(l.localityId));
  if (sharedLocalities.length || !outageLocalityIds.length || !otherLocalities.length) return false;
  return shared.every((n) => PARENT_STATION.has(n.node?.type));
}

/** Sharing only an upstream pump (Palmiet, Eikenhof) does not make two supply-system notices the same incident. */
export function sharesOnlyUpstreamPump(outageNodeIds, other) {
  const shared = (other.nodes ?? []).filter((n) => outageNodeIds.includes(n.nodeId));
  if (!shared.length) return false;
  return shared.every((n) => n.node?.type === 'PUMP_STATION');
}

const SPECIFIC = new Set(['DISTRIBUTOR', 'FEEDER', 'MINI_SUBSTATION']);

/**
 * Two notices that name different distributors under one substation are two faults, even when a broad suburb name
 * overlaps (Blackheath distributor and Northcliff Ring Main Unit, both under Roosevelt, both saying Northcliff, 29 Sept).
 */
export function differentDistributorUnderSharedStation(outageNodes, other) {
  const mine = outageNodes ?? [];
  const theirs = other.nodes ?? [];
  const mineIds = new Set(mine.map((n) => n.nodeId));
  const shared = theirs.filter((n) => mineIds.has(n.nodeId));
  if (!shared.length || !shared.every((n) => PARENT_STATION.has(n.node?.type))) return false;
  const specificIds = (nodes) => nodes.filter((n) => SPECIFIC.has(n.node?.type)).map((n) => n.nodeId);
  const a = specificIds(mine);
  const b = new Set(specificIds(theirs));
  if (!a.length || !b.size) return false;
  return a.every((id) => !b.has(id));
}

/**
 * A regional station list that includes one station already in a smaller live incident is not a duplicate of that
 * incident (Njala infeed naming Mooikloof among a dozen primary stations, 29 Sept).
 */
export function oneStationInsideRegionalList(outageNodeIds, outageLocalityIds, other) {
  const theirs = other.nodes ?? [];
  const shared = theirs.filter((n) => outageNodeIds.includes(n.nodeId));
  if (!shared.length || shared.length > 2 || outageNodeIds.length < 6 || theirs.length >= outageNodeIds.length) return false;
  if (!shared.every((n) => PARENT_STATION.has(n.node?.type))) return false;
  const sharedLocalities = (other.localities ?? []).filter((l) => outageLocalityIds.includes(l.localityId));
  return sharedLocalities.length === 0;
}

/**
 * A status-board operating line names an asset and no suburb. A planned repair of that asset which names its suburbs
 * is a different job (Grand Central "supplying fairly and low" beside the planned Halfway House repair, 29 Sept).
 */
export function operatingUpdateBesidePlannedRepair(outageLocalityIds, other) {
  if (other.kind !== 'PLANNED') return false;
  if ((outageLocalityIds ?? []).length) return false;
  return (other.localities ?? []).length > 0;
}

/**
 * A planned programme that names a station and no suburb is a different job from the unplanned fault already running
 * there (Mooikloof load reduction for 30 Sept, beside the live Mooikloof outage).
 */
export function plannedProgrammeBesideLiveFault(outageKind, outageLocalityIds, other) {
  if (outageKind !== 'PLANNED') return false;
  if ((outageLocalityIds ?? []).length) return false;
  return other.kind === 'UNPLANNED' && (other.localities ?? []).length > 0;
}

/**
 * A planned repair of one reservoir is not the same job as an unplanned system bulletin that merely lists that
 * reservoir among many assets (Hursthill 2 on the morning board, beside the Commando/Crosby notice, 29 Sept).
 */
export function incidentalAssetOnLargerIncident(outageNodeIds, outageLocalityIds, other) {
  const theirs = other.nodes ?? [];
  const shared = theirs.filter((n) => outageNodeIds.includes(n.nodeId));
  if (!shared.length || theirs.length < 4 || shared.length * 2 >= theirs.length) return false;
  const sharedLocalities = (other.localities ?? []).filter((l) => outageLocalityIds.includes(l.localityId));
  return sharedLocalities.length === 0;
}

const flat = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Is `quote` (at least a few words) really in one of the sources, word for word (case and spacing aside)? */
export function quoteAppears(quote, ...sources) {
  const q = flat(quote);
  if (q.length < 8) return false;
  return sources.some((s) => flat(s).includes(q));
}
