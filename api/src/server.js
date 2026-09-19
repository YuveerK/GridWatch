import { createApp } from './app.js';
import { env } from './config/env.js';
import { prisma } from './db/prisma.js';
import { logger } from './lib/logger.js';
import { createScheduler } from './lib/scheduler.js';
import { sweepStaleOutages } from './modules/outages/linker.service.js';
import { cycle } from './modules/processing/cycle.js';

const server = createApp().listen(env.PORT, () => logger.info(`GridWatch API listening on :${env.PORT}`));

// The sweep takes the same pipeline lease as everything else, so it never runs in the middle of a fetch or a linking pass.
const sweep = async () => {
  try {
    logger.info(await sweepStaleOutages(), 'sweep');
  } catch (err) {
    logger.error({ err: err.message }, 'sweep failed');
  }
};
const schedulerOff = process.env.SCHEDULER === 'off';
if (!schedulerOff) sweep(); // with the scheduler off nothing runs by itself
const sweepSchedule = createScheduler({ intervalMs: 60 * 60 * 1000, tick: sweep, onError: (err) => logger.error({ err: err.message }, 'sweep failed') });
if (!schedulerOff) sweepSchedule.start();

async function tick() {
  const r = await cycle.runNow('scheduler');
  if (r.state === 'error') logger.error({ error: r.error }, 'scheduled tick failed');
  else logger.info(r.result, 'scheduled tick');
}
const fetchSchedule = createScheduler({ intervalMs: env.X_POLL_INTERVAL_MINUTES * 60_000, tick, onError: (err) => logger.error({ err: err.message }, 'scheduled tick failed') });
if (!schedulerOff) fetchSchedule.start();

// Graceful shutdown: stop taking requests and new ticks, let the run in progress reach a safe point (its lease is released
// in its own finally), then close the database. A second signal, or 30 seconds, forces the exit.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return process.exit(1);
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  const force = setTimeout(() => process.exit(1), 30_000);
  force.unref();
  try {
    await Promise.all([fetchSchedule.stop(), sweepSchedule.stop(), new Promise((resolve) => server.close(resolve)), cycle.whenIdle()]);
    await prisma.$disconnect();
  } finally {
    process.exit(0);
  }
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(sig));
