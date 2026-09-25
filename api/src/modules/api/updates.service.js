import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { outageInMunicipalitySql, postUrl } from './municipality-scope.js';
import { outageInServiceSql, serviceOf } from './service-scope.js';

const DAY = 24 * 3_600_000;

/**
 * What one post said about its outage, read from the stored AI reading. This is what lets posts from before effects were
 * stored be compared with the one before them: the reading is still there, so nothing has to be rewritten in the database.
 * A graphic reporting several faults keeps each fault's own status, percentage and estimate.
 */
export function readingEffect(result, faultIndex = 0) {
  if (!result) return null;
  const faults = result.faults ?? [];
  const perFault = faults.length >= 2 || (faults.length === 1 && result.relevance === 'SDC_SUMMARY');
  const src = perFault ? faults[faultIndex] : result;
  if (!src) return null;
  return { status: src.status ?? null, pct: src.restoration_percent ?? null, eta: src.eta_text ?? null };
}

/**
 * What kind of news is this post for its outage, or null when it changed nothing a resident cares about?
 * Only news is shown: a new outage, power restored, restoration progress, a new estimate, or a change of status.
 * An "update" that repeats what was already said is left out. When neither a stored effect nor a reading exists there is
 * nothing to compare, so the post is kept (better a repeat than a missed restoration).
 */
export function classify({ role, effect, prev }) {
  if (role === 'OPENED') return 'opened';
  if (role === 'RESTORATION' || effect?.status === 'RESTORED') return 'restored';
  if (!effect) return 'update';
  if (!prev) return effect.pct != null ? 'progress' : effect.eta ? 'estimate' : null; // nothing to compare with: news only if it says something concrete
  if (effect.pct != null && effect.pct !== prev.pct) return 'progress';
  if (effect.status && effect.status !== prev.status) return effect.status === 'PARTIALLY_RESTORED' ? 'progress' : 'status';
  if (effect.eta && effect.eta !== prev.eta) return 'estimate';
  return null;
}

/** The latest meaningful updates, newest first. Optionally only for outages that involve one suburb, or of one municipality. */
export async function latestUpdates({ limit = 30, days = 7, localityId = null, municipality = null, service = 'ELECTRICITY', now = new Date() } = {}) {
  const since = new Date(now.getTime() - days * DAY);
  const lookback = new Date(since.getTime() - 5 * DAY); // earlier posts, so the first one in view has something to be compared with
  const area = localityId ? Prisma.sql`AND EXISTS (SELECT 1 FROM "OutageLocality" ol WHERE ol."outageId" = op."outageId" AND ol."localityId" = ${localityId})` : Prisma.empty;
  const rows = await prisma.$queryRaw`
    SELECT op."outageId" AS "outageId", op."postId" AS "postId", op."postedAt" AS "postedAt", op."faultIndex" AS "faultIndex", op."role"::text AS role, op."effect" AS effect,
           o."title" AS title, o."kind"::text AS "outageKind", o."status"::text AS status, o."sdcName" AS sdc, o."restorationPercent" AS percent, o."etaText" AS eta,
           sp."externalId" AS "externalId", sp."sourceAccount" AS "account", sp."createdAt" AS "ingestedAt", ps."summary" AS summary,
           (SELECT pe."result" FROM "PostExtraction" pe WHERE pe."postId" = op."postId" AND pe."status" = 'SUCCEEDED' ORDER BY pe."createdAt" DESC LIMIT 1) AS reading
    FROM "OutagePost" op
    JOIN "Outage" o ON o."id" = op."outageId"
    JOIN "SourcePost" sp ON sp."id" = op."postId"
    LEFT JOIN "PostSummary" ps ON ps."postId" = op."postId" AND ps."faultIndex" = op."faultIndex"
    WHERE op."postedAt" >= ${lookback} ${area} AND ${outageInMunicipalitySql(municipality)} AND ${outageInServiceSql(service)}
    ORDER BY op."outageId", op."postedAt", op."faultIndex", op."postId"`;

  const last = new Map(); // outageId -> the previous post's effect
  const items = [];
  for (const r of rows) {
    const effect = r.effect ?? readingEffect(r.reading, r.faultIndex);
    const prev = last.get(r.outageId) ?? null;
    last.set(r.outageId, effect ?? prev);
    if (r.postedAt < since) continue;
    let kind = classify({ role: r.role, effect, prev });
    // Planned work: every announcement and reminder is news (a repeat may carry a new date), except the all-clear afterwards
    if (r.outageKind === 'PLANNED' && kind !== 'restored') kind = 'planned';
    if (!kind) continue;
    items.push({
      outageId: r.outageId,
      title: r.title,
      status: r.status,
      service: serviceOf(service),
      sdc: r.sdc,
      kind,
      postedAt: r.postedAt,
      ingestedAt: r.ingestedAt,
      summary: r.summary,
      percent: r.percent,
      eta: r.eta,
      url: postUrl(r.account, r.externalId),
    });
  }
  return items.sort((a, b) => b.postedAt - a.postedAt || a.outageId.localeCompare(b.outageId)).slice(0, limit);
}
