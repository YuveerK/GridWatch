// Read-only stored-data evidence for the 2026-09-24 audit. No paid API calls.
import { prisma } from '../src/db/prisma.js';
import { env } from '../src/config/env.js';
import { readerFor } from '../src/modules/ai/reader-registry.js';
import { isStale } from '../src/modules/ai/extraction.service.js';
import { waterStateFromText } from '../src/modules/outages/water-state.js';
import { checkPostDispositions, qualityStatus, readingFaultItems } from '../src/modules/processing/quality.js';
import { faultItems } from '../src/modules/processing/processor.service.js';

try {
  const report = await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    const accounts = await tx.sourceAccount.findMany();
    const states = await tx.ingestionState.findMany();
    const posts = await tx.sourcePost.findMany({ select: {
      id: true, externalId: true, sourceAccount: true, serviceType: true, processingStatus: true,
      extractions: { select: { promptVersion: true, status: true, result: true, model: true } },
      linkDecisions: { select: { faultIndex: true, outcome: true, outageId: true, reason: true } },
      outagePosts: { select: { faultIndex: true, outageId: true } },
    } });
    const water = posts.filter(p => p.serviceType === 'WATER');
    const readings = water.map(p => ({ p, e: p.extractions.find(e => e.promptVersion === readerFor('WATER').promptVersion && e.status === 'SUCCEEDED') })).filter(x => x.e);
    const effects = await tx.outagePost.findMany({ where: { post: { serviceType: 'WATER' } }, select: {
      faultIndex: true, effect: true, post: { select: { externalId: true, text: true, noteTweetText: true } },
      outage: { select: { id: true, title: true, status: true, waterState: true, restorationPercent: true } },
    } });
    const overridden = effects.filter(p => {
      const parsed = waterStateFromText(p.post.noteTweetText || p.post.text);
      return parsed.waterState === 'RECOVERING' && parsed.customerSupply !== 'RESTORED'
        && p.effect?.waterState && p.effect.waterState !== 'RECOVERING';
    });
    const cycles = await tx.cycleQuality.findMany({ where: { status: { not: 'RUNNING' } }, orderBy: { finishedAt: 'desc' }, take: 10, select: { id: true, status: true, summary: true, posts: true } });
    const waterIds = new Set(water.map(p => p.id));
    const waterCyclePosts = cycles.flatMap(c => (c.posts ?? []).filter(p => waterIds.has(p.postId)).map(p => ({ cycle: c.id, cycleStatus: c.status, externalId: p.externalId, revision: p.revision, faults: p.faults.length })));
    const stale = {};
    for (const p of posts) {
      const pv = readerFor(p.serviceType).promptVersion ?? env.AI_PROMPT_VERSION;
      const e = p.extractions.find(e => e.promptVersion === pv);
      if (!e) continue;
      const row = stale[p.serviceType] ??= { readings: 0, stale: 0 };
      row.readings++;
      if (isStale(e, p.sourceAccount, p.serviceType)) row.stale++;
    }
    const needsAttention = posts.filter(p => ['NEEDS_REVIEW', 'PROCESSING_ERROR'].includes(p.processingStatus)).map(p => ({ externalId: p.externalId, source: p.sourceAccount, status: p.processingStatus }));
    const dispositionProblems = posts.flatMap(p => {
      const pv = readerFor(p.serviceType).promptVersion ?? env.AI_PROMPT_VERSION;
      const e = p.extractions.find(e => e.promptVersion === pv && e.status === 'SUCCEEDED');
      if (!e?.result || /^\s*@\w+/.test(p.text ?? '')) return [];
      const expected = readingFaultItems(p, e, faultItems).map(item => item.faultIndex);
      const verdict = checkPostDispositions({ expectedIndices: expected, decisions: p.linkDecisions, outagePosts: p.outagePosts });
      return verdict.problems.map(problem => ({ externalId: p.externalId, source: p.sourceAccount, status: p.processingStatus, problem }));
    });
    return {
      accounts: accounts.map(a => { const s = states.find(s => s.accountId === a.externalId); return { source: a.displayName, service: a.serviceType, active: a.active, incomplete: s?.incomplete, hasCursor: Boolean(s?.cursorToken), lastCompletedAt: s?.lastCompletedAt }; }),
      quality: await qualityStatus(tx), needsAttention, dispositionProblems, stale,
      water: { total: water.length, acceptedCurrentReadings: readings.length,
        waterVersionReadings: readings.filter(x => x.e.promptVersion !== env.AI_PROMPT_VERSION).length,
        multiFaultReadings: readings.filter(x => (x.e.result?.faults?.length ?? 0) >= 2).length,
        acceptedWithReaderConcern: readings.filter(x => x.e.result?.confidence < .75 || x.e.result?.review_reason).map(x => ({ externalId: x.p.externalId, confidence: x.e.result.confidence, reason: x.e.result.review_reason })).slice(0, 10),
        mixedHeadlineFaults: overridden.map(p => ({ externalId: p.post.externalId, faultIndex: p.faultIndex, effectState: p.effect.waterState, outageState: p.outage.waterState, title: p.outage.title })).slice(0, 10),
        liveAt100: [...new Map(effects.filter(p => ['ACTIVE', 'PARTIALLY_RESTORED'].includes(p.outage.status) && p.outage.restorationPercent === 100).map(p => [p.outage.id, p.outage])).values()],
        recentCycleCoverage: waterCyclePosts.slice(0, 15),
      },
    };
  }, { timeout: 60_000 });
  console.log(JSON.stringify(report, null, 2));
} finally { await prisma.$disconnect(); }
