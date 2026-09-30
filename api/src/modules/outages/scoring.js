const HOUR = 3_600_000;

const squash = (s) => s.toLowerCase().replace(/\s+/g, '');
const intersect = (a, b) => [...a].filter((x) => b.has(x));
// A distributor, feeder or mini-sub is the piece that failed. The substation above it is context.
const SPECIFIC = new Set(['DISTRIBUTOR', 'FEEDER', 'MINI_SUBSTATION']);
const PARENT = new Set(['SUBSTATION', 'SWITCHING_STATION']);
const tokensOf = (name) => String(name ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** "Northcliff" on a morning graphic is the overnight "Northcliff Ring Main Unit", not a second distributor. */
function looserSpecificName(post, outage) {
  const specific = (nodes) => (nodes ?? []).filter((n) => SPECIFIC.has(n.type) && n.name);
  const posted = specific(post.nodes);
  const existing = specific(outage.nodes);
  if (!posted.length || !existing.length) return false;
  if (posted.some((n) => existing.some((m) => m.id === n.id))) return false;
  const prefix = (a, b) => {
    const s = tokensOf(a);
    const l = tokensOf(b);
    if (s.length === 0 || s.length >= l.length || s.join('').length < 6) return false;
    return s.every((t, i) => l[i] === t);
  };
  return posted.every((n) => existing.some((m) => prefix(n.name, m.name) || prefix(m.name, n.name)));
}

/** Two different distributors (or feeders, or mini-subs) under one substation are not the same fault. */
function distinctChildren(post, outage) {
  if (!Array.isArray(post.nodes) || !Array.isArray(outage.nodes)) return null;
  const specific = (nodes) => nodes.filter((n) => SPECIFIC.has(n.type));
  const a = specific(post.nodes);
  const b = specific(outage.nodes);
  if (!a.length || !b.length || a.some((n) => b.some((m) => m.id === n.id))) return null;
  const drop = new Set([...post.nodes, ...outage.nodes].filter((n) => PARENT.has(n.type)).map((n) => n.id));
  return {
    postIds: new Set([...post.nodeIds].filter((id) => !drop.has(id))),
    outageIds: new Set([...outage.nodeIds].filter((id) => !drop.has(id))),
  };
}

/**
 * Score how likely a post belongs to an existing outage (0..1) with human-readable reasons.
 * post:   { kind, relevance, status, nodeIds:Set, relatedNodeIds:Set, localityIds:Set, sdcName, conversationId, postedAt:Date }
 * outage: { kind, status, nodeIds:Set, localityIds:Set, sdcName, conversationIds:Set, lastUpdateAt:Date, restoredAt:Date|null }
 */
/**
 * An outage that has been quiet for longer than the normal window (STALE: no news, outcome unknown) is only a candidate when the post
 * names some of its exact equipment, and even then it may only reach the tie-break: a fault that dragged on (waiting for a part, an
 * insurance claim) is the same fault, but a new fault on the same equipment days later is not, and a score alone cannot tell them apart.
 */
export function applyRevivalRule(candidate, post, { windowHours, highScore }) {
  if (candidate.status !== 'STALE') return candidate;
  const quietHours = (post.postedAt - candidate.lastUpdateAt) / HOUR;
  if (quietHours <= windowHours) return candidate;
  if (!candidate.reasons.some((r) => r.startsWith('shared node'))) return { ...candidate, score: 0, reasons: [...candidate.reasons, 'quiet for a long time and no shared equipment'] };
  return { ...candidate, score: Math.min(candidate.score, highScore - 0.01), reasons: [...candidate.reasons, `quiet for ${(quietHours / 24).toFixed(1)} days: only the tie-break may pick it up again`] };
}

export function scoreCandidate(post, outage) {
  if (post.serviceType === 'WATER') return scoreWaterCandidate(post, outage);
  const reasons = [];
  let score = 0;

  if (post.conversationId && outage.conversationIds.has(post.conversationId)) {
    score += 0.6;
    reasons.push('same thread');
  }
  // Planned and unplanned events are never the same outage.
  if (post.kind !== outage.kind) return { score: 0, reasons: ['planned/unplanned mismatch'] };

  const separated = distinctChildren(post, outage);
  const postNodeIds = separated?.postIds ?? post.nodeIds;
  const outageNodeIds = separated?.outageIds ?? outage.nodeIds;
  const sharedNodes = intersect(postNodeIds, outageNodeIds);
  if (sharedNodes.length) {
    // A post naming one node should not glue itself to a sprawling multi-node outage.
    const jaccard = sharedNodes.length / new Set([...postNodeIds, ...outageNodeIds]).size;
    // A post whose equipment is all inside the outage (e.g. "Central" for a Central-substation fire) is a strong match.
    const containment = sharedNodes.length / postNodeIds.size;
    const overlap = Math.max(jaccard, 0.8 * containment);
    score += 0.5 * (0.4 + 0.6 * overlap);
    reasons.push(`shared node x${sharedNodes.length} (overlap ${overlap.toFixed(2)})`);
  } else if (!separated && intersect(post.relatedNodeIds, outage.nodeIds).length) {
    score += 0.3;
    reasons.push('adjacent node in graph');
  }
  const sharedLocalities = intersect(post.localityIds, outage.localityIds);
  if (sharedLocalities.length) {
    const coef = sharedLocalities.length / Math.min(post.localityIds.size, outage.localityIds.size);
    // Same suburb but demonstrably different infrastructure is weak evidence of the same fault.
    // (not when the post's only suburb is one guessed from a station named after it: that says nothing about different infrastructure)
    const conflicting = post.nodeIds.size && outage.nodeIds.size && !sharedNodes.length && (Boolean(separated) || !intersect(post.relatedNodeIds, outage.nodeIds).length) && !post.localitiesImplied;
    // A post that names TWO OR MORE suburbs, all of which the outage already covers, is very likely the same incident even when it names
    // different equipment (a restoration often reveals which station was to blame). That earns a smaller penalty, which lifts it into
    // the tie-break instead of letting it open a duplicate outage.
    const wholePostInside = coef === 1 && post.localityIds.size >= 2;
    score += 0.4 * coef * (conflicting ? (wholePostInside ? 0.7 : 0.4) : 1);
    reasons.push(`locality overlap ${(coef * 100).toFixed(0)}%`);
  }
  if (score === 0) return { score: 0, reasons: ['no shared thread/node/locality'] };

  // An "amended" post corrects an earlier one about the same fault, often with different equipment names, so a shared
  // suburb is much stronger evidence than usual. This only lifts it into the tie-break: the final call still gets made there.
  if (post.amended && sharedLocalities.length && (post.postedAt - outage.lastUpdateAt) / HOUR <= 12) {
    score += 0.3;
    reasons.push('amended post: corrects an earlier one');
  }

  // Multi-node digest outages (5+ nodes) must not absorb unrelated single-fault posts.
  if (outage.digest && !reasons.includes('same thread')) {
    reasons.push('digest outage');
    score = Math.min(score, 0.3);
  }

  const ageH = Math.max(0, (post.postedAt - outage.lastUpdateAt) / HOUR);
  // An update that names no equipment, and whose suburbs are exactly the live incident's suburbs, is that incident
  // continuing. The reverse is a restoration that names the station for an incident opened with suburbs only.
  // One suburb is enough when the open incident named no equipment: "aware of an outage in Eagle Canyon",
  // then a restoration of Eagle Canyon Estate. Two or more suburbs keep the existing exact-set rule.
  const oneSuburbRestoration = post.relevance === 'RESTORATION' && outage.nodeIds.size === 0 && outage.status === 'ACTIVE' && sharedLocalities.length === 1 && outage.localityIds.size === 1 && post.localityIds.size === 1;
  const sameSuburbSet = oneSuburbRestoration || (sharedLocalities.length >= 2 && sharedLocalities.length === post.localityIds.size && sharedLocalities.length === outage.localityIds.size);
  // Neither side named equipment, and the suburb is exactly one and the same: the morning SDC line "aware of an outage in
  // Fontainebleau" is the incident opened overnight with only that suburb (28 Sept). A second suburb, or any equipment, stays on the rules above.
  const bareSuburbContinuation = post.nodeIds.size === 0 && outage.nodeIds.size === 0 && sharedLocalities.length === 1 && post.localityIds.size === 1 && outage.localityIds.size === 1;
  // The later notice names the same suburb and one or two more, and still no equipment: Commercia Extension 09,
  // then "Commercia Extension 09 and Rabie Ridge Expansion 04" two hours later (29 Sept). A long suburb list does not qualify.
  const extraSuburbs = post.localityIds.size - sharedLocalities.length;
  const continuesBareArea = post.nodeIds.size === 0 && outage.nodeIds.size === 0 && outage.localityIds.size >= 1 && sharedLocalities.length === outage.localityIds.size && extraSuburbs >= 1 && extraSuburbs <= 2;
  const differentSdc = post.sdcName && outage.sdcName && squash(post.sdcName) !== squash(outage.sdcName);
  const restorationOfSameSuburbs = post.relevance === 'RESTORATION' && outage.nodeIds.size === 0 && sameSuburbSet && ageH <= 12;

  if (post.sdcName && outage.sdcName && squash(post.sdcName) === squash(outage.sdcName)) score += 0.05;
  else if (differentSdc && !sharedNodes.length && !restorationOfSameSuburbs) {
    score -= 0.3;
    reasons.push('different SDC');
  }

  score += 0.1 * Math.exp(-ageH / 24);

  if (((sameSuburbSet || bareSuburbContinuation || continuesBareArea) && post.nodeIds.size === 0 && ageH <= 12 && !differentSdc) || restorationOfSameSuburbs) {
    score += 0.35;
    reasons.push(post.nodeIds.size === 0 ? 'same suburbs, no new equipment' : 'restoration of the same suburbs');
  }
  // A graphic that shortens the distributor name, while naming only suburbs the incident already has
  // (Northcliff Ring Main Unit overnight, "Northcliff" on the morning Hursthill board, 29 Sept).
  if (looserSpecificName(post, outage) && sharedLocalities.length > 0 && sharedLocalities.length === post.localityIds.size && ageH <= 12 && !differentSdc) {
    score += 0.5;
    reasons.push('same area, equipment named more loosely');
  }

  if (outage.status === 'CANCELLED' && post.status !== 'CANCELLED') {
    score -= 0.5;
    reasons.push('outage was cancelled');
  }
  // A restoration that names a different distributor under a substation the incident already has, and a suburb the
  // incident already covers, is that incident's restoration written more specifically (Bloubosrand distributor under
  // Houtkoppen, 28 Sept). A fresh outage report that names a different distributor stays a different fault.
  if (post.relevance === 'RESTORATION' && outage.status === 'RESTORED' && sharedLocalities.length) {
    const parents = (nodes) => new Set((nodes ?? []).filter((n) => n.type === 'SUBSTATION' || n.type === 'SWITCHING_STATION').map((n) => n.id));
    const sinceRestore = (post.postedAt - (outage.restoredAt ?? outage.lastUpdateAt)) / HOUR;
    if (sinceRestore >= 0 && sinceRestore <= 6 && intersect(parents(post.nodes), parents(outage.nodes)).length) {
      score += 0.55;
      reasons.push('restoration under the same substation');
    }
  }

  if (outage.status === 'RESTORED') {
    const sinceRestore = (post.postedAt - (outage.restoredAt ?? outage.lastUpdateAt)) / HOUR;
    if (post.relevance === 'RESTORATION' || post.relevance === 'UPDATE') {
      // A second "restored" (or a further update) many hours after full restoration is a different event.
      if (sinceRestore > 6) return { score: 0, reasons: ['already restored more than 6h earlier'] };
      if (sinceRestore > 3) {
        score -= post.relevance === 'RESTORATION' ? 0.6 : 0.3;
        reasons.push('restoration/update long after restore');
      }
    } else if (sinceRestore > 0.5 && !(post.kind === 'PLANNED' && post.relevance === 'PLANNED_OUTAGE')) {
      score -= 0.5;
      reasons.push('new fault after restoration');
    }
  }
  return { score: Math.min(1, Math.max(0, Number(score.toFixed(3)))), reasons };
}

const WATER_ZONE = new Set(['RESERVOIR', 'WATER_TOWER']);

/**
 * A same-day customer notice that names a reservoir or tower which is already the whole of a live incident is an update
 * of that incident (Crosby on the Commando notice, Zondi on the Soweto notice, 28 Sept). A weeks-old incident, a digest,
 * or a shared upstream pump alone does not qualify.
 */
export function sameDayWaterUpdate(post, candidate, { lowScore = 0.35, maxAgeHours = 18 } = {}) {
  if (post.serviceType !== 'WATER' || !candidate || candidate.digest) return false;
  if (!(candidate.score >= lowScore)) return false;
  if (!['ACTIVE', 'PARTIALLY_RESTORED'].includes(candidate.status)) return false;
  const started = candidate.raw?.startedAt ?? candidate.lastUpdateAt;
  if (!started) return false;
  const ageH = (post.postedAt - new Date(started)) / HOUR;
  if (!(ageH >= 0 && ageH <= maxAgeHours)) return false;
  if (!candidate.nodeIds?.size || candidate.nodeIds.size > 2) return false;
  if (![...candidate.nodeIds].every((id) => post.nodeIds.has(id))) return false;
  const nodes = candidate.nodes ?? [];
  return nodes.length > 0 && nodes.every((n) => WATER_ZONE.has(n.type));
}

/**
 * One line of a status board names an asset that a live incident already carries, even when that incident lists many
 * other assets (Brixton 1 Tower on the Commando board, already part of Crosby, 29 Sept). A digest does not qualify.
 */
/** The incident's last update at or before this post. A later post on the same incident must not hide it during a re-link. */
function updatedAtAsOf(candidate, postedAt, postId) {
  const at = new Date(postedAt);
  const prior = (candidate.raw?.posts ?? [])
    .filter((p) => p.postId !== postId && new Date(p.postedAt) <= at)
    .map((p) => new Date(p.postedAt).getTime());
  if (prior.length) return new Date(Math.max(...prior));
  const last = candidate.lastUpdateAt ? new Date(candidate.lastUpdateAt) : null;
  return last && last <= at ? last : null;
}

function quietEnough(candidate, postedAt, postId, maxQuietHours) {
  const last = updatedAtAsOf(candidate, postedAt, postId);
  if (!last) return false;
  const quiet = (new Date(postedAt) - last) / HOUR;
  return quiet >= 0 && quiet <= maxQuietHours;
}

export function boardLineOnLiveAssets(post, candidate, { maxQuietHours = 18 } = {}) {
  if (post.serviceType !== 'WATER' || !post.fromDigest || !candidate || candidate.digest) return false;
  if (!['ACTIVE', 'PARTIALLY_RESTORED'].includes(candidate.status)) return false;
  if (!post.nodeIds?.size || post.nodeIds.size > 2) return false;
  if (![...post.nodeIds].every((id) => candidate.nodeIds.has(id))) return false;
  return quietEnough(candidate, post.postedAt, post.id, maxQuietHours);
}

const TAG_SUFFIX = /(update|outage|alert|notice|sdc)s?$/i;

/**
 * A follow-up that names no place and no real equipment, whose hashtag is a station on exactly one live incident
 * (#NjalaUpdate continuing the Njala infeed trip, 29 Sept). Several matches, or none, stay unresolved.
 */
export function soleHashtagIncident(text, candidates, postedAt, { maxQuietHours = 18, postId = null } = {}) {
  const stems = [...String(text ?? '').matchAll(/#([A-Za-z][A-Za-z0-9]{3,})/g)]
    .map((m) => m[1].replace(TAG_SUFFIX, '').toLowerCase())
    .filter((stem) => stem.length >= 4);
  if (!stems.length) return null;
  const hits = [];
  for (const candidate of candidates) {
    if (!['ACTIVE', 'PARTIALLY_RESTORED'].includes(candidate.status)) continue;
    if (!quietEnough(candidate, postedAt, postId, maxQuietHours)) continue;
    const names = (candidate.nodes ?? []).map((node) => String(node.name ?? '').toLowerCase());
    const stem = stems.find((s) => names.some((name) => name === s || name.startsWith(`${s} `)));
    if (stem) hits.push({ candidate, stem });
  }
  const unique = [...new Map(hits.map((hit) => [hit.candidate.id, hit])).values()];
  return unique.length === 1 ? unique[0] : null;
}

/** An announced planned job (with a window) whose evening a deliberate-closure board line falls in: from 12 hours before it starts to 6 after it ends. */
export function plannedJobCovers(post, outage) {
  if (!post.plannedClosure || outage.kind !== 'PLANNED' || !outage.scheduledStart || !outage.scheduledEnd) return false;
  const t = new Date(post.postedAt).getTime();
  return t >= new Date(outage.scheduledStart).getTime() - 12 * HOUR && t <= new Date(outage.scheduledEnd).getTime() + 6 * HOUR;
}

/** Water incidents do not reuse SDC scoring. Locality overlap alone stays under a confident link when assets differ. */
export function scoreWaterCandidate(post, outage) {
  const reasons = [];
  let score = 0;
  const sharedNodes = intersect(post.nodeIds, outage.nodeIds);
  // A status-board line reporting a deliberate closure ("Overnight closure", "demand management") of an asset that an announced
  // planned job closes that evening IS that job, not a new fault (Sandton meters, 23 Sept 20:00-04:00, and the 17:45 board).
  // Only with the asset in common and inside the job's own evening: otherwise planned and unplanned never mix.
  if (post.kind !== outage.kind) {
    if (!plannedJobCovers(post, outage) || !sharedNodes.length) return { score: 0, reasons: ['planned/unplanned mismatch'] };
    reasons.push('deliberate closure during the announced planned job');
  }
  if (post.conversationId && outage.conversationIds.has(post.conversationId)) {
    score += 0.6;
    reasons.push('same thread');
  }
  const conflictingAssets = post.nodeIds.size && outage.nodeIds.size && !sharedNodes.length && !intersect(post.relatedNodeIds, outage.nodeIds).length;
  if (sharedNodes.length) {
    score += Math.min(0.55, 0.35 + 0.2 * (sharedNodes.length / post.nodeIds.size));
    reasons.push(`shared water asset x${sharedNodes.length}`);
    // The update names exactly the assets this incident already has (one tower, updated the next day).
    if (sharedNodes.length === post.nodeIds.size && sharedNodes.length === outage.nodeIds.size) {
      score += 0.2;
      reasons.push('same water assets');
    }
  } else if (intersect(post.relatedNodeIds, outage.nodeIds).length) {
    score += 0.3;
    reasons.push('one-hop water relationship');
  }
  const sharedLocalities = intersect(post.localityIds, outage.localityIds);
  if (sharedLocalities.length && !conflictingAssets) {
    const coef = sharedLocalities.length / Math.min(post.localityIds.size, outage.localityIds.size);
    score += 0.35 * coef;
    reasons.push(`locality overlap ${(coef * 100).toFixed(0)}%`);
  } else if (sharedLocalities.length && conflictingAssets) {
    score -= 0.3;
    reasons.push('different water asset');
  }
  if (post.waterSystem && outage.waterSystem && squash(post.waterSystem) === squash(outage.waterSystem)) {
    score += 0.15;
    reasons.push('same water system');
  }
  if (outage.digest && !reasons.includes('same thread')) {
    reasons.push('multi-system bulletin');
    score = Math.min(score, 0.3);
  }
  // recent news about the same place is likelier to be the same incident, as for electricity (an update posted the same day)
  if (score > 0) score += 0.1 * Math.exp(-Math.max(0, (post.postedAt - outage.lastUpdateAt) / HOUR) / 24);
  if (score <= 0) return { score: 0, reasons: reasons.length ? reasons : ['no shared thread/asset/locality'] };
  return { score: Math.min(1, Math.max(0, Number(score.toFixed(3)))), reasons };
}
