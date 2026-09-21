import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { prisma } from '../../db/prisma.js';
import { TOKEN_SHAPE } from './expo.js';

// A phone registers its Expo push token and says which suburbs it follows. Public on purpose (there are no accounts): the only
// thing a token can do here is receive that phone's own suburb alerts. The token travels in the body or a header, never in a URL.
export const pushRouter = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const off = (_req, res, next) => (env.PUSH_ENABLED === 'on' ? next() : res.status(503).json({ error: 'push_disabled' }));
pushRouter.use('/v1/push', off);

const token = z.string().trim().regex(TOKEN_SHAPE, 'not an Expo push token');
const hour = z.number().int().min(0).max(23);
const register = z.object({ token, platform: z.enum(['ios', 'android']).optional(), quietFrom: hour.nullable().optional(), quietTo: hour.nullable().optional() }).strict();
const follow = z.object({ token, localityIds: z.array(z.string().trim().min(1).max(64)).max(20) }).strict();
const only = z.object({ token }).strict();
const bad = (res, err) => res.status(400).json({ error: 'invalid_request', issues: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });

pushRouter.post('/v1/push/devices', wrap(async (req, res) => {
  const p = register.safeParse(req.body);
  if (!p.success) return bad(res, p.error);
  const { token: t, platform, quietFrom, quietTo } = p.data;
  if ((quietFrom == null) !== (quietTo == null)) return res.status(400).json({ error: 'invalid_request', issues: ['quietFrom and quietTo go together'] });
  const data = { platform: platform ?? null, quietFrom: quietFrom ?? null, quietTo: quietTo ?? null, lastSeenAt: new Date(), disabledAt: null };
  const d = await prisma.pushDevice.upsert({ where: { token: t }, create: { token: t, ...data }, update: data, select: { id: true } });
  res.json({ data: { id: d.id } });
}));

// replaces the list of suburbs the phone follows
pushRouter.put('/v1/push/subscriptions', wrap(async (req, res) => {
  const p = follow.safeParse(req.body);
  if (!p.success) return bad(res, p.error);
  const device = await prisma.pushDevice.findUnique({ where: { token: p.data.token }, select: { id: true } });
  if (!device) return res.status(404).json({ error: 'device_not_registered' });
  const known = await prisma.locality.findMany({ where: { id: { in: p.data.localityIds } }, select: { id: true } });
  await prisma.$transaction([
    prisma.pushSubscription.deleteMany({ where: { deviceId: device.id } }),
    prisma.pushSubscription.createMany({ data: known.map((k) => ({ deviceId: device.id, localityId: k.id })) }),
  ]);
  res.json({ data: { following: known.length, unknown: p.data.localityIds.length - known.length } });
}));

pushRouter.get('/v1/push/subscriptions', wrap(async (req, res) => {
  const t = token.safeParse(req.get('x-push-token'));
  if (!t.success) return bad(res, t.error);
  const d = await prisma.pushDevice.findUnique({ where: { token: t.data }, select: { quietFrom: true, quietTo: true, disabledAt: true, subscriptions: { select: { locality: { select: { id: true, canonicalName: true } } } } } });
  if (!d) return res.status(404).json({ error: 'device_not_registered' });
  res.json({ data: { active: !d.disabledAt, quietFrom: d.quietFrom, quietTo: d.quietTo, suburbs: d.subscriptions.map((s) => ({ id: s.locality.id, name: s.locality.canonicalName })) } });
}));

pushRouter.post('/v1/push/unregister', wrap(async (req, res) => {
  const p = only.safeParse(req.body);
  if (!p.success) return bad(res, p.error);
  await prisma.pushDevice.deleteMany({ where: { token: p.data.token } });
  res.json({ data: { removed: true } });
}));
