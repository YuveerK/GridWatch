import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';

const DAY = 24 * 3_600_000;
const SAST_HOURS = 2; // Johannesburg has no daylight saving

/** The kinds of post City Power makes, as residents would sort them. Order is the order shown. */
export const CATEGORIES = [
  { id: 'OUTAGE', label: 'New outages' },
  { id: 'UPDATE', label: 'Updates' },
  { id: 'RESTORATION', label: 'Restorations' },
  { id: 'PLANNED', label: 'Planned work' },
  { id: 'SUMMARY', label: 'Service-centre summaries' },
  { id: 'NOTICE', label: 'Notices' },
  { id: 'REPLY', label: 'Replies to customers' },
  { id: 'OTHER', label: 'Other' },
];
export const CATEGORY_IDS = CATEGORIES.map((c) => c.id);

/** Pure: which kind is a post, from how it was processed and what the reading said it was. */
export function categoryOf(processingStatus, relevance, reply = false) {
  if (reply) return 'REPLY'; // an answer to one customer ("@name Hi, we are following up…")
  if (relevance === 'SDC_SUMMARY') return 'SUMMARY';
  if (relevance === 'GENERAL_NOTICE' || processingStatus === 'GENERAL_NOTICE') return 'NOTICE';
  if (processingStatus === 'RELEVANT') {
    if (relevance === 'OUTAGE') return 'OUTAGE';
    if (relevance === 'UPDATE') return 'UPDATE';
    if (relevance === 'RESTORATION') return 'RESTORATION';
    if (relevance === 'PLANNED_OUTAGE') return 'PLANNED';
  }
  return 'OTHER';
}

/** The Johannesburg calendar day ("2026-09-21") of a moment. */
export const sastDay = (d) => new Date(new Date(d).getTime() + SAST_HOURS * 3_600_000).toISOString().slice(0, 10);

/** The instants a Johannesburg calendar day starts and ends, as UTC. */
export function sastDayRange(day) {
  const start = new Date(`${day}T00:00:00.000Z`);
  start.setTime(start.getTime() - SAST_HOURS * 3_600_000);
  return { start, end: new Date(start.getTime() + DAY) };
}

// publishedAt is stored as UTC wall-clock time without a zone. A bare Date parameter is compared in the database session's own zone, which
// shifts the answer by hours; converting the instant to UTC wall-clock first makes it right wherever the database runs.
const utc = (d) => Prisma.sql`(${d}::timestamptz AT TIME ZONE 'UTC')`;

const LATEST_READING = Prisma.sql`LEFT JOIN LATERAL (SELECT e."relevance"::text AS relevance FROM "PostExtraction" e WHERE e."postId" = sp."id" AND e."status" = 'SUCCEEDED' ORDER BY e."createdAt" DESC LIMIT 1) pe ON true`;

/**
 * Pure: turn (day, processingStatus, relevance, reply, n) rows into one entry per Johannesburg day of the window (zero days included),
 * newest last, each with its total and its count per kind.
 */
export function buildDaily(rows, { days, now = new Date() }) {
  const today = sastDay(now);
  const list = Array.from({ length: days }, (_, k) => sastDay(new Date(new Date(`${today}T12:00:00.000Z`).getTime() - (days - 1 - k) * DAY)));
  const by = new Map(list.map((d) => [d, { date: d, total: 0, byCategory: Object.fromEntries(CATEGORY_IDS.map((c) => [c, 0])) }]));
  for (const r of rows) {
    const day = by.get(r.day);
    if (!day) continue;
    const n = Number(r.n);
    day.total += n;
    day.byCategory[categoryOf(r.ps, r.rel, r.reply)] += n;
  }
  return list.map((d) => by.get(d));
}

/** How many posts City Power made each day (Johannesburg time), by kind, over the last `days` days including today. */
export async function dailyPostCounts({ days = 14, now = new Date() } = {}) {
  const { start } = sastDayRange(sastDay(new Date(now.getTime() - (days - 1) * DAY)));
  const [rows, first] = await Promise.all([
    prisma.$queryRaw`
      SELECT to_char(sp."publishedAt" + interval '2 hours', 'YYYY-MM-DD') AS day, sp."processingStatus"::text AS ps, pe.relevance AS rel, (left(coalesce(sp."noteTweetText", sp."text"), 1) = '@') AS reply, count(*)::int AS n
      FROM "SourcePost" sp ${LATEST_READING}
      WHERE sp."publishedAt" >= ${utc(start)}
      GROUP BY 1, 2, 3, 4`,
    prisma.sourcePost.aggregate({ _min: { publishedAt: true } }),
  ]);
  const daily = buildDaily(rows, { days, now });
  return {
    days,
    categories: CATEGORIES,
    daily,
    total: daily.reduce((n, d) => n + d.total, 0),
    collectedSince: first._min.publishedAt ? sastDay(first._min.publishedAt) : null,
  };
}

const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const tidy = (t) => String(t ?? '').replace(/https?:\/\/\S+/g, '').replace(/\^[A-Z]{2}\b/g, '').replace(/\s+/g, ' ').trim();
/** The post as a person would read it: hashtags off the front, links and sign-offs removed. */
export const readable = (t, max = 360) => {
  const s = tidy(t).replace(/^(#\w+\s*)+/, '').trim();
  return s.length > max ? `${s.slice(0, max - 1).trim()}…` : s;
};

/**
 * Posts, newest first, optionally for one Johannesburg day, one kind, and/or containing some text.
 * `total` is the number matching the filters (not just this page), so a screen can say "48 posts".
 */
export async function listPosts({ from = null, to = null, type = null, q = null, limit = 30, offset = 0 } = {}) {
  const parts = [Prisma.sql`TRUE`];
  if (from) parts.push(Prisma.sql`sp."publishedAt" >= ${utc(sastDayRange(from).start)}`);
  if (to) parts.push(Prisma.sql`sp."publishedAt" < ${utc(sastDayRange(to).end)}`);
  if (q) parts.push(Prisma.sql`coalesce(sp."noteTweetText", sp."text") ILIKE ${`%${escapeLike(q)}%`}`);
  const where = Prisma.join(parts, ' AND ');
  // the kind is decided in SQL (the same rule as categoryOf) so it can be filtered and counted
  const kind = Prisma.sql`CASE
    WHEN left(coalesce(sp."noteTweetText", sp."text"), 1) = '@' THEN 'REPLY'
    WHEN pe.relevance = 'SDC_SUMMARY' THEN 'SUMMARY'
    WHEN pe.relevance = 'GENERAL_NOTICE' OR sp."processingStatus"::text = 'GENERAL_NOTICE' THEN 'NOTICE'
    WHEN sp."processingStatus"::text = 'RELEVANT' AND pe.relevance = 'OUTAGE' THEN 'OUTAGE'
    WHEN sp."processingStatus"::text = 'RELEVANT' AND pe.relevance = 'UPDATE' THEN 'UPDATE'
    WHEN sp."processingStatus"::text = 'RELEVANT' AND pe.relevance = 'RESTORATION' THEN 'RESTORATION'
    WHEN sp."processingStatus"::text = 'RELEVANT' AND pe.relevance = 'PLANNED_OUTAGE' THEN 'PLANNED'
    ELSE 'OTHER' END`;
  const kindFilter = type ? Prisma.sql`WHERE t.kind = ${type}` : Prisma.empty;

  const base = Prisma.sql`
    FROM (SELECT sp."id", sp."externalId", sp."sourceAccount", sp."publishedAt", coalesce(sp."noteTweetText", sp."text") AS body, ${kind} AS kind
          FROM "SourcePost" sp ${LATEST_READING}
          WHERE ${where}) t ${kindFilter}`;
  const [rows, count] = await Promise.all([
    prisma.$queryRaw`
      SELECT t."id", t."externalId", t."sourceAccount", t."publishedAt", t.body, t.kind,
        (SELECT coalesce(json_agg(json_build_object('id', o."id", 'title', o."title", 'status', o."status"::text) ORDER BY o."startedAt"), '[]'::json)
           FROM (SELECT DISTINCT "outageId" FROM "OutagePost" WHERE "postId" = t."id") x JOIN "Outage" o ON o."id" = x."outageId") AS outages
      ${base}
      ORDER BY t."publishedAt" DESC, t."id" ASC
      LIMIT ${limit} OFFSET ${offset}`,
    prisma.$queryRaw`SELECT count(*)::int AS n ${base}`,
  ]);
  const total = count[0]?.n ?? 0;
  return {
    total,
    limit,
    offset,
    hasMore: offset + rows.length < total,
    data: rows.map((r) => ({
      id: r.id,
      externalId: r.externalId,
      postedAt: r.publishedAt,
      day: sastDay(r.publishedAt),
      kind: r.kind,
      text: readable(r.body),
      url: `https://x.com/${r.sourceAccount}/status/${r.externalId}`,
      outages: r.outages ?? [],
    })),
  };
}
