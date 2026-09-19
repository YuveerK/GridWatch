import cron from 'node-cron';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { ingestNewPosts } from './modules/ingestion/ingestion.service.js';
import { sweepStaleOutages } from './modules/outages/linker.service.js';
import { processPending } from './modules/processing/processor.service.js';

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

let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    if (env.X_API_BEARER_TOKEN) logger.info(await ingestNewPosts(), 'ingest');
    logger.info(await processPending(), 'process');
    await sweep();
  } catch (err) {
    logger.error({ err: err.message }, 'scheduled tick failed');
  } finally {
    busy = false;
  }
}

if (process.env.SCHEDULER !== 'off') cron.schedule(`*/${Math.max(1, env.X_POLL_INTERVAL_MINUTES)} * * * *`, tick);
