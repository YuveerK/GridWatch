import cron from "node-cron";
import { config } from "../src/config/env.js";
import { createXClient } from "../src/modules/ingestion/x.client.js";
import { createIngestionService } from "../src/modules/ingestion/ingestion.service.js";
import { processPendingPosts } from "./process-post.job.js";

export function createScheduler({ prisma, state }) {
  const tasks = [];
  const xClient = createXClient({ token: config.X_API_BEARER_TOKEN, timeoutMs: config.X_TIMEOUT_MS });
  const ingestion = createIngestionService({ prisma, xClient, sourceAccount: { externalId: config.X_SOURCE_ACCOUNT_ID, displayName: config.X_SOURCE_ACCOUNT_NAME, platform: "X" } });
  async function poll() {
    state.lastRunAt = new Date().toISOString();
    try {
      if (config.X_SOURCE_ACCOUNT_ID) await ingestion.run();
      await processPendingPosts({ prisma, limit: config.PROCESSING_CONCURRENCY });
      state.lastSuccessAt = new Date().toISOString();
      state.lastError = null;
    } catch (error) {
      state.lastError = error.message;
    }
  }
  return {
    start() { tasks.push(cron.schedule(`*/${Math.max(1, Math.round(config.X_POLL_INTERVAL_MINUTES))} * * * *`, poll)); },
    stop() { for (const task of tasks) task.stop(); },
    poll,
  };
}
