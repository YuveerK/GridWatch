import express from 'express';
import pinoHttp from 'pino-http';
import { logger } from './lib/logger.js';
import { allowedOrigins } from './modules/api/operator-auth.js';
import { router } from './modules/api/routes.js';
import { pushRouter } from './modules/push/push.routes.js';

export function createApp() {
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
  app.use(express.json({ limit: '4kb' })); // the only bodies are tiny (sign-in, options)
  app.use(pushRouter);
  app.use(router);
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
    req.log.error({ err }, 'request failed');
    res.status(500).json({ error: 'internal_error' });
  });
  return app;
}
