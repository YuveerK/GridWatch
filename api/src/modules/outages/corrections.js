// A correction someone made by hand (scripts/correct-link.js) is evidence of what the engine should have done. Each one becomes a permanent test:
//   JOIN  -> a "same" pair: these two posts belong to one outage
//   SPLIT -> a "different" pair: these two posts must not share an outage (needs the post it was wrongly joined with: --from)
// Pairs use full X post ids (stable across rebuilds) and optionally a fault index for one item of a multi-fault picture.

export const pairKey = (p) => `${[`${p.a}:${p.fa ?? ''}`, `${p.b}:${p.fb ?? ''}`].sort().join('|')}|${p.same ? 'same' : 'different'}`;

/**
 * Pairs from stored overrides. Each row: { postExternalId, faultIndex, action, anchorExternalId, anchorFaultIndex, contrastExternalId, note }.
 * A SPLIT with no contrast post cannot be turned into a pair: it is returned in `needContrast` so the caller can say so.
 */
export function pairsFromOverrides(rows) {
  const pairs = [];
  const needContrast = [];
  for (const r of rows) {
    // A post's faultIndex is a real, meaningful value even when it is 0 (a digest's FIRST fault is not "no particular fault"): omitting it
    // whenever it happens to be 0 would make the pair check every fault of a multi-fault post instead of just the one this correction is
    // about, and could pass by accident through one of its OTHER faults (Gresswold, 22 Sept: two of its faults went to different outages).
    if (r.action === 'JOIN' && r.anchorExternalId) {
      pairs.push({ a: r.postExternalId, ...(r.faultIndex != null ? { fa: r.faultIndex } : {}), b: r.anchorExternalId, ...(r.anchorFaultIndex != null ? { fb: r.anchorFaultIndex } : {}), same: true, why: r.note ?? 'a manual correction' });
    } else if (r.action === 'SPLIT') {
      if (r.contrastExternalId) pairs.push({ a: r.postExternalId, ...(r.faultIndex != null ? { fa: r.faultIndex } : {}), b: r.contrastExternalId, same: false, why: r.note ?? 'a manual correction' });
      else needContrast.push(r.postExternalId);
    }
  }
  return { pairs, needContrast };
}

/** Existing pairs plus new ones, without duplicates; an existing entry (and its wording) wins. */
export function mergePairs(existing, fresh) {
  const seen = new Set(existing.map(pairKey));
  const added = fresh.filter((p) => !seen.has(pairKey(p)));
  return { pairs: [...existing, ...added], added };
}

/**
 * Check pairs against where posts actually are. `outagesOf(externalId, faultIndex|undefined)` returns the set of outage ids that post (or that
 * fault) is in. A pair whose post is missing from the data cannot be judged and is reported separately (never a silent pass).
 */
export function evaluatePairs(pairs, outagesOf) {
  const passed = [];
  const failed = [];
  const unknown = [];
  for (const p of pairs) {
    const A = outagesOf(p.a, p.fa);
    const B = outagesOf(p.b, p.fb);
    if (!A || !B) {
      unknown.push({ pair: p, reason: `post not found: ${!A ? p.a : p.b}` });
      continue;
    }
    const share = [...A].some((id) => B.has(id));
    if (A.size === 0 || B.size === 0) failed.push({ pair: p, reason: `${A.size === 0 ? p.a : p.b} is in no outage` });
    else if (p.same && !share) failed.push({ pair: p, reason: 'should be in the same outage but are in different ones' });
    else if (!p.same && share) failed.push({ pair: p, reason: 'must be in different outages but share one' });
    else passed.push(p);
  }
  return { passed, failed, unknown };
}

const SAST = 2 * 3_600_000;
const toSast = (d) => (d ? new Date(new Date(d).getTime() + SAST).toISOString().slice(0, 16).replace('T', ' ') : null);

/**
 * Final-state expectations: for each `{ post, fault?, expect: { status?, statusIn?, kind?, window?: { start, end }, minPosts?, titleIncludes? } }`
 * compare with the outage that post is in. Windows are Johannesburg time, "YYYY-MM-DD HH:mm".
 */
export function checkState(expectation, outage) {
  const e = expectation.expect ?? {};
  const problems = [];
  if (!outage) return ['the post is in no outage'];
  if (e.status && outage.status !== e.status) problems.push(`status is ${outage.status}, expected ${e.status}`);
  if (e.statusIn && !e.statusIn.includes(outage.status)) problems.push(`status is ${outage.status}, expected one of ${e.statusIn.join('/')}`);
  if (e.kind && outage.kind !== e.kind) problems.push(`kind is ${outage.kind}, expected ${e.kind}`);
  if (e.minPosts && outage.postCount < e.minPosts) problems.push(`has ${outage.postCount} posts, expected at least ${e.minPosts}`);
  if (e.titleIncludes && !String(outage.title).toLowerCase().includes(e.titleIncludes.toLowerCase())) problems.push(`title "${outage.title}" lacks "${e.titleIncludes}"`);
  if (e.window) {
    const got = `${toSast(outage.scheduledStart)} -> ${toSast(outage.scheduledEnd)}`;
    const want = `${e.window.start} -> ${e.window.end}`;
    if (got !== want) problems.push(`window is ${got}, expected ${want}`);
  }
  return problems;
}
