import { PrismaClient } from "@prisma/client";
import { logger } from "../lib/logger.js";

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
});

export async function disconnectPrisma() {
  await prisma.$disconnect();
}

process.once("SIGINT", async () => {
  await disconnectPrisma();
  logger.info("Prisma disconnected");
});

process.once("SIGTERM", async () => {
  await disconnectPrisma();
  logger.info("Prisma disconnected");
});
