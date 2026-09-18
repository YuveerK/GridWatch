import { prisma } from "../../src/db/prisma.js";
import { createApp } from "../../src/app.js";

const app = createApp({ prisma, schedulerState: {} });
const server = app.listen(0, async () => {
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/health`);
    console.log(response.status, await response.text());
    process.exitCode = response.ok ? 0 : 1;
  } finally {
    server.close(async () => {
      await prisma.$disconnect();
    });
  }
});
