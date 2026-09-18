import { normalizeLabel } from "../geography/normalization.js";

export function createKnowledgeContextService({ prisma, maxAssets = 25, maxRelationships = 50 }) {
  return {
    async build({ text = "", ocrText = "" }) {
      const candidate = normalizeLabel(`${text} ${ocrText}`);
      if (!candidate) return { assets: [], relationships: [], localities: [] };
      const tokens = candidate.split(" ").filter((token) => token.length >= 3).slice(0, 20);
      const assets = await prisma.infrastructureAsset.findMany({ where: { OR: tokens.map((token) => ({ normalizedName: { contains: token } })) }, take: maxAssets, include: { aliases: true, localityLinks: { include: { locality: true } } } });
      const assetIds = assets.map((asset) => asset.id);
      const relationships = assetIds.length ? await prisma.infrastructureRelationship.findMany({ where: { OR: [{ fromAssetId: { in: assetIds } }, { toAssetId: { in: assetIds } }], status: { in: ["CANDIDATE", "CONFIRMED"] } }, take: maxRelationships, include: { fromAsset: true, toAsset: true } }) : [];
      return { assets, relationships, localities: assets.flatMap((asset) => asset.localityLinks.map((link) => link.locality)) };
    },
  };
}
