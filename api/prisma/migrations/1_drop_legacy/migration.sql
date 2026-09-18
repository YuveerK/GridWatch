-- Legacy backend tables (all empty) replaced by the new engine schema.
DROP TABLE IF EXISTS "AssetAlias", "AssetLocalityEvidence", "AssetLocalityRelationship",
  "EntityMention", "InfrastructureObservation", "InfrastructureRelationshipEvidence",
  "InfrastructureRelationship", "InfrastructureAsset", "KnowledgeChangeAudit", "OcrResult",
  "OutageAsset", "OutageEvent", "OutageLocality", "OutageIncident", "PostExtraction",
  "PostProcessingRun", "ProcessingQueueItem", "UnresolvedEntityMention" CASCADE;

DROP TYPE IF EXISTS "OutageStatus", "EntityMentionType", "ProcessingRunStatus",
  "RelationshipType", "ResolutionStatus", "ReviewState";
