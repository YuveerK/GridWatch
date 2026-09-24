// Read-only audit. Run from api: node audit/current-data-check.mjs
import { prisma } from '../src/db/prisma.js';
import { env } from '../src/config/env.js';
import { faultItems } from '../src/modules/processing/processor.service.js';
import { checkPostDispositions, effectReadingMismatch, qualityStatus } from '../src/modules/processing/quality.js';
import { inBox } from '../src/modules/geo/geocode.service.js';

try {
  const accounts = await prisma.sourceAccount.findMany();
  const states = await prisma.ingestionState.findMany();
  console.log('ACCOUNTS', JSON.stringify(accounts.map(a => ({ name: a.displayName, active: a.active, municipalityId: a.municipalityId, state: states.find(s => s.accountId === a.externalId) }))));
  console.log('QUALITY', JSON.stringify(await qualityStatus(prisma)));
  const posts = await prisma.sourcePost.findMany({ include: {
    extractions: { where: { promptVersion: env.AI_PROMPT_VERSION }, take: 1 },
    linkDecisions: true, outagePosts: true,
  }});
  const failures = [], staleEffects = [], discarded = [];
  for (const p of posts) {
    const e = p.extractions[0];
    if (!e?.result || /^\s*@\w+/.test(p.noteTweetText || p.text)) continue;
    const items = faultItems(e);
    const v = checkPostDispositions({ expectedIndices: items.map(i => i.faultIndex), decisions: p.linkDecisions, outagePosts: p.outagePosts });
    const info = { id: p.externalId, account: p.sourceAccount, date: p.publishedAt, status: p.processingStatus, text: (p.noteTweetText || p.text).slice(0, 550) };
    if (v.problems.length) failures.push({ ...info, problems: v.problems });
    if (p.outagePosts.some(o => effectReadingMismatch(o.effect, e.result))) staleEffects.push(info);
    if (v.excluded.some(d => ['OUTAGE','UPDATE','RESTORATION','PLANNED_OUTAGE'].includes(items.find(i => i.faultIndex === d.faultIndex)?.extraction.relevance))) discarded.push({ ...info, excluded: v.excluded, entities: e.result.entities, faults: e.result.faults?.length });
  }
  console.log('DISPOSITION_FAILURES', JSON.stringify(failures));
  console.log('STALE_EFFECTS', JSON.stringify(staleEffects));
  console.log('DISCARDED_LINKABLE', JSON.stringify(discarded));
  const review = await prisma.reviewItem.findMany({ where: { status: 'OPEN' }, include: { post: { select: { sourceAccount: true, processingStatus: true, extractions: { where: { promptVersion: env.AI_PROMPT_VERSION }, take: 1 } } } } });
  console.log('REVIEW', JSON.stringify({ total: review.length, irrelevant: review.filter(r => r.post.processingStatus === 'IRRELEVANT').length, codes: review.flatMap(r => r.reasons.map(s => s.code)).reduce((o,k) => ({...o, [k]: (o[k] || 0)+1}), {}) }));
  const outages = await prisma.outage.findMany({ include: { posts: { include: { post: { select: { externalId: true, sourceAccount: true } } } }, nodes: true, localities: { include: { locality: { include: { Region: true } } } } } });
  const municipalityByAccount = new Map(accounts.map(a => [a.displayName, a.municipalityId]));
  console.log('CROSS_ACCOUNT_OUTAGES', JSON.stringify(outages.filter(o => new Set(o.posts.map(p => p.post.sourceAccount)).size > 1).map(o => ({ id:o.id, title:o.title, posts:o.posts.map(p => p.post) }))));
  console.log('WRONG_MUNICIPALITY', JSON.stringify(outages.flatMap(o => {
    const municipalityIds = new Set(o.posts.map(p => municipalityByAccount.get(p.post.sourceAccount)).filter(Boolean));
    return o.localities.filter(l => l.locality.Region && municipalityIds.size && !municipalityIds.has(l.locality.Region.municipalityId)).map(l => ({ id:o.id, title:o.title, locality:l.locality.canonicalName, region:l.locality.Region.name, localityMunicipality:l.locality.Region.municipalityId, sourceMunicipalities:[...municipalityIds], posts:o.posts.map(p => p.post) }));
  })));
  console.log('EMPTY_OUTAGES', JSON.stringify(outages.filter(o => !o.nodes.length && !o.localities.length).map(o => ({ id:o.id, title:o.title, posts:o.posts.map(p => p.post), effects:o.posts.map(p => p.effect) }))));
  const tshwane = await prisma.locality.findMany({ where: { Region: { Municipality: { code: 'TSHWANE' } } }, select: { canonicalName: true, lat: true, lon: true, geoSource: true } });
  console.log('GEOCODER_BOUNDARY', JSON.stringify({ tshwanePlaces: tshwane.length, alreadyPlaced: tshwane.filter(l => l.lat != null).length, rejectedByFallbackBox: tshwane.filter(l => l.lat != null && !inBox(l.lat,l.lon)).length }));
} finally { await prisma.$disconnect(); }
