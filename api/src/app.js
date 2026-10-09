import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from './config/env.js';
import pinoHttp from 'pino-http';
import { logger } from './lib/logger.js';
import { allowedOrigins } from './modules/api/operator-auth.js';
import { router } from './modules/api/routes.js';
import { pushRouter } from './modules/push/push.routes.js';
import { reviewRouter } from './modules/review/routes.js';
import { requireOperator } from './modules/api/operator-auth.js';

export function createApp({ serveWeb = env.SERVE_WEB_CLIENT === 'on',webRoot = fileURLToPath(new URL('../../client/dist/',import.meta.url)) } = {}) {
  const app = express();
  // One short line per problem request; normal traffic (page loads, the 60-second refresh polling) is only logged at LOG_LEVEL=debug.
  // Headers and cookies are never logged.
  app.use(pinoHttp({
    logger,
    serializers: { req: (r) => ({ method: r.method, url: r.url }), res: (r) => ({ statusCode: r.statusCode }) },
    customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'debug'),
    customSuccessMessage: (req, res) => `${req.method} ${req.url} ${res.statusCode}`,
    customErrorMessage: (req, res) => `${req.method} ${req.url} ${res.statusCode}`,
  }));
  // Public reads are open to any site. Anything credentialed (the operator session cookie) is only answered for origins on the
  // CORS_ALLOWED_ORIGINS allowlist, and preflights for the write methods are answered for those origins only.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    const allowed = origin && allowedOrigins().includes(origin);
    res.setHeader('Vary', 'Origin');
    if (allowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
      res.setHeader('Access-Control-Max-Age', '600');
    } else if (req.method === 'GET' || req.method === 'HEAD' || (req.method === 'OPTIONS' && req.headers['access-control-request-method'] === 'GET')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use('/admin/review-cases', requireOperator, express.json({ limit: '128kb' }), reviewRouter);
  app.use(express.json({ limit: '4kb' })); // sign-in and legacy options remain tightly bounded
  app.use(pushRouter);
  app.use(router);
  if (serveWeb) {
    const index = path.join(webRoot,'index.html');
    if (!existsSync(index)) throw new Error('The web build is missing. Run npm run build in client/ before starting GridWatch.');
    const files = express.static(webRoot,{ index: false });
    const apiPath = /^\/(?:v1|admin|health)(?:\/|$)/;
    app.use((req,res,next) => apiPath.test(req.path) ? next() : files(req,res,next));
    app.get(/^(?!\/(?:v1|admin|health)(?:\/|$)).*/, (req,res,next) => {
      if (!req.headers.accept?.includes('text/html') || path.extname(req.path)) return next();
      res.set('Cache-Control','no-store').sendFile(index);
    });
  }
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err?.code === 'still_blocked') return res.status(409).json({ error: err.code, message: err.message });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
    req.log.error({ err }, 'request failed');
    res.status(500).json({ error: 'internal_error' });
  });
  return app;
}
