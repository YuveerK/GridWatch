import { pageResult } from "../../lib/http.js";
import { normalizeLabel } from "./normalization.js";

export function createGeographyService({ prisma }) {
  return {
    async list({ page, pageSize, q, region }) {
      const normalized = q ? normalizeLabel(q) : undefined;
      const where = { active: true, ...(region ? { region: { code: region } } : {}), ...(normalized ? { OR: [{ normalizedName: { contains: normalized } }, { canonicalName: { contains: q, mode: "insensitive" } }] } : {}) };
      const [items, total] = await prisma.$transaction([
        prisma.locality.findMany({ where, skip: (page - 1) * pageSize, take: pageSize, orderBy: { canonicalName: "asc" }, include: { region: true, aliases: { where: { status: "CONFIRMED" } } } }),
        prisma.locality.count({ where }),
      ]);
      return pageResult(items, total, { page, pageSize });
    },
    async infrastructureForLocality(localityId) {
      return prisma.assetLocalityRelationship.findMany({ where: { localityId }, include: { asset: { include: { aliases: true } } }, orderBy: { confidence: "desc" } });
    },
  };
}
