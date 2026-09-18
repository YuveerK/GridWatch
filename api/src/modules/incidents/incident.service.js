import { notFound } from "../../lib/errors.js";
import { pageResult } from "../../lib/http.js";

function incidentInclude() {
  return { localities: { include: { locality: { include: { region: true } } } }, assets: { include: { asset: true } }, events: { orderBy: { eventAt: "asc" }, include: { post: true, processingRun: { include: { extraction: true } } } } };
}

export function createIncidentService({ prisma }) {
  return {
    async list({ page, pageSize, status, q }) {
      const where = { ...(status ? { status } : {}), ...(q ? { OR: [{ title: { contains: q, mode: "insensitive" } }, { causeText: { contains: q, mode: "insensitive" } }] } : {}) };
      const [items, total] = await prisma.$transaction([
        prisma.outageIncident.findMany({ where, skip: (page - 1) * pageSize, take: pageSize, orderBy: { updatedAt: "desc" }, include: { localities: { include: { locality: true } }, assets: { include: { asset: true } } } }),
        prisma.outageIncident.count({ where }),
      ]);
      return pageResult(items, total, { page, pageSize });
    },
    async get(id) {
      const incident = await prisma.outageIncident.findUnique({ where: { id }, include: incidentInclude() });
      if (!incident) throw notFound("Outage incident");
      return incident;
    },
    async summary() {
      const [active, investigating, restored, needsReview, latestSync] = await prisma.$transaction([
        prisma.outageIncident.count({ where: { status: { in: ["ACTIVE", "INVESTIGATING", "REPAIRING", "RESTORING", "PARTIALLY_RESTORED"] } } }),
        prisma.outageIncident.count({ where: { status: "INVESTIGATING" } }),
        prisma.outageIncident.count({ where: { status: "RESTORED" } }),
        prisma.outageIncident.count({ where: { reviewState: "NEEDS_REVIEW" } }),
        prisma.ingestionRun.findFirst({ where: { status: "SUCCEEDED" }, orderBy: { completedAt: "desc" } }),
      ]);
      return { active, investigating, restored, needsReview, latestSync };
    },
    async merge(targetId, sourceId) {
      if (targetId === sourceId) throw new Error("An incident cannot be merged into itself");
      return prisma.$transaction(async (tx) => {
        const target = await tx.outageIncident.findUnique({ where: { id: targetId } });
        const source = await tx.outageIncident.findUnique({ where: { id: sourceId } });
        if (!target || !source) throw notFound("Outage incident");
        await tx.outageEvent.updateMany({ where: { incidentId: sourceId }, data: { incidentId: targetId } });
        await tx.outageIncident.update({ where: { id: sourceId }, data: { status: "CANCELLED", reviewState: "REVIEWED" } });
        return tx.outageIncident.findUnique({ where: { id: targetId }, include: incidentInclude() });
      });
    },
  };
}
