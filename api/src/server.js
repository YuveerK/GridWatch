import { config } from "./config/env.js";
import { prisma, disconnectPrisma } from "./db/prisma.js";
import { logger } from "./lib/logger.js";
import { createApp } from "./app.js";
import { createScheduler } from "../jobs/scheduler.js";

const schedulerState = { lastRunAt: null, lastSuccessAt: null, lastError: null };
const app = createApp({ prisma, schedulerState });
const server = app.listen(config.PORT, () => logger.info({ port: config.PORT }, "GridWatch API listening"));
const scheduler = createScheduler({ prisma, state: schedulerState });
scheduler.start();

async function shutdown(signal) {
  logger.info({ signal }, "Shutting down");
  scheduler.stop();
  server.close(async () => {
    await disconnectPrisma();
    process.exit(0);
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
