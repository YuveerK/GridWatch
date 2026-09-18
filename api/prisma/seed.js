import { prisma } from "../src/db/prisma.js";
import { config } from "../src/config/env.js";

await prisma.sourceAccount.upsert({ where: { externalId: config.X_SOURCE_ACCOUNT_ID || "citypowerjhb" }, update: { displayName: config.X_SOURCE_ACCOUNT_NAME, active: true }, create: { externalId: config.X_SOURCE_ACCOUNT_ID || "citypowerjhb", platform: "X", displayName: config.X_SOURCE_ACCOUNT_NAME } });
await prisma.$disconnect();
