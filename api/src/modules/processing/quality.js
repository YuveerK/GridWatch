import { readingRevision } from '../../lib/reading-revision.js';

// Checks that say whether the engine's WORK is complete and consistent, not just that it ran. Pure functions over rows already read
// from the database, so each rule can be tested on its own and the scripts (npm run batch, npm run audit) stay thin.

/**
 * For one post: every expected fault must have exactly one accepted disposition, a linked disposition must have its timeline entry, and
 * anything intentionally excluded must say why. Returns what is wrong and what was deliberately left out.
 *   expectedIndices: fault numbers the reading calls for (from faultItems)
 *   decisions:  [{ faultIndex, outcome, outageId, reason }]
 *   outagePosts: [{ faultIndex, outageId }]
 */
export function checkPostDispositions({ expectedIndices, decisions, outagePosts }) {
  const problems = [];
  const excluded = [];
  const byIndex = new Map();
  for (const d of decisions) byIndex.set(d.faultIndex, [...(byIndex.get(d.faultIndex) ?? []), d]);
  for (const i of expectedIndices) {
    const ds = byIndex.get(i) ?? [];
    if (ds.length === 0) problems.push(`fault ${i} has no disposition`);
    else if (ds.length > 1) problems.push(`fault ${i} has ${ds.length} dispositions`);
    for (const d of ds) {
      if (d.outcome === 'LINKED') {
        if (!outagePosts.some((p) => p.faultIndex === i && p.outageId === d.outageId)) problems.push(`fault ${i} says linked but has no timeline entry`);
      } else if (d.outcome === 'NEW' && !d.outageId && !outagePosts.some((p) => p.faultIndex === i)) {
        // no outage was created or joined: fine for notices and summaries, but it must be visible, with its reason
        excluded.push({ faultIndex: i, reason: d.reason ?? 'no reason recorded' });
        if (!d.reason) problems.push(`fault ${i} was left out with no reason`);
      } else if (d.outcome === 'NEEDS_REVIEW') {
        problems.push(`fault ${i} needs review: ${d.reason ?? ''}`.trim());
      }
    }
  }
  for (const i of byIndex.keys()) if (!expectedIndices.includes(i)) problems.push(`a disposition exists for fault ${i}, which the current reading does not have`);
  for (const p of outagePosts) if (!expectedIndices.includes(p.faultIndex)) problems.push(`a timeline entry exists for fault ${p.faultIndex}, which the current reading does not have`);
  return { problems, excluded };
}

/** Does an outage effect still match the reading it was built from? null when the effect predates revisions (nothing to compare). */
export function effectReadingMismatch(effect, currentResult) {
  if (!effect?.reading) return null;
  return effect.reading !== readingRevision(currentResult);
}

const HOUR = 3_600_000;
/** Planned work that should have been closed: its announced window ended long ago, or (no window known) nothing was said for `undatedHours`. */
export function plannedOverdue(o, now = Date.now(), { graceHours = 6, undatedHours = 240 } = {}) {
  if (o.status !== 'PLANNED') return false;
  if (o.scheduledEnd) return now - new Date(o.scheduledEnd).getTime() > graceHours * HOUR;
  return now - new Date(o.lastUpdateAt).getTime() > undatedHours * HOUR;
}

/** Posts left in PROCESSING for longer than `maxMinutes`: a worker died mid-post. */
export function stuckProcessing(posts, now = Date.now(), maxMinutes = 30) {
  return posts.filter((p) => p.processingStatus === 'PROCESSING' && p.processingStartedAt && now - new Date(p.processingStartedAt).getTime() > maxMinutes * 60_000);
}

/** The ingestion position is unhealthy: an unfinished sweep of X's timeline, or none completed for `maxHours`. */
export function ingestionProblems(state, now = Date.now(), maxHours = 6) {
  if (!state) return ['no ingestion state recorded yet'];
  const out = [];
  if (state.incomplete) out.push('the last fetch did not finish (the saved position resumes it)');
  if (!state.lastCompletedAt) out.push('no fetch has ever completed');
  else if (now - new Date(state.lastCompletedAt).getTime() > maxHours * HOUR) out.push(`the last completed fetch was over ${maxHours} hours ago`);
  return out;
}

/** The N most recent fetch runs that brought posts, found directly (however many empty polls came after them). */
export async function latestNonemptyRuns(prisma, n = 1) {
  return prisma.ingestionRun.findMany({ where: { postsInserted: { gt: 0 } }, orderBy: { startedAt: 'desc' }, take: Math.max(1, n) });
}
