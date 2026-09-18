import { notFound } from "../../lib/errors.js";
import { pageResult } from "../../lib/http.js";
import { normalizeLabel } from "../geography/normalization.js";

export function createInfrastructureService({ prisma }) {
  return {
    async list({ page, pageSize, q, type, status }) {
      const where = { ...(type ? { type } : {}), ...(status ? { lifecycleStatus: status } : {}), ...(q ? { OR: [{ normalizedName: { contains: normalizeLabel(q) } }, { canonicalName: { contains: q, mode: "insensitive" } }, { aliases: { some: { normalizedAlias: { contains: normalizeLabel(q) } } } }] } : {}) };
      const [items, total] = await prisma.$transaction([
        prisma.infrastructureAsset.findMany({ where, skip: (page - 1) * pageSize, take: pageSize, orderBy: { lastObservedAt: "desc" }, include: { aliases: true, localityLinks: { include: { locality: true } } } }),
        prisma.infrastructureAsset.count({ where }),
      ]);
      return pageResult(items, total, { page, pageSize });
    },
    async get(id) {
      const asset = await prisma.infrastructureAsset.findUnique({ where: { id }, include: { aliases: true, localityLinks: { include: { locality: true } }, fromRelationships: { include: { toAsset: true, evidence: true } }, toRelationships: { include: { fromAsset: true, evidence: true } }, observations: { orderBy: { createdAt: "desc" }, take: 100 } } });
      if (!asset) throw notFound("Infrastructure asset");
      return asset;
    },
    async graph(id) {
      const asset = await this.get(id);
      return { id: asset.id, asset: { id: asset.id, name: asset.canonicalName, type: asset.type }, upstream: asset.toRelationships, downstream: asset.fromRelationships };
    },
    async timeline(id) {
      const asset = await prisma.infrastructureAsset.findUnique({ where: { id }, select: { id: true } });
      if (!asset) throw notFound("Infrastructure asset");
      return prisma.infrastructureObservation.findMany({ where: { assetId: id }, orderBy: { createdAt: "asc" }, include: { post: true, processingRun: true } });
    },
    async review() {
      const [assets, aliases, relationships, unresolved] = await prisma.$transaction([
        prisma.infrastructureAsset.findMany({ where: { OR: [{ lifecycleStatus: "CANDIDATE" }, { reviewState: "NEEDS_REVIEW" }] }, include: { aliases: true } }),
        prisma.assetAlias.findMany({ where: { status: "CANDIDATE" }, include: { asset: true } }),
        prisma.infrastructureRelationship.findMany({ where: { status: { in: ["CANDIDATE", "DISPUTED"] } }, include: { fromAsset: true, toAsset: true } }),
        prisma.unresolvedEntityMention.findMany({ where: { status: { in: ["UNRESOLVED", "NEEDS_REVIEW"] } }, orderBy: { createdAt: "desc" }, take: 100 }),
      ]);
      return { assets, aliases, relationships, unresolved };
    },
  };
}
