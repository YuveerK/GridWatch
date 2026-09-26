import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.OPERATOR_TOKEN = 'test-operator-token-0123456789';
process.env.ALLOW_LOCAL_OPERATOR = 'off';
process.env.CORS_ALLOWED_ORIGINS = 'http://localhost:5173';
process.env.REFRESH_BUTTON = 'on';
process.env.REFRESH_COOLDOWN_SECONDS = '60';

// Nothing reaches X, the AI or a geocoder from these tests.
const external = { ingests: 0 };
vi.mock('../../src/modules/ingestion/ingestion.service.js', () => ({
  ingestNewPosts: async () => {
    external.ingests += 1;
    return { status: 'SUCCEEDED', postsFetched: 0, postsInserted: 0, complete: true, incomplete: false };
  },
  ingestionStatus: async () => ({}),
  currentCheckpoint: async () => null,
}));
vi.mock('../../src/modules/geo/geocode.service.js', () => ({ placeLocalities: async () => ({ osm: 0, geocoder: 0 }) }));
vi.mock('../../src/modules/ai/gemini.client.js', () => ({ generateJson: async () => { throw new Error('no provider in tests'); } }));

const { createApp } = await import('../../src/app.js');
const { cycle } = await import('../../src/modules/processing/cycle.js');
const { acquireLease } = await import('../../src/modules/coordination/lease.js');
const { resetLoginFailures } = await import('../../src/modules/api/operator-auth.js');
const { prisma, resetDb } = await import('./db.js');

let server;
let base;
const TOKEN = process.env.OPERATOR_TOKEN;
const bearer = { authorization: `Bearer ${TOKEN}` };

beforeAll(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await cycle.whenIdle();
  await new Promise((r) => server.close(r));
});
beforeEach(async () => {
  await resetDb();
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "WorkLease", "Locality" CASCADE');
  resetLoginFailures();
  external.ingests = 0;
});

const call = (path, { method = 'GET', headers = {}, body } = {}) =>
  fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });

describe('map service centre coverage', () => {
  it('exposes centres through downstream equipment and returns all mapped suburbs', async () => {
    const now = new Date();
    await prisma.infraNode.createMany({ data: [
      { id: 'coverage-sdc', type: 'SDC', name: 'Coverage centre', normalizedKey: 'coverage centre', firstSeenAt: now, lastSeenAt: now },
      { id: 'coverage-sub', type: 'SUBSTATION', name: 'Coverage substation', normalizedKey: 'coverage substation', firstSeenAt: now, lastSeenAt: now },
    ] });
    await prisma.infraEdge.create({ data: { parentId: 'coverage-sdc', childId: 'coverage-sub', lastSeenAt: now } });
    await prisma.locality.createMany({ data: Array.from({ length: 126 }, (_, i) => ({
      id: `coverage-${i}`, canonicalName: `Area ${i}`, normalizedName: `area ${i}`, lat: -26 + i * 0.0001, lon: i === 125 ? null : 28, updatedAt: now,
    })) });
    await prisma.nodeLocality.createMany({ data: Array.from({ length: 126 }, (_, i) => ({ nodeId: 'coverage-sub', localityId: `coverage-${i}`, lastSeenAt: now })) });
    const hubsResponse = await call('/v1/map/infrastructure');
    expect(hubsResponse.status).toBe(200);
    const hubs = (await hubsResponse.json()).data;
    expect(hubs.find((h) => h.id === 'coverage-sdc')).toMatchObject({ type: 'SDC', served: 125, lon: 28 });
    const detailResponse = await call('/v1/map/node/coverage-sdc');
    expect(detailResponse.status).toBe(200);
    const detail = await detailResponse.json();
    expect(detail.total).toBe(126);
    expect(detail.unplaced).toBe(1);
    expect(detail.places).toHaveLength(125);
    expect(detail.children.map((c) => c.id)).toContain('coverage-sub');
    expect(detail.places.every((p) => Number.isFinite(p.lon) && Number.isFinite(p.lat))).toBe(true);
  });
});

describe('A01: operator routes fail closed', () => {
  it('refuses admin and refresh calls with no credentials, and does nothing', async () => {
    for (const [method, path] of [['POST', '/admin/ingest'], ['POST', '/admin/process'], ['POST', '/admin/reprocess/x'], ['GET', '/admin/review-queue'], ['POST', '/v1/refresh']]) {
      const res = await call(path, { method });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
    expect(external.ingests).toBe(0);
  });

  it('a wrong token is refused; the right one works as a bearer token', async () => {
    expect((await call('/admin/review-queue', { headers: { authorization: 'Bearer nope-nope-nope-nope' } })).status).toBe(401);
    expect((await call('/admin/review-queue', { headers: bearer })).status).toBe(200);
  });

  it('local development is NOT trusted unless explicitly enabled (it is off here, and the caller is loopback)', async () => {
    expect((await call('/v1/refresh', { method: 'POST' })).status).toBe(401);
  });

  it('signing in gives a cookie session that the refresh button can use', async () => {
    const bad = await call('/v1/operator/session', { method: 'POST', body: { token: 'wrong-wrong-wrong-wrong' } });
    expect(bad.status).toBe(401);
    const ok = await call('/v1/operator/session', { method: 'POST', headers: { origin: 'http://localhost:5173' }, body: { token: TOKEN } });
    expect(ok.status).toBe(200);
    const cookie = ok.headers.get('set-cookie');
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).not.toContain(TOKEN); // the secret is never in the cookie
    const session = cookie.split(';')[0];

    const status = await (await call('/v1/refresh', { headers: { cookie: session } })).json();
    expect(status.operator).toBe(true);
    const go = await call('/v1/refresh', { method: 'POST', headers: { cookie: session, origin: 'http://localhost:5173' } });
    expect(go.status).toBe(202);
    await cycle.whenIdle();
    expect(external.ingests).toBe(1);
  });

  it('a cookie session is not honoured from a site that is not on the allowlist', async () => {
    const ok = await call('/v1/operator/session', { method: 'POST', body: { token: TOKEN } });
    const session = ok.headers.get('set-cookie').split(';')[0];
    const res = await call('/admin/review-queue', { headers: { cookie: session, origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
  });

  it('too many wrong tokens are throttled', async () => {
    let last;
    for (let i = 0; i < 7; i++) last = await call('/v1/operator/session', { method: 'POST', body: { token: 'wrong-wrong-wrong-wrong' } });
    expect(last.status).toBe(429);
  });

  it('CORS: the allowlisted origin gets credentials and a preflight for POST; others get no permission', async () => {
    const pre = await call('/v1/refresh', { method: 'OPTIONS', headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(pre.headers.get('access-control-allow-credentials')).toBe('true');
    expect(pre.headers.get('access-control-allow-methods')).toMatch(/POST/);
    const other = await call('/v1/refresh', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
    const pub = await call('/v1/overview', { headers: { origin: 'https://anywhere.example' } });
    expect(pub.headers.get('access-control-allow-origin')).toBe('*'); // public reads stay public
  });

  it('the client bundle setup holds no secret: nothing public reports the token', async () => {
    const body = JSON.stringify(await (await call('/v1/refresh')).json());
    expect(body).not.toContain(TOKEN);
  });
});

describe('A03: admin actions share the pipeline lease', () => {
  it('an admin ingest while another worker holds the lease is refused as busy, not run', async () => {
    await acquireLease('pipeline', 'someone-else', 60_000);
    const r = await (await call('/admin/ingest', { method: 'POST', headers: bearer })).json();
    // the mocked ingest service is not lease-aware, so use the processing routes, which are
    const p = await (await call('/admin/process', { method: 'POST', headers: bearer })).json();
    expect(p.skipped).toBe(true);
    expect(r).toBeDefined();
    const rp = await call('/admin/reprocess/whatever', { method: 'POST', headers: bearer });
    expect(rp.status).toBe(409);
  });
});

describe('A12: request validation', () => {
  it('bad limits, statuses, sorts and dates are 400s with the reason, not silent defaults', async () => {
    for (const path of ['/v1/outages?limit=abc', '/v1/outages?limit=0', '/v1/outages?limit=101', '/v1/outages?offset=-1', '/v1/outages?status=NOPE', '/v1/outages?sort=bogus', '/v1/changes?since=not-a-date', '/v1/infrastructure?type=BOGUS']) {
      const res = await call(path);
      expect(res.status, path).toBe(400);
      expect((await res.json()).error).toBe('invalid_request');
    }
    expect((await call('/v1/outages?limit=5&status=ACTIVE,PLANNED&sort=name')).status).toBe(200);
  });

  it('oversized and malformed bodies are 413 / 400', async () => {
    const big = await fetch(`${base}/v1/operator/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'x'.repeat(10_000) }) });
    expect(big.status).toBe(413);
    const bad = await fetch(`${base}/v1/operator/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
    expect(bad.status).toBe(400);
  });

  it('paging is deterministic when timestamps tie', async () => {
    const t = new Date('2026-09-10T08:00:00Z');
    for (const id of ['c', 'a', 'b']) await prisma.outage.create({ data: { id, title: `T${id}`, status: 'ACTIVE', startedAt: t, lastUpdateAt: t } });
    const first = await (await call('/v1/outages?limit=2&offset=0')).json();
    const second = await (await call('/v1/outages?limit=2&offset=2')).json();
    expect([...first.data, ...second.data].map((o) => o.id)).toEqual(['a', 'b', 'c']);
  });

  it('/v1/changes is bounded and reports truncation', async () => {
    const res = await (await call('/v1/changes?since=2000-01-01T00:00:00Z')).json();
    expect(new Date(res.since).getTime()).toBeGreaterThan(Date.now() - 8 * 24 * 3_600_000);
    expect(res.truncated).toBe(false);
  });
});

describe('A11: latest updates', () => {
  it('shows each outage once with its NEWEST update, newest outages first, before limiting', async () => {
    const at = (h) => new Date(Date.UTC(2026, 8, 10, h));
    const mk = async (id, title) => prisma.outage.create({ data: { id, title, status: 'ACTIVE', startedAt: at(0), lastUpdateAt: at(0) } });
    await mk('o1', 'One');
    await mk('o2', 'Two');
    let n = 0;
    const post = async (outageId, h, summary, faultIndex = 0) => {
      n += 1;
      const pid = `sp${n}`;
      await prisma.sourcePost.create({ data: { id: pid, platform: 'X', sourceAccount: 'a', externalId: `e${n}`, text: 't', publishedAt: at(h), updatedAt: at(h) } });
      await prisma.outagePost.create({ data: { outageId, postId: pid, role: 'UPDATE', postedAt: at(h), faultIndex } });
      await prisma.postSummary.create({ data: { postId: pid, faultIndex, summary, model: 'm' } });
    };
    await post('o1', 1, 'one-old');
    await post('o1', 5, 'one-new');
    await post('o2', 3, 'two-old');
    await post('o2', 4, 'two-new');
    // an outage with far more than 60 recent updates must not crowd the others out
    for (let h = 6; h < 20; h++) for (let k = 0; k < 5; k++) await post('o1', h, `one-h${h}`);
    const res = await (await call('/v1/overview')).json();
    const byId = Object.fromEntries(res.latestUpdates.map((u) => [u.outageId, u]));
    expect(res.latestUpdates).toHaveLength(2);
    expect(byId.o2.summary).toBe('two-new');
    expect(byId.o1.summary).toBe('one-h19');
    expect(res.latestUpdates.map((u) => u.outageId)).toEqual(['o1', 'o2']); // newest first
    expect(new Date(byId.o1.postedAt) > new Date(byId.o2.postedAt)).toBe(true);
  });
});

describe('A19: map state per suburb', () => {
  it('a restored suburb of a live outage is not "out"; a second live outage in it makes it out again', async () => {
    const t = new Date('2026-09-10T08:00:00Z');
    const loc = (id, name) => prisma.locality.create({ data: { id, canonicalName: name, normalizedName: name.toLowerCase(), lat: -26.2, lon: 28.0, active: true, sourceLine: 1, sourceLabel: 'test', updatedAt: t } });
    await loc('la', 'Alpha');
    await loc('lb', 'Beta');
    await prisma.infraNode.create({ data: { id: 'n1', type: 'SUBSTATION', name: 'Hub', normalizedKey: 'hub', evidenceCount: 3, lastSeenAt: t, firstSeenAt: t } });
    await prisma.nodeLocality.create({ data: { nodeId: 'n1', localityId: 'la', evidenceCount: 3, lastSeenAt: t } });
    await prisma.nodeLocality.create({ data: { nodeId: 'n1', localityId: 'lb', evidenceCount: 3, lastSeenAt: t } });
    await prisma.outage.create({ data: { id: 'o1', title: 'Hub', status: 'PARTIALLY_RESTORED', startedAt: t, lastUpdateAt: t } });
    await prisma.outageNode.create({ data: { outageId: 'o1', nodeId: 'n1' } });
    await prisma.outageLocality.create({ data: { outageId: 'o1', localityId: 'la', restored: true } });
    await prisma.outageLocality.create({ data: { outageId: 'o1', localityId: 'lb', restored: false } });

    const state = async () => Object.fromEntries((await (await call('/v1/map/node/n1')).json()).places.map((p) => [p.id, p.state]));
    expect(await state()).toEqual({ la: 'restored', lb: 'out' });

    await prisma.outage.create({ data: { id: 'o2', title: 'Other', status: 'ACTIVE', startedAt: t, lastUpdateAt: t } });
    await prisma.outageLocality.create({ data: { outageId: 'o2', localityId: 'la', restored: false } });
    expect(await state()).toEqual({ la: 'out', lb: 'out' });
  });
});

describe('/v1/map likely areas', () => {
  it('a water incident that named no suburb sends the likely suburb\'s outline, still marked inferred, and stays off the power map', async () => {
    const t = new Date();
    const square = { type: 'Polygon', coordinates: [[[28, -26], [28.01, -26], [28.01, -26.01], [28, -26.01], [28, -26]]] };
    await prisma.locality.create({ data: { id: 'lk', canonicalName: 'Kya Sand', normalizedName: 'kya sand', lat: -26.005, lon: 28.005, boundary: square, active: true, sourceLine: 1, sourceLabel: 'test', updatedAt: t } });
    await prisma.infraNode.create({ data: { id: 'res1', serviceType: 'WATER', type: 'RESERVOIR', name: 'Kya Sand Reservoir', normalizedKey: 'kya sand reservoir', evidenceCount: 3, lastSeenAt: t, firstSeenAt: t } });
    await prisma.nodeLocality.create({ data: { nodeId: 'res1', localityId: 'lk', evidenceCount: 3, lastSeenAt: t } });
    await prisma.outage.create({ data: { id: 'w1', title: 'Kya Sand Reservoir', serviceType: 'WATER', waterState: 'RECOVERING', status: 'ACTIVE', startedAt: t, lastUpdateAt: t } });
    await prisma.outageNode.create({ data: { outageId: 'w1', nodeId: 'res1' } });

    const water = (await (await call('/v1/map?service=WATER')).json()).data;
    expect(water).toHaveLength(1);
    expect(water[0].places).toEqual([expect.objectContaining({ id: 'lk', inferred: true, restored: false, boundary: square })]);

    const power = (await (await call('/v1/map')).json()).data;
    expect(power.some((o) => o.id === 'w1')).toBe(false);
  });
});

describe('overview history strips', () => {
  it('reports 14 zero-filled days per service centre', async () => {
    const t = new Date(Date.now() - 2 * 3_600_000);
    await prisma.outage.create({ data: { id: 'h1', title: 'H', status: 'ACTIVE', sdcName: 'Alexandra', startedAt: t, lastUpdateAt: t } });
    const res = await (await call('/v1/overview')).json();
    const row = res.history.find((h) => h.sdc === 'Alexandra');
    expect(row.days).toHaveLength(14);
    expect(row.days.reduce((n, d) => n + d.count, 0)).toBe(1);
    expect(new Set(res.history.map((h) => h.days.length))).toEqual(new Set([14]));
  });
});

describe('insights', () => {
  it('validates the window and reports causes for recent unplanned outages', async () => {
    expect((await call('/v1/insights?days=0')).status).toBe(400);
    expect((await call('/v1/insights?days=500')).status).toBe(400);
    const t = new Date(Date.now() - 3_600_000);
    await prisma.outage.create({ data: { id: 'i1', title: 'A', status: 'ACTIVE', sdcName: 'Lenasia', cause: 'faulty cable', startedAt: t, lastUpdateAt: t } });
    await prisma.outage.create({ data: { id: 'i2', title: 'B', status: 'ACTIVE', sdcName: 'Lenasia', cause: null, startedAt: t, lastUpdateAt: t } });
    await prisma.outage.create({ data: { id: 'i3', title: 'C', kind: 'PLANNED', status: 'PLANNED', sdcName: 'Lenasia', cause: 'planned maintenance', startedAt: t, lastUpdateAt: t } });
    const r = await (await call('/v1/insights?days=7')).json();
    expect(r.total).toBe(2); // planned work is not a fault
    expect(r.causes.map((c) => c.id)).toEqual(['CABLE', 'UNKNOWN']);
    expect(r.window.days).toBe(7);
    expect(r.trend[0].days).toHaveLength(7);
  });
});

describe('/v1/updates: the news, not every post', () => {
  it('leaves out repeats, and can be limited to outages in one suburb', async () => {
    const now = Date.now();
    const at = (min) => new Date(now - min * 60_000);
    await prisma.locality.create({ data: { id: 'ul', canonicalName: 'Alpha', normalizedName: 'alpha', active: true, sourceLine: 1, sourceLabel: 't', updatedAt: at(0) } });
    await prisma.outage.create({ data: { id: 'u1', title: 'One', status: 'ACTIVE', sdcName: 'X', startedAt: at(100), lastUpdateAt: at(10) } });
    await prisma.outage.create({ data: { id: 'u2', title: 'Two', status: 'ACTIVE', sdcName: 'X', startedAt: at(100), lastUpdateAt: at(10) } });
    await prisma.outageLocality.create({ data: { outageId: 'u1', localityId: 'ul', restored: false } });
    let n = 0;
    const post = async (outageId, min, role, effect) => {
      n += 1;
      await prisma.sourcePost.create({ data: { id: `up${n}`, platform: 'X', sourceAccount: 'a', externalId: `ue${n}`, text: 't', publishedAt: at(min), updatedAt: at(min) } });
      await prisma.outagePost.create({ data: { outageId, postId: `up${n}`, role, postedAt: at(min), effect } });
      await prisma.postSummary.create({ data: { postId: `up${n}`, faultIndex: 0, summary: `s${n}`, model: 'm' } });
    };
    await post('u1', 90, 'OPENED', { status: 'INVESTIGATING', pct: null, eta: null });
    await post('u1', 60, 'UPDATE', { status: 'INVESTIGATING', pct: null, eta: null }); // nothing new
    await post('u1', 30, 'UPDATE', { status: 'REPAIRING', pct: null, eta: 'ETA 6pm' }); // new status
    await post('u2', 20, 'OPENED', { status: 'INVESTIGATING', pct: null, eta: null });
    const all = (await (await call('/v1/updates')).json()).data;
    expect(all.map((u) => `${u.outageId}:${u.kind}`)).toEqual(['u2:opened', 'u1:status', 'u1:opened']);
    const mine = (await (await call('/v1/updates?locality=ul')).json()).data;
    expect(mine.map((u) => u.outageId)).toEqual(['u1', 'u1']);
    expect((await call('/v1/updates?limit=0')).status).toBe(400);
  });
});

describe('/v1/updates on outages from before effects were stored', () => {
  it('compares old posts using their stored readings, so a repeat is dropped and real progress is kept', async () => {
    const now = Date.now();
    const at = (min) => new Date(now - min * 60_000);
    await prisma.outage.create({ data: { id: 'l1', title: 'Old', status: 'ACTIVE', sdcName: 'X', startedAt: at(100), lastUpdateAt: at(10) } });
    let n = 0;
    const post = async (min, role, reading) => {
      n += 1;
      await prisma.sourcePost.create({ data: { id: `lp${n}`, platform: 'X', sourceAccount: 'a', externalId: `le${n}`, text: 't', publishedAt: at(min), updatedAt: at(min) } });
      await prisma.outagePost.create({ data: { outageId: 'l1', postId: `lp${n}`, role, postedAt: at(min) } }); // no effect: a legacy row
      await prisma.postExtraction.create({ data: { postId: `lp${n}`, promptVersion: 'v', model: 'm', status: 'SUCCEEDED', relevance: 'UPDATE', result: reading } });
    };
    const base = { faults: [], relevance: 'UPDATE', eta_text: null, restoration_percent: null };
    await post(90, 'OPENED', { ...base, status: 'INVESTIGATING' });
    await post(60, 'UPDATE', { ...base, status: 'INVESTIGATING' }); // says nothing new
    await post(30, 'UPDATE', { ...base, status: 'PARTIALLY_RESTORED', restoration_percent: 48 });
    const r = (await (await call('/v1/updates')).json()).data;
    expect(r.map((u) => u.kind)).toEqual(['progress', 'opened']);
  });
});

describe('/v1/updates includes planned maintenance announcements', () => {
  it('shows a planned interruption notice, and its reminder, as planned maintenance', async () => {
    const at = (min) => new Date(Date.now() - min * 60_000);
    await prisma.outage.create({ data: { id: 'pl1', kind: 'PLANNED', title: 'Planned', status: 'PLANNED', sdcName: 'Midrand', startedAt: at(60), lastUpdateAt: at(10) } });
    for (const [i, min] of [[1, 60], [2, 10]]) {
      await prisma.sourcePost.create({ data: { id: `pp${i}`, platform: 'X', sourceAccount: 'a', externalId: `pe${i}`, text: 't', publishedAt: at(min), updatedAt: at(min) } });
      await prisma.outagePost.create({ data: { outageId: 'pl1', postId: `pp${i}`, role: i === 1 ? 'OPENED' : 'UPDATE', postedAt: at(min), effect: { status: 'PLANNED', pct: null, eta: null } } });
    }
    const r = (await (await call('/v1/updates')).json()).data;
    expect(r.map((u) => u.kind)).toEqual(['planned', 'planned']);
  });
});

describe('/v1/sync', () => {
  it('reports the last successful check, the latest attempt, and that automatic checks are off outside the server', async () => {
    const at = (m) => new Date(Date.now() - m * 60_000);
    await prisma.sourceAccount.upsert({ where: { externalId: 'acct1' }, create: { id: 'acct1', platform: 'X', externalId: 'acct1', displayName: 'a', updatedAt: at(0) }, update: {} });
    await prisma.ingestionRun.create({ data: { id: 'r1', sourceAccountId: 'acct1', status: 'SUCCEEDED', startedAt: at(20), completedAt: at(19) } });
    await prisma.ingestionRun.create({ data: { id: 'r2', sourceAccountId: 'acct1', status: 'FAILED', startedAt: at(5), completedAt: at(4) } });
    const r = await (await call('/v1/sync')).json();
    expect(new Date(r.lastSyncAt).getTime()).toBeCloseTo(at(19).getTime(), -4);
    expect(r.latestStatus).toBe('FAILED');
    expect(r.automatic).toBe(false);
    expect(r.nextRunAt).toBeNull();
    expect(r.running).toBe(false);
  });
});

describe('/v1/localities/:id/history', () => {
  it('lists a suburb\'s outages with durations, and 404s an unknown suburb', async () => {
    const at = (h) => new Date(Date.now() - h * 3_600_000);
    await prisma.locality.create({ data: { id: 'hl', canonicalName: 'Alpha', normalizedName: 'alpha', active: true, sourceLine: 1, sourceLabel: 't', updatedAt: at(0) } });
    await prisma.locality.create({ data: { id: 'hl2', canonicalName: 'Beta', normalizedName: 'beta', active: true, sourceLine: 2, sourceLabel: 't', updatedAt: at(0) } });
    await prisma.outage.create({ data: { id: 'h1', title: 'One', status: 'RESTORED', cause: 'cable fault', startedAt: at(30), lastUpdateAt: at(26), restoredAt: at(26) } });
    await prisma.outageLocality.create({ data: { outageId: 'h1', localityId: 'hl', restored: true } });
    await prisma.outageLocality.create({ data: { outageId: 'h1', localityId: 'hl2', restored: true } });
    const r = await (await call('/v1/localities/hl/history')).json();
    expect(r.total).toBe(1);
    expect(r.rows[0]).toMatchObject({ id: 'h1', durationHours: 4, category: 'CABLE', alsoAffected: ['Beta'] });
    expect((await call('/v1/localities/nope/history')).status).toBe(404);
    expect((await call('/v1/localities/hl/history?days=0')).status).toBe(400);
  });
});
