const HOUR = 3_600_000;

const squash = (s) => s.toLowerCase().replace(/\s+/g, '');
const intersect = (a, b) => [...a].filter((x) => b.has(x));

/**
 * Score how likely a post belongs to an existing outage (0..1) with human-readable reasons.
 * post:   { kind, relevance, status, nodeIds:Set, relatedNodeIds:Set, localityIds:Set, sdcName, conversationId, postedAt:Date }
 * outage: { kind, status, nodeIds:Set, localityIds:Set, sdcName, conversationIds:Set, lastUpdateAt:Date, restoredAt:Date|null }
 */
export function scoreCandidate(post, outage) {
  const reasons = [];
  let score = 0;

  if (post.conversationId && outage.conversationIds.has(post.conversationId)) {
    score += 0.6;
    reasons.push('same thread');
  }
  // Planned and unplanned events are never the same outage.
  if (post.kind !== outage.kind) return { score: 0, reasons: ['planned/unplanned mismatch'] };

  const sharedNodes = intersect(post.nodeIds, outage.nodeIds);
  if (sharedNodes.length) {
    // A post naming one node should not glue itself to a sprawling multi-node outage.
    const jaccard = sharedNodes.length / new Set([...post.nodeIds, ...outage.nodeIds]).size;
    // A post whose equipment is all inside the outage (e.g. "Central" for a Central-substation fire) is a strong match.
    const containment = sharedNodes.length / post.nodeIds.size;
    const overlap = Math.max(jaccard, 0.8 * containment);
    score += 0.5 * (0.4 + 0.6 * overlap);
    reasons.push(`shared node x${sharedNodes.length} (overlap ${overlap.toFixed(2)})`);
  } else if (intersect(post.relatedNodeIds, outage.nodeIds).length) {
    score += 0.3;
    reasons.push('adjacent node in graph');
  }
  const sharedLocalities = intersect(post.localityIds, outage.localityIds);
  if (sharedLocalities.length) {
    const coef = sharedLocalities.length / Math.min(post.localityIds.size, outage.localityIds.size);
    // Same suburb but demonstrably different infrastructure is weak evidence of the same fault.
    const conflicting = post.nodeIds.size && outage.nodeIds.size && !sharedNodes.length && !intersect(post.relatedNodeIds, outage.nodeIds).length;
    score += 0.4 * coef * (conflicting ? 0.4 : 1);
    reasons.push(`locality overlap ${(coef * 100).toFixed(0)}%`);
  }
  if (score === 0) return { score: 0, reasons: ['no shared thread/node/locality'] };

  // Multi-node digest outages (5+ nodes) must not absorb unrelated single-fault posts.
  if (outage.digest && !reasons.includes('same thread')) {
    reasons.push('digest outage');
    score = Math.min(score, 0.3);
  }

  if (post.sdcName && outage.sdcName && squash(post.sdcName) === squash(outage.sdcName)) score += 0.05;
  else if (post.sdcName && outage.sdcName && !sharedNodes.length) {
    score -= 0.3;
    reasons.push('different SDC');
  }

  const ageH = Math.max(0, (post.postedAt - outage.lastUpdateAt) / HOUR);
  score += 0.1 * Math.exp(-ageH / 24);

  if (outage.status === 'CANCELLED' && post.status !== 'CANCELLED') {
    score -= 0.5;
    reasons.push('outage was cancelled');
  }
  if (outage.status === 'RESTORED') {
    const sinceRestore = (post.postedAt - (outage.restoredAt ?? outage.lastUpdateAt)) / HOUR;
    if (post.relevance === 'RESTORATION' || post.relevance === 'UPDATE') {
      if (sinceRestore > 6) {
        score -= 0.3;
        reasons.push('restoration/update long after restore');
      }
    } else if (sinceRestore > 0.5) {
      score -= 0.5;
      reasons.push('new fault after restoration');
    }
  }
  return { score: Math.min(1, Math.max(0, Number(score.toFixed(3)))), reasons };
}
