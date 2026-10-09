// Read-only overview by default. --backfill --apply indexes existing findings under the pipeline lease.
import { prisma } from '../src/db/prisma.js';
import { exclusive } from '../src/modules/coordination/lease.js';
import { reviewSummary } from '../src/modules/review/cases.js';
try {
  const fixture = process.argv.find((a) => a.startsWith('--fixtures='));
  if (fixture) {
    const { exportReviewFixture } = await import('../src/modules/review/fixtures.js');
    console.log(JSON.stringify(await exportReviewFixture(fixture.slice(11),prisma),null,2));
  } else if (process.argv.includes('--coverage')) {
    const { compareReviewCoverage } = await import('../src/modules/review/coverage.js');
    const date = (key) => { const v = process.argv.find((a) => a.startsWith(`--${key}=`));if (!v) return undefined;const d = new Date(v.slice(key.length+3));if (!Number.isFinite(+d)) throw new Error(`Invalid --${key} date`);return d; };
    const result = await compareReviewCoverage(prisma,{ from: date('from'),to: date('to') });
    console.log(JSON.stringify(result,null,2));
    if (!result.passed) process.exitCode = 1;
  } else if (process.argv.includes('--check-stored')) {
    const { checkStoredReview } = await import('../src/modules/review/rollout.js');
    const result = await exclusive(null,(ctx) => checkStoredReview(prisma,ctx));
    if (!result.acquired) throw new Error('Pipeline busy; no stored check was run.');
    console.log(JSON.stringify(result.value,null,2));
  } else if (process.argv.includes('--backfill')) {
    const limitArg = process.argv.find((a) => a.startsWith('--limit='));
    const limit = Number(limitArg?.slice(8) ?? 500);
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new Error('--limit must be 1..5000');
    if (process.argv.includes('--apply')) {
      const { backfillReview } = await import('../src/modules/review/rollout.js');
      const result = await exclusive(null,(ctx) => backfillReview(prisma,{ limit,apply: true,ctx }));
      if (!result.acquired) throw new Error('Pipeline busy; no case records were changed.');
      console.log(JSON.stringify(result.value,null,2));
    } else {
      const { backfillReview } = await import('../src/modules/review/rollout.js');
      console.log(JSON.stringify(await backfillReview(prisma,{ limit }),null,2));
    }
  } else console.log(JSON.stringify(await reviewSummary(prisma),null,2));
} finally { await prisma.$disconnect(); }
