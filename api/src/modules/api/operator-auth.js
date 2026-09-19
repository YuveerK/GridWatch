import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';

// Who may run paid or destructive operations (admin routes, the refresh button)?
//   1. a request carrying the operator token:            Authorization: Bearer <OPERATOR_TOKEN>     (scripts, curl)
//   2. a browser session created by signing in once:     HttpOnly cookie signed with a key derived from the token (the refresh button)
//   3. explicitly enabled local development:             ALLOW_LOCAL_OPERATOR=on, loopback connections only, never in production
// Everything else is refused (fail closed). The token never leaves the server: the public client bundle holds no secret.

const COOKIE = 'gw_operator';
const b64 = (buf) => Buffer.from(buf).toString('base64url');

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

const sign = (payload) => b64(createHmac('sha256', `gridwatch-operator-session:${env.OPERATOR_TOKEN}`).update(payload).digest());

export function createSessionValue(now = Date.now(), hours = env.OPERATOR_SESSION_HOURS) {
  const expires = String(now + hours * 3_600_000);
  return `${expires}.${sign(expires)}`;
}

export function sessionIsValid(value, now = Date.now()) {
  if (!env.OPERATOR_TOKEN || !value) return false;
  const [expires, mac] = String(value).split('.');
  return Boolean(expires && mac && Number(expires) > now && safeEqual(mac, sign(expires)));
}

const cookieValue = (req) => {
  const raw = req.headers.cookie ?? '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
};

const LOOPBACK = new Set(['::1', '127.0.0.1', '::ffff:127.0.0.1']);
const isLocalRequest = (req) => LOOPBACK.has(req.socket?.remoteAddress) && !req.headers['x-forwarded-for'] && !req.headers.forwarded;

/** Origins allowed to make credentialed cross-origin calls (the operator client). Same-origin needs no entry. */
export const allowedOrigins = () => env.CORS_ALLOWED_ORIGINS;

/** A browser request is same-origin when its Origin header names this server's own host. */
export function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // not a browser cross-site request (curl, scripts, server-to-server)
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/** How this request is authorized: 'token' | 'session' | 'local' | null. */
export function authorize(req) {
  const auth = req.headers.authorization ?? '';
  if (env.OPERATOR_TOKEN && auth.startsWith('Bearer ') && safeEqual(auth.slice(7), env.OPERATOR_TOKEN)) return 'token';
  if (sessionIsValid(cookieValue(req))) return 'session';
  if (env.ALLOW_LOCAL_OPERATOR === 'on' && env.NODE_ENV !== 'production' && isLocalRequest(req)) return 'local';
  return null;
}

/**
 * Middleware for anything that spends money or changes data. A cookie session is only honoured for requests from an
 * allowed origin, so another website cannot make your browser act on your behalf (CORS alone is not authentication).
 */
export function requireOperator(req, res, next) {
  const via = authorize(req);
  if (!via) return res.status(401).json({ error: 'operator_required' });
  if (via === 'session' && !isSameOrigin(req) && !allowedOrigins().includes(req.headers.origin)) return res.status(403).json({ error: 'origin_not_allowed' });
  req.operator = via;
  return next();
}

// ── sign-in ───────────────────────────────────────────────────────────────────

const failures = new Map(); // ip -> [timestamps]
const WINDOW_MS = 60_000;
const MAX_FAILURES = 5;

export function loginAllowed(ip, now = Date.now()) {
  const recent = (failures.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  failures.set(ip, recent);
  return recent.length < MAX_FAILURES;
}
export const recordLoginFailure = (ip, now = Date.now()) => failures.set(ip, [...(failures.get(ip) ?? []), now]);
export const resetLoginFailures = () => failures.clear();

export function checkToken(candidate) {
  return Boolean(env.OPERATOR_TOKEN) && typeof candidate === 'string' && safeEqual(candidate, env.OPERATOR_TOKEN);
}

export function sessionCookie(req, clear = false) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const parts = [`${COOKIE}=${clear ? '' : encodeURIComponent(createSessionValue())}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${clear ? 0 : env.OPERATOR_SESSION_HOURS * 3600}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}
