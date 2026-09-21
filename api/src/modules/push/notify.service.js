import { prisma } from '../../db/prisma.js';
import { logger } from '../../lib/logger.js';
import { buildMessage, classifyChange, inQuietHours, stateAround } from './events.js';
import { sendExpo } from './expo.js';

const HOUR = 3_600_000;
const THROTTLE_MS = 30 * 60_000; // one message per outage per half hour, except a restoration, which is always sent
const WINDOW_HOURS = 3; // only fresh news is announced: a backlog processed hours later is not

/**
 * Look at outage changes since the last pass and tell the phones that follow the affected suburbs. Safe to call as often as
 * you like and from more than one process:
 *   - each post fault is judged once (a row in NotificationEvent claims it BEFORE anything is sent, so a crash can lose a
 *     message but can never send one twice);
 *   - only suburbs City Power actually NAMED count (not the ones we infer from equipment);
 *   - a restoration is always sent; other messages about the same outage are held to one per half hour;
 *   - a phone in its quiet hours gets nothing.
 */
export async function runNotifications({ now = new Date(), send = sendExpo } = {}) {
  const since = new Date(now.getTime() - WINDOW_HOURS * HOUR);
  const fresh = await prisma.outagePost.findMany({
    where: { postedAt: { gte: since }, effect: { not: null } },
    select: { outageId: true, postId: true, faultIndex: true, postedAt: true },
    orderBy: [{ postedAt: 'asc' }, { faultIndex: 'asc' }],
  });
  if (!fresh.length) return { judged: 0, sent: 0 };
  const done = await prisma.notificationEvent.findMany({ where: { postId: { in: [...new Set(fresh.map((f) => f.postId))] } }, select: { postId: true, faultIndex: true } });
  const seen = new Set(done.map((d) => `${d.postId}:${d.faultIndex}`));
  const todo = fresh.filter((f) => !seen.has(`${f.postId}:${f.faultIndex}`));

  let sent = 0;
  for (const item of todo) {
    // claim first: if another pass got there, skip
    const claim = await prisma.notificationEvent.createMany({ data: [{ postId: item.postId, faultIndex: item.faultIndex, outageId: item.outageId, kind: 'PENDING', decision: 'PENDING' }], skipDuplicates: true });
    if (!claim.count) continue;
    const result = await judge(item, { now, send });
    await prisma.notificationEvent.update({ where: { postId_faultIndex: { postId: item.postId, faultIndex: item.faultIndex } }, data: result });
    sent += result.recipients ?? 0;
  }
  return { judged: todo.length, sent };
}

async function judge(item, { now, send }) {
  const outage = await prisma.outage.findUnique({
    where: { id: item.outageId },
    select: { id: true, title: true, kind: true, localities: { select: { localityId: true, locality: { select: { canonicalName: true } } } }, posts: { select: { postId: true, faultIndex: true, postedAt: true, effect: true } } },
  });
  if (!outage) return { kind: 'NONE', decision: 'SKIPPED', reason: 'outage no longer exists' };
  const { before, after } = stateAround(outage.posts, item.postId, item.faultIndex);
  const kind = classifyChange({ before, after, kind: outage.kind });
  if (!kind) return { kind: 'NONE', decision: 'SKIPPED', reason: 'not a change worth a message' };
  if (!outage.localities.length) return { kind, decision: 'SKIPPED', reason: 'City Power named no suburb' };

  if (kind !== 'RESTORED') {
    const recent = await prisma.notificationEvent.findFirst({ where: { outageId: outage.id, decision: 'SENT', createdAt: { gte: new Date(now.getTime() - THROTTLE_MS) } }, select: { postId: true } });
    if (recent) return { kind, decision: 'SKIPPED', reason: 'already told about this outage in the last 30 minutes' };
  }

  const placeById = new Map(outage.localities.map((l) => [l.localityId, l.locality.canonicalName]));
  const devices = await prisma.pushDevice.findMany({
    where: { disabledAt: null, subscriptions: { some: { localityId: { in: [...placeById.keys()] } } } },
    select: { id: true, token: true, quietFrom: true, quietTo: true, subscriptions: { where: { localityId: { in: [...placeById.keys()] } }, select: { localityId: true } } },
  });
  if (!devices.length) return { kind, decision: 'SKIPPED', reason: 'nobody follows these suburbs' };

  const summary = (await prisma.postSummary.findUnique({ where: { postId_faultIndex: { postId: item.postId, faultIndex: item.faultIndex } }, select: { summary: true } }))?.summary ?? null;
  const percent = after.restorationPercent != null && after.restorationPercent < 100 ? Math.round(after.restorationPercent) : null;
  const messages = [];
  for (const d of devices) {
    if (inQuietHours(now, d.quietFrom, d.quietTo)) continue;
    const place = placeById.get(d.subscriptions[0].localityId);
    messages.push({ deviceId: d.id, to: d.token, sound: 'default', data: { outageId: outage.id, kind }, ...buildMessage({ kind, place, outageTitle: outage.title, summary, percent }) });
  }
  if (!messages.length) return { kind, decision: 'SKIPPED', reason: 'everyone is in quiet hours' };

  const results = await send(messages.map(({ deviceId, ...m }) => m));
  const dead = messages.filter((_, i) => results[i]?.invalidToken).map((m) => m.deviceId);
  if (dead.length) {
    await prisma.pushDevice.updateMany({ where: { id: { in: dead } }, data: { disabledAt: now } });
    logger.info({ count: dead.length }, 'push devices switched off (token no longer valid)');
  }
  const ok = results.filter((r) => r?.ok).length;
  return ok ? { kind, decision: 'SENT', recipients: ok, reason: null } : { kind, decision: 'SKIPPED', reason: `send failed: ${results[0]?.error ?? 'unknown'}` };
}
