// Read-only database checks for the 2026-09-20 audit. No external API calls or writes.
import 'dotenv/config';
import { prisma } from '../src/db/prisma.js';
try {
  const [restoredPartial, missingDecision, liveRestoredPlaces, recent] = await Promise.all([
    prisma.outage.count({ where: { status: 'RESTORED', restorationPercent: { lt: 100 } } }),
    prisma.$queryRaw`SELECT COUNT(*)::int AS n FROM "OutagePost" op WHERE NOT EXISTS (SELECT 1 FROM "LinkDecision" ld WHERE ld."postId" = op."postId" AND ld."outageId" = op."outageId" AND ld."faultIndex" = op."faultIndex")`,
    prisma.outageLocality.count({ where: { restored: true, outage: { status: { in: ['ACTIVE', 'PARTIALLY_RESTORED'] } } } }),
    prisma.$queryRaw`SELECT "outageId", "postedAt" FROM "OutagePost" ORDER BY "postedAt" DESC LIMIT 60`,
  ]);
  const first = new Map(), last = new Map();
  for (const row of recent) { if (!first.has(row.outageId)) first.set(row.outageId, row); last.set(row.outageId, row); }
  const shown = [...last.values()].slice(0, 8);
  console.log(JSON.stringify({ restoredWithPartialPercentage: restoredPartial, outagePostsWithoutMatchingDecision: missingDecision[0].n, restoredLocalitiesWithinLiveOutages: liveRestoredPlaces, overviewLatestUpdatesWithOlderTimestamp: shown.filter(row => row.postedAt < first.get(row.outageId).postedAt).length, overviewUpdatesShown: shown.length }, null, 2));
} finally {
  await prisma.$disconnect();
}
