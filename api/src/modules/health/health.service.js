export function createHealthService({ prisma, schedulerState }) {
  return {
    async readiness() {
      let database = "ok";
      try {
        await prisma.$queryRaw`SELECT 1`;
      } catch {
        database = "error";
      }
      return { status: database === "ok" ? "ok" : "degraded", database, uptimeSeconds: Math.round(process.uptime()) };
    },
    freshness() {
      return { scheduler: schedulerState.lastRunAt ? "ok" : "not_started", lastRunAt: schedulerState.lastRunAt, lastSuccessAt: schedulerState.lastSuccessAt, lastError: schedulerState.lastError };
    },
  };
}
