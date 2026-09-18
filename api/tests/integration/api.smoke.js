import { prisma } from "../../src/db/prisma.js";
import { createApp } from "../../src/app.js";

const routes = ["/api/posts", "/api/incidents", "/api/localities", "/api/infrastructure", "/api/dashboard/summary"];
const app = createApp({ prisma, schedulerState: {} });
const server = app.listen(0, async () => {
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const route of routes) {
      const response = await fetch(base + route);
      if (!response.ok) throw new Error(`${route} returned ${response.status}: ${await response.text()}`);
      console.log(`${response.status} ${route}`);
    }
  } finally {
    server.close(async () => {
      await prisma.$disconnect();
    });
  }
});
