import pino from 'pino';
import { env } from '../config/env.js';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  ...(env.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
});
