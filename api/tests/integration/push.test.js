import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const { createApp } = await import('../../src/app.js');
const { runNotifications } = await import('../../src/modules/push/notify.service.js');
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

const TOKEN = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';
const call = (method, path, body, headers = {}) => fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });

const NOW = new Date('2026-09-20T12:00:00Z'); // 14:00 in Johannesburg
const at = (min) => new Date(NOW.getTime() - (60 - min) * 60_000); // minutes into the hour before NOW
const eff = (status, extra = {}) => ({ status, pct: null, cause: null, eta: null, headlineLocalities: [], locs: [], nodeIds: [], expand: true, retroactive: false, ...extra });

let n = 0;
async function post(min) {
  n += 1;
  return prisma.sourcePost.create({ data: { id: `pp${n}`, platform: 'X', sourceAccount: 'a', externalId: String(7000 + n), text: 't', publishedAt: at(min), updatedAt: at(min), conversationId: String(7000 + n) } });
}
async function outageWith(localityIds, steps) {
  const o = await prisma.outage.create({ data: { title: 'Fort (Hillbrow)', kind: 'UNPLANNED', status: 'ACTIVE', startedAt: at(0), lastUpdateAt: at(0), localities: { create: localityIds.map((id) => ({ localityId: id })) } } });
  for (const [i, [min, e]] of steps.entries()) {
    const p = await post(min);
    await prisma.outagePost.create({ data: { outageId: o.id, postId: p.id, role: i === 0 ? 'OPENED' : 'UPDATE', postedAt: at(min), effect: e } });
  }
  return o;
}
const follow = async (token, ids, extra = {}) => {
  await call('POST', '/v1/push/devices', { token, platform: 'android', ...extra });
  return call('PUT', '/v1/push/subscriptions', { token, localityIds: ids });
};
const sender = () => {
  const sent = [];
  return { sent, send: async (msgs) => { sent.push(...msgs); return msgs.map(() => ({ ok: true })); } };
};

beforeEach(async () => {
  await resetDb();
  n = 0;
  const upd = new Date();
  await prisma.locality.createMany({ data: [{ id: 'hillbrow', canonicalName: 'Hillbrow', normalizedName: 'hillbrow', updatedAt: upd }, { id: 'berea', canonicalName: 'Berea', normalizedName: 'berea', updatedAt: upd }] });
});

describe('device registration', () => {
  it('registers a phone, follows suburbs (unknown ones are counted, not stored) and reads them back', async () => {
    expect((await call('POST', '/v1/push/devices', { token: TOKEN, platform: 'ios' })).status).toBe(200);
    const r = await (await call('PUT', '/v1/push/subscriptions', { token: TOKEN, localityIds: ['hillbrow', 'nowhere'] })).json();
    expect(r.data).toEqual({ following: 1, unknown: 1 });
    const back = await (await call('GET', '/v1/push/subscriptions', undefined, { 'x-push-token': TOKEN })).json();
    expect(back.data.suburbs).toEqual([{ id: 'hillbrow', name: 'Hillbrow' }]);
  });
  it('refuses anything that is not an Expo token, a stranger phone, too many suburbs, and half a quiet window', async () => {
    expect((await call('POST', '/v1/push/devices', { token: 'nope' })).status).toBe(400);
    expect((await call('PUT', '/v1/push/subscriptions', { token: TOKEN, localityIds: ['hillbrow'] })).status).toBe(404);
    await call('POST', '/v1/push/devices', { token: TOKEN });
    expect((await call('PUT', '/v1/push/subscriptions', { token: TOKEN, localityIds: Array.from({ length: 21 }, (_, i) => `l${i}`) })).status).toBe(400);
    expect((await call('POST', '/v1/push/devices', { token: TOKEN, quietFrom: 22 })).status).toBe(400);
  });
  it('unregistering removes the phone and its suburbs', async () => {
    await follow(TOKEN, ['hillbrow']);
    await call('POST', '/v1/push/unregister', { token: TOKEN });
    expect(await prisma.pushDevice.count()).toBe(0);
    expect(await prisma.pushSubscription.count()).toBe(0);
  });
});

describe('notifications', () => {
  it('tells a follower about a new outage, once, however often the pass runs', async () => {
    await follow(TOKEN, ['hillbrow']);
    await outageWith(['hillbrow'], [[5, eff('INVESTIGATING')]]);
    const s = sender();
    expect(await runNotifications({ now: NOW, send: s.send })).toEqual({ judged: 1, sent: 1 });
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toMatchObject({ to: TOKEN, title: 'Hillbrow: power outage reported' });
    await runNotifications({ now: NOW, send: s.send });
    expect(s.sent).toHaveLength(1);
  });

  it('does not tell someone who follows a different suburb, and records that nobody was told', async () => {
    await follow(TOKEN, ['berea']);
    await outageWith(['hillbrow'], [[5, eff('INVESTIGATING')]]);
    const s = sender();
    await runNotifications({ now: NOW, send: s.send });
    expect(s.sent).toHaveLength(0);
    expect((await prisma.notificationEvent.findFirst()).reason).toMatch(/nobody follows/);
  });

  it('sends a restoration even right after another message, but holds an ordinary change for half an hour', async () => {
    await follow(TOKEN, ['hillbrow']);
    await outageWith(['hillbrow'], [[5, eff('INVESTIGATING')], [10, eff('PARTIALLY_RESTORED', { pct: 60 })], [20, eff('RESTORED', { pct: 100 })]]);
    const s = sender();
    await runNotifications({ now: NOW, send: s.send });
    expect(s.sent.map((m) => m.title)).toEqual(['Hillbrow: power outage reported', 'Hillbrow: power restored']);
    const held = await prisma.notificationEvent.findMany({ where: { reason: { contains: 'last 30 minutes' } } });
    expect(held).toHaveLength(1);
  });

  it('sends nothing during a phone\'s quiet hours, and nothing when City Power named no suburb', async () => {
    await follow(TOKEN, ['hillbrow'], { quietFrom: 13, quietTo: 15 });
    await outageWith(['hillbrow'], [[5, eff('INVESTIGATING')]]);
    await outageWith([], [[6, eff('INVESTIGATING')]]);
    const s = sender();
    await runNotifications({ now: NOW, send: s.send });
    expect(s.sent).toHaveLength(0);
    const reasons = (await prisma.notificationEvent.findMany()).map((e) => e.reason).sort();
    expect(reasons).toEqual(['City Power named no suburb', 'everyone is in quiet hours']);
  });

  it('ignores news older than three hours, and switches off a phone whose token is dead', async () => {
    await follow(TOKEN, ['hillbrow']);
    await outageWith(['hillbrow'], [[5, eff('INVESTIGATING')]]);
    const dead = async (msgs) => msgs.map(() => ({ ok: false, error: 'DeviceNotRegistered', invalidToken: true }));
    await runNotifications({ now: NOW, send: dead });
    expect((await prisma.pushDevice.findFirst()).disabledAt).not.toBeNull();
    // three hours later the same news is too old to announce, so a fresh pass judges nothing new
    const s = sender();
    expect(await runNotifications({ now: new Date(NOW.getTime() + 4 * 3_600_000), send: s.send })).toEqual({ judged: 0, sent: 0 });
  });
});
