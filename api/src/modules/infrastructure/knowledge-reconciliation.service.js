import { normalizeLabel } from "../geography/normalization.js";

const assetTypes = new Set(["SDC", "SUBSTATION", "FEEDER", "DISTRIBUTOR", "TRANSFORMER", "MINI_SUBSTATION", "CABLE", "SWITCHING_STATION", "LINE", "CIRCUIT", "OTHER"]);

export function safeAssetType(value) {
  return assetTypes.has(value) ? value : "OTHER";
}

export function createKnowledgeReconciliationService({ prisma }) {
  return {
    async persistExtraction({ post, processingRun, extraction }) {
      const mentions = [];
      const localityByName = new Map();
      const assetByName = new Map();
      for (const area of extraction.affectedAreas ?? []) {
        const normalizedName = normalizeLabel(area.name);
        const locality = await prisma.locality.findFirst({ where: { normalizedName, active: true } });
        if (locality) localityByName.set(normalizedName, locality);
        const mention = await prisma.entityMention.create({ data: { postId: post.id, processingRunId: processingRun.id, extractionId: extraction.id, mentionType: "LOCALITY", observedName: area.name, normalizedName, resolutionStatus: locality ? "RESOLVED" : "UNRESOLVED", resolvedLocalityId: locality?.id, confidence: area.confidence, evidenceText: area.evidence } });
        mentions.push(mention);
        if (!locality) await prisma.unresolvedEntityMention.create({ data: { postId: post.id, observedName: area.name, normalizedName, mentionType: "LOCALITY", context: area } });
      }
      for (const item of extraction.infrastructure ?? []) {
        const normalizedName = normalizeLabel(item.name);
        const type = safeAssetType(item.type);
        const asset = await prisma.infrastructureAsset.upsert({ where: { type_normalizedName: { type, normalizedName } }, update: { lastObservedAt: new Date() }, create: { type, canonicalName: item.name, normalizedName, createdFromPostId: post.id, firstObservedAt: post.publishedAt, lastObservedAt: post.publishedAt } });
        assetByName.set(normalizedName, asset);
        await prisma.entityMention.create({ data: { postId: post.id, processingRunId: processingRun.id, extractionId: extraction.id, mentionType: "INFRASTRUCTURE", observedName: item.name, normalizedName, resolutionStatus: "RESOLVED", resolvedAssetId: asset.id, confidence: item.confidence, evidenceText: item.evidence } });
        await prisma.infrastructureObservation.create({ data: { postId: post.id, processingRunId: processingRun.id, extractionId: extraction.id, assetId: asset.id, observedName: item.name, entityType: type, evidenceSource: item.evidence, confidence: item.confidence, observationType: "ASSET_MENTION", payload: item } });
      }
      for (const alias of extraction.aliasObservations ?? []) {
        const candidate = assetByName.get(normalizeLabel(alias.canonicalCandidateName ?? alias.observedName)) ?? await prisma.infrastructureAsset.findFirst({ where: { normalizedName: normalizeLabel(alias.canonicalCandidateName ?? alias.observedName) } });
        if (candidate) await prisma.assetAlias.upsert({ where: { assetId_normalizedAlias: { assetId: candidate.id, normalizedAlias: normalizeLabel(alias.observedName) } }, update: { confidence: alias.confidence }, create: { assetId: candidate.id, alias: alias.observedName, normalizedAlias: normalizeLabel(alias.observedName), source: "post_observation", confidence: alias.confidence, status: "CANDIDATE" } });
      }
      for (const relationship of extraction.infrastructureRelationships ?? []) {
        const from = assetByName.get(normalizeLabel(relationship.fromName)) ?? await prisma.infrastructureAsset.findFirst({ where: { normalizedName: normalizeLabel(relationship.fromName) } });
        if (!from) continue;
        const relationType = ["SUPPLIES", "SERVES", "CONTAINS", "BELONGS_TO", "UPSTREAM_OF", "DOWNSTREAM_OF", "CONNECTED_TO", "LOCATED_IN", "AFFECTS", "OTHER"].includes(relationship.relationshipType) ? relationship.relationshipType : "OTHER";
        const lifecycle = relationship.explicitlySupportedByCurrentPost && relationship.confidence >= 0.9 ? "CONFIRMED" : "CANDIDATE";
        if (relationship.toEntityType === "LOCALITY") {
          const locality = localityByName.get(normalizeLabel(relationship.toName)) ?? await prisma.locality.findFirst({ where: { normalizedName: normalizeLabel(relationship.toName), active: true } });
          if (!locality) { await prisma.unresolvedEntityMention.create({ data: { postId: post.id, observedName: relationship.toName, normalizedName: normalizeLabel(relationship.toName), mentionType: "RELATIONSHIP", context: relationship } }); continue; }
          const materialized = await prisma.assetLocalityRelationship.upsert({ where: { assetId_relationshipType_localityId: { assetId: from.id, relationshipType: relationType, localityId: locality.id } }, update: { evidenceCount: { increment: 1 }, confidence: { set: Math.max(relationship.confidence, 0) }, status: lifecycle }, create: { assetId: from.id, relationshipType: relationType, localityId: locality.id, status: lifecycle, confidence: relationship.confidence, evidenceCount: 1 } });
          await prisma.assetLocalityEvidence.create({ data: { relationshipId: materialized.id, assetId: from.id, localityId: locality.id, postId: post.id, evidenceText: relationship.evidenceText, confidence: relationship.confidence, polarity: "SUPPORTING" } });
        } else {
          const to = assetByName.get(normalizeLabel(relationship.toName)) ?? await prisma.infrastructureAsset.findFirst({ where: { normalizedName: normalizeLabel(relationship.toName) } });
          if (!to) continue;
          const materialized = await prisma.infrastructureRelationship.upsert({ where: { fromAssetId_relationshipType_toAssetId: { fromAssetId: from.id, relationshipType: relationType, toAssetId: to.id } }, update: { evidenceCount: { increment: 1 }, confidence: { set: Math.max(relationship.confidence, 0) }, status: lifecycle }, create: { fromAssetId: from.id, relationshipType: relationType, toAssetId: to.id, status: lifecycle, confidence: relationship.confidence, evidenceCount: 1, firstObservedAt: post.publishedAt, lastObservedAt: post.publishedAt } });
          await prisma.infrastructureRelationshipEvidence.create({ data: { relationshipId: materialized.id, postId: post.id, processingRunId: processingRun.id, evidenceText: relationship.evidenceText, confidence: relationship.confidence, polarity: "SUPPORTING" } });
        }
      }
      return mentions;
    },
  };
}
