import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const { createApp } = await import('../../src/app.js');
const { prisma, resetDb } = await import('./db.js');

let server;
let base;
beforeAll(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
});
const get = (path) => fetch(`${base}${path}`);

let n = 0;
async function post(iso, text, { status = 'RELEVANT', relevance = 'OUTAGE', outage = null } = {}) {
  n += 1;
  const p = await prisma.sourcePost.create({ data: { id: `pa${n}`, platform: 'X', sourceAccount: 'CityPowerJhb', externalId: String(5000 + n), text, publishedAt: new Date(iso), updatedAt: new Date(iso), processingStatus: status } });
  if (relevance) await prisma.postExtraction.create({ data: { postId: p.id, promptVersion: 'v', model: 'm', status: 'SUCCEEDED', relevance } });
  if (outage) {
    const o = await prisma.outage.create({ data: { title: outage, startedAt: new Date(iso), lastUpdateAt: new Date(iso) } });
    await prisma.outagePost.create({ data: { outageId: o.id, postId: p.id, role: 'OPENED', postedAt: new Date(iso) } });
  }
  return p;
}

beforeEach(async () => {
  await resetDb();
  n = 0;
  await post('2026-09-20T21:30:00Z', 'Fort Substation outage in Hillbrow', { outage: 'Fort (Hillbrow)' }); // 23:30 on 20 Sept in Johannesburg
  await post('2026-09-20T22:30:00Z', 'Fort Substation: 98% restored', { relevance: 'UPDATE' }); // 00:30 on 21 Sept
  await post('2026-09-21T08:00:00Z', 'Power restored at Westbury', { relevance: 'RESTORATION' });
  await post('2026-09-21T09:00:00Z', '@someone Hi, we are following up', { status: 'IRRELEVANT', relevance: null });
  await post('2026-09-21T09:30:00Z', 'Say no to 100% vandalism_now', { status: 'GENERAL_NOTICE', relevance: 'GENERAL_NOTICE' });
});

describe('GET /v1/posts/daily', () => {
  it('counts posts per Johannesburg day by kind, oldest day first', async () => {
    const r = await (await get('/v1/posts/daily?days=90')).json();
    expect(r.total).toBe(4); // the customer reply is not counted
    const byDay = Object.fromEntries(r.daily.filter((d) => d.total).map((d) => [d.date, d]));
    expect(byDay['2026-09-20'].total).toBe(1); // 23:30 is still the 20th in Johannesburg
    expect(byDay['2026-09-21']).toMatchObject({ total: 3, byCategory: { UPDATE: 1, RESTORATION: 1, NOTICE: 1 } });
    expect(r.categories.map((c) => c.id)).not.toContain('REPLY');
    expect(r.daily.at(-1).date >= r.daily[0].date).toBe(true);
  });
  it('rejects a silly window', async () => {
    expect((await get('/v1/posts/daily?days=0')).status).toBe(400);
    expect((await get('/v1/posts/daily?days=500')).status).toBe(400);
  });
});

describe('GET /v1/posts', () => {
  it('lists newest first with the total, a day filter and paging', async () => {
    const all = await (await get('/v1/posts')).json();
    expect(all.total).toBe(4); // customer replies are left out
    expect(all.data[0].text).toMatch(/vandalism/); // newest first
    const day = await (await get('/v1/posts?from=2026-09-21&to=2026-09-21')).json();
    expect(day.total).toBe(3);
    const page = await (await get('/v1/posts?limit=2&offset=0')).json();
    expect(page).toMatchObject({ total: 4, hasMore: true });
    expect(page.data).toHaveLength(2);
    expect((await (await get('/v1/posts?limit=2&offset=3')).json()).hasMore).toBe(false);
  });
  it('filters by kind and searches the text, with % and _ treated as plain characters', async () => {
    expect((await (await get('/v1/posts?type=RESTORATION')).json()).data.map((p) => p.text)).toEqual(['Power restored at Westbury']);
    expect((await get('/v1/posts?type=REPLY')).status).toBe(400); // replies are not a kind any more
    expect((await (await get('/v1/posts?q=fort')).json()).total).toBe(2);
    expect((await (await get('/v1/posts?q=100%25%20vandalism_now')).json()).total).toBe(1);
    expect((await (await get('/v1/posts?q=100%25%20vandalismXnow')).json()).total).toBe(0);
    expect((await (await get('/v1/posts?q=fort&type=UPDATE&from=2026-09-21&to=2026-09-21')).json()).total).toBe(1);
  });
  it('shows the outage a post belongs to and a link to the post on X', async () => {
    const r = await (await get('/v1/posts?q=Hillbrow')).json();
    expect(r.data[0].outages).toMatchObject([{ title: 'Fort (Hillbrow)' }]);
    expect(r.data[0].url).toBe(`https://x.com/CityPowerJhb/status/${r.data[0].externalId}`);
  });
  it('rejects a bad date, an unknown kind and an oversized page', async () => {
    expect((await get('/v1/posts?from=yesterday')).status).toBe(400);
    expect((await get('/v1/posts?from=2026-13-45')).status).toBe(400);
    expect((await get('/v1/posts?type=NOPE')).status).toBe(400);
    expect((await get('/v1/posts?limit=1000')).status).toBe(400);
  });
});
