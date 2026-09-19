import express from 'express';
import pinoHttp from 'pino-http';
import { logger } from './lib/logger.js';
import { router } from './modules/api/routes.js';

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
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN ?? '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json());
  app.use(router);
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    req.log.error({ err }, 'request failed');
    res.status(500).json({ error: 'internal_error' });
  });
  return app;
}
