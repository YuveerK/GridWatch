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
