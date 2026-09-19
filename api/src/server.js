import cron from 'node-cron';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { sweepStaleOutages } from './modules/outages/linker.service.js';
import { cycle } from './modules/processing/cycle.js';

createApp().listen(env.PORT, () => logger.info(`GridWatch API listening on :${env.PORT}`));

const sweep = async () => {
  try {
    logger.info(await sweepStaleOutages(), 'sweep');
  } catch (err) {
    logger.error({ err: err.message }, 'sweep failed');
  }
};
sweep();
setInterval(sweep, 60 * 60 * 1000).unref();

async function tick() {
  const r = await cycle.runNow('scheduler');
  if (r.state === 'error') logger.error({ error: r.error }, 'scheduled tick failed');
  else logger.info(r.result, 'scheduled tick');
}

if (process.env.SCHEDULER !== 'off') cron.schedule(`*/${Math.max(1, env.X_POLL_INTERVAL_MINUTES)} * * * *`, tick);
