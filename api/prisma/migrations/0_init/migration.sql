-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "EntityMentionType" AS ENUM ('LOCALITY', 'INFRASTRUCTURE', 'ALIAS', 'RELATIONSHIP');

-- CreateEnum
CREATE TYPE "InfrastructureType" AS ENUM ('SDC', 'SUBSTATION', 'FEEDER', 'DISTRIBUTOR', 'TRANSFORMER', 'MINI_SUBSTATION', 'CABLE', 'SWITCHING_STATION', 'LINE', 'CIRCUIT', 'OTHER');

-- CreateEnum
CREATE TYPE "IngestionRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'RATE_LIMITED');

-- CreateEnum
CREATE TYPE "KnowledgeLifecycle" AS ENUM ('CANDIDATE', 'CONFIRMED', 'DISPUTED', 'REJECTED', 'RETIRED');

-- CreateEnum
CREATE TYPE "OutageStatus" AS ENUM ('ACTIVE', 'INVESTIGATING', 'REPAIRING', 'RESTORING', 'RESTORED', 'PARTIALLY_RESTORED', 'PLANNED', 'CANCELLED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ProcessingRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'RETRYABLE', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "RelationshipType" AS ENUM ('SUPPLIES', 'SERVES', 'CONTAINS', 'BELONGS_TO', 'UPSTREAM_OF', 'DOWNSTREAM_OF', 'CONNECTED_TO', 'LOCATED_IN', 'AFFECTS', 'OTHER');

-- CreateEnum
CREATE TYPE "Relevance" AS ENUM ('OUTAGE', 'PLANNED_OUTAGE', 'RESTORATION', 'UPDATE', 'GENERAL_NOTICE', 'IRRELEVANT');

-- CreateEnum
CREATE TYPE "ResolutionStatus" AS ENUM ('UNRESOLVED', 'CANDIDATE', 'RESOLVED', 'REJECTED', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "ReviewState" AS ENUM ('NONE', 'NEEDS_REVIEW', 'REVIEWED');

-- CreateEnum
CREATE TYPE "SourcePlatform" AS ENUM ('X');

-- CreateEnum
CREATE TYPE "SourcePostProcessingStatus" AS ENUM ('UNPROCESSED', 'IRRELEVANT', 'RELEVANT', 'PROCESSING_ERROR', 'PROCESSING', 'NEEDS_REVIEW', 'GENERAL_NOTICE');

-- CreateTable
CREATE TABLE "AssetAlias" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "normalizedAlias" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "status" "KnowledgeLifecycle" NOT NULL DEFAULT 'CANDIDATE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetLocalityEvidence" (
    "id" TEXT NOT NULL,
    "relationshipId" TEXT NOT NULL,
    "observationId" TEXT,
    "assetId" TEXT NOT NULL,
    "localityId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "evidenceText" TEXT,
    "polarity" TEXT NOT NULL DEFAULT 'SUPPORTING',
    "confidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetLocalityEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetLocalityRelationship" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "relationshipType" "RelationshipType" NOT NULL,
    "localityId" TEXT NOT NULL,
    "status" "KnowledgeLifecycle" NOT NULL DEFAULT 'CANDIDATE',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "evidenceCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssetLocalityRelationship_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EntityMention" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "processingRunId" TEXT,
    "extractionId" TEXT,
    "mentionType" "EntityMentionType" NOT NULL,
    "observedName" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "resolutionStatus" "ResolutionStatus" NOT NULL DEFAULT 'UNRESOLVED',
    "resolvedAssetId" TEXT,
    "resolvedLocalityId" TEXT,
    "confidence" DOUBLE PRECISION,
    "evidenceText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EntityMention_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InfrastructureAsset" (
    "id" TEXT NOT NULL,
    "type" "InfrastructureType" NOT NULL,
    "canonicalName" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "lifecycleStatus" "KnowledgeLifecycle" NOT NULL DEFAULT 'CANDIDATE',
    "reviewState" "ReviewState" NOT NULL DEFAULT 'NONE',
    "createdFromPostId" TEXT,
    "firstObservedAt" TIMESTAMP(3),
    "lastObservedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InfrastructureAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InfrastructureObservation" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "processingRunId" TEXT,
    "extractionId" TEXT,
    "assetId" TEXT,
    "observedName" TEXT NOT NULL,
    "entityType" "InfrastructureType",
    "evidenceSource" TEXT NOT NULL,
    "evidenceText" TEXT,
    "confidence" DOUBLE PRECISION,
    "observationType" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InfrastructureObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InfrastructureRelationship" (
    "id" TEXT NOT NULL,
    "fromAssetId" TEXT NOT NULL,
    "relationshipType" "RelationshipType" NOT NULL,
    "toAssetId" TEXT NOT NULL,
    "status" "KnowledgeLifecycle" NOT NULL DEFAULT 'CANDIDATE',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "evidenceCount" INTEGER NOT NULL DEFAULT 0,
    "firstObservedAt" TIMESTAMP(3),
    "lastObservedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InfrastructureRelationship_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InfrastructureRelationshipEvidence" (
    "id" TEXT NOT NULL,
    "relationshipId" TEXT NOT NULL,
    "observationId" TEXT,
    "postId" TEXT NOT NULL,
    "processingRunId" TEXT,
    "evidenceText" TEXT,
    "polarity" TEXT NOT NULL DEFAULT 'SUPPORTING',
    "confidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InfrastructureRelationshipEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngestionLease" (
    "id" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IngestionLease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngestionRun" (
    "id" TEXT NOT NULL,
    "sourceAccountId" TEXT NOT NULL,
    "status" "IngestionRunStatus" NOT NULL DEFAULT 'RUNNING',
    "checkpointBefore" TEXT,
    "checkpointAfter" TEXT,
    "pagesFetched" INTEGER NOT NULL DEFAULT 0,
    "postsFetched" INTEGER NOT NULL DEFAULT 0,
    "postsInserted" INTEGER NOT NULL DEFAULT 0,
    "postsDeduplicated" INTEGER NOT NULL DEFAULT 0,
    "errorCategory" TEXT,
    "errorMessage" TEXT,
    "diagnostics" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "IngestionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngestionRunPost" (
    "ingestionRunId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IngestionRunPost_pkey" PRIMARY KEY ("ingestionRunId","postId")
);

-- CreateTable
CREATE TABLE "KnowledgeChangeAudit" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actor" TEXT NOT NULL DEFAULT 'system',
    "ruleVersion" TEXT,
    "beforeState" JSONB,
    "afterState" JSONB,
    "sourcePostId" TEXT,
    "observationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeChangeAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Locality" (
    "id" TEXT NOT NULL,
    "canonicalName" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "regionId" TEXT,
    "sourceLabel" TEXT,
    "sourceLine" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Locality_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LocalityAlias" (
    "id" TEXT NOT NULL,
    "localityId" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "normalizedAlias" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "status" "KnowledgeLifecycle" NOT NULL DEFAULT 'CANDIDATE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LocalityAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OcrResult" (
    "id" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "engine" TEXT NOT NULL DEFAULT 'tesseract',
    "engineVersion" TEXT,
    "preprocessVariant" TEXT NOT NULL,
    "text" TEXT,
    "normalizedText" TEXT,
    "confidence" DOUBLE PRECISION,
    "status" "ProcessingRunStatus" NOT NULL,
    "errorMessage" TEXT,
    "diagnostics" JSONB,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OcrResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutageAsset" (
    "incidentId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "evidenceType" TEXT NOT NULL DEFAULT 'CURRENTLY_CONFIRMED',
    "confidence" DOUBLE PRECISION,

    CONSTRAINT "OutageAsset_pkey" PRIMARY KEY ("incidentId","assetId")
);

-- CreateTable
CREATE TABLE "OutageEvent" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "processingRunId" TEXT,
    "eventAt" TIMESTAMP(3) NOT NULL,
    "eventType" TEXT NOT NULL,
    "status" "OutageStatus",
    "summary" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutageIncident" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "OutageStatus" NOT NULL DEFAULT 'UNKNOWN',
    "startedAt" TIMESTAMP(3),
    "reportedAt" TIMESTAMP(3),
    "restoredAt" TIMESTAMP(3),
    "causeText" TEXT,
    "causeConfidence" DOUBLE PRECISION,
    "etaText" TEXT,
    "etaAt" TIMESTAMP(3),
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reviewState" "ReviewState" NOT NULL DEFAULT 'NONE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutageIncident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutageLocality" (
    "incidentId" TEXT NOT NULL,
    "localityId" TEXT NOT NULL,
    "evidenceType" TEXT NOT NULL DEFAULT 'CURRENTLY_CONFIRMED',
    "confidence" DOUBLE PRECISION,

    CONSTRAINT "OutageLocality_pkey" PRIMARY KEY ("incidentId","localityId")
);

-- CreateTable
CREATE TABLE "PostExtraction" (
    "id" TEXT NOT NULL,
    "processingRunId" TEXT NOT NULL,
    "relevance" "Relevance" NOT NULL,
    "summary" TEXT,
    "eventType" TEXT,
    "reportedStatus" TEXT,
    "cause" JSONB,
    "eta" JSONB,
    "restoration" JSONB,
    "referenceNumbers" JSONB,
    "affectedAreas" JSONB,
    "infrastructure" JSONB,
    "relationships" JSONB,
    "aliasObservations" JSONB,
    "recommendedAssociation" JSONB,
    "parsedResult" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostExtraction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostMedia" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "mediaKey" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "durationMs" INTEGER,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostMedia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostProcessingRun" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "status" "ProcessingRunStatus" NOT NULL DEFAULT 'RUNNING',
    "modelName" TEXT,
    "promptVersion" TEXT,
    "schemaVersion" TEXT,
    "errorCategory" TEXT,
    "errorMessage" TEXT,
    "rawModelOutput" JSONB,
    "diagnostics" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,

    CONSTRAINT "PostProcessingRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessingQueueItem" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcessingQueueItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Region" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Region_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceAccount" (
    "id" TEXT NOT NULL,
    "platform" "SourcePlatform" NOT NULL,
    "externalId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SourceAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourcePost" (
    "id" TEXT NOT NULL,
    "platform" "SourcePlatform" NOT NULL DEFAULT 'X',
    "sourceAccount" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "authorId" TEXT,
    "conversationId" TEXT,
    "text" TEXT NOT NULL,
    "language" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "publicMetrics" JSONB,
    "attachments" JSONB,
    "rawPayload" JSONB,
    "processingStatus" "SourcePostProcessingStatus" NOT NULL DEFAULT 'UNPROCESSED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "processingStartedAt" TIMESTAMP(3),
    "noteTweetText" TEXT,

    CONSTRAINT "SourcePost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnresolvedEntityMention" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "observedName" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "mentionType" "EntityMentionType" NOT NULL,
    "status" "ResolutionStatus" NOT NULL DEFAULT 'UNRESOLVED',
    "context" JSONB,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UnresolvedEntityMention_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AssetAlias_normalizedAlias_status_idx" ON "AssetAlias"("normalizedAlias", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AssetAlias_assetId_normalizedAlias_key" ON "AssetAlias"("assetId", "normalizedAlias");

-- CreateIndex
CREATE INDEX "AssetLocalityEvidence_relationshipId_createdAt_idx" ON "AssetLocalityEvidence"("relationshipId", "createdAt");

-- CreateIndex
CREATE INDEX "AssetLocalityRelationship_localityId_status_idx" ON "AssetLocalityRelationship"("localityId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AssetLocalityRelationship_assetId_relationshipType_locality_key" ON "AssetLocalityRelationship"("assetId", "relationshipType", "localityId");

-- CreateIndex
CREATE INDEX "EntityMention_normalizedName_resolutionStatus_idx" ON "EntityMention"("normalizedName", "resolutionStatus");

-- CreateIndex
CREATE INDEX "InfrastructureAsset_normalizedName_lifecycleStatus_idx" ON "InfrastructureAsset"("normalizedName", "lifecycleStatus");

-- CreateIndex
CREATE UNIQUE INDEX "InfrastructureAsset_type_normalizedName_key" ON "InfrastructureAsset"("type", "normalizedName");

-- CreateIndex
CREATE INDEX "InfrastructureObservation_observedName_idx" ON "InfrastructureObservation"("observedName");

-- CreateIndex
CREATE INDEX "InfrastructureObservation_postId_createdAt_idx" ON "InfrastructureObservation"("postId", "createdAt");

-- CreateIndex
CREATE INDEX "InfrastructureRelationship_status_confidence_idx" ON "InfrastructureRelationship"("status", "confidence" DESC);

-- CreateIndex
CREATE INDEX "InfrastructureRelationship_toAssetId_idx" ON "InfrastructureRelationship"("toAssetId");

-- CreateIndex
CREATE UNIQUE INDEX "InfrastructureRelationship_fromAssetId_relationshipType_toA_key" ON "InfrastructureRelationship"("fromAssetId", "relationshipType", "toAssetId");

-- CreateIndex
CREATE INDEX "InfrastructureRelationshipEvidence_relationshipId_createdAt_idx" ON "InfrastructureRelationshipEvidence"("relationshipId", "createdAt");

-- CreateIndex
CREATE INDEX "IngestionRun_sourceAccountId_startedAt_idx" ON "IngestionRun"("sourceAccountId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "KnowledgeChangeAudit_entityType_entityId_createdAt_idx" ON "KnowledgeChangeAudit"("entityType", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "Locality_normalizedName_idx" ON "Locality"("normalizedName");

-- CreateIndex
CREATE UNIQUE INDEX "Locality_regionId_normalizedName_key" ON "Locality"("regionId", "normalizedName");

-- CreateIndex
CREATE INDEX "LocalityAlias_normalizedAlias_idx" ON "LocalityAlias"("normalizedAlias");

-- CreateIndex
CREATE UNIQUE INDEX "LocalityAlias_localityId_normalizedAlias_key" ON "LocalityAlias"("localityId", "normalizedAlias");

-- CreateIndex
CREATE INDEX "OcrResult_mediaId_status_idx" ON "OcrResult"("mediaId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "OcrResult_mediaId_engine_engineVersion_preprocessVariant_key" ON "OcrResult"("mediaId", "engine", "engineVersion", "preprocessVariant");

-- CreateIndex
CREATE INDEX "OutageEvent_incidentId_eventAt_idx" ON "OutageEvent"("incidentId", "eventAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutageEvent_incidentId_postId_key" ON "OutageEvent"("incidentId", "postId");

-- CreateIndex
CREATE INDEX "OutageIncident_status_updatedAt_idx" ON "OutageIncident"("status", "updatedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "PostExtraction_processingRunId_key" ON "PostExtraction"("processingRunId");

-- CreateIndex
CREATE INDEX "PostMedia_postId_idx" ON "PostMedia"("postId");

-- CreateIndex
CREATE UNIQUE INDEX "PostMedia_postId_mediaKey_key" ON "PostMedia"("postId", "mediaKey");

-- CreateIndex
CREATE INDEX "PostProcessingRun_status_startedAt_idx" ON "PostProcessingRun"("status", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PostProcessingRun_postId_attempt_key" ON "PostProcessingRun"("postId", "attempt");

-- CreateIndex
CREATE INDEX "ProcessingQueueItem_status_availableAt_idx" ON "ProcessingQueueItem"("status", "availableAt");

-- CreateIndex
CREATE UNIQUE INDEX "Region_code_key" ON "Region"("code");

-- CreateIndex
CREATE UNIQUE INDEX "SourceAccount_externalId_key" ON "SourceAccount"("externalId");

-- CreateIndex
CREATE INDEX "SourcePost_processingStatus_publishedAt_idx" ON "SourcePost"("processingStatus", "publishedAt");

-- CreateIndex
CREATE INDEX "SourcePost_sourceAccount_publishedAt_idx" ON "SourcePost"("sourceAccount", "publishedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "SourcePost_platform_externalId_key" ON "SourcePost"("platform", "externalId");

-- CreateIndex
CREATE INDEX "UnresolvedEntityMention_normalizedName_status_idx" ON "UnresolvedEntityMention"("normalizedName", "status");

-- AddForeignKey
ALTER TABLE "AssetAlias" ADD CONSTRAINT "AssetAlias_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "InfrastructureAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetLocalityEvidence" ADD CONSTRAINT "AssetLocalityEvidence_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "InfrastructureAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetLocalityEvidence" ADD CONSTRAINT "AssetLocalityEvidence_localityId_fkey" FOREIGN KEY ("localityId") REFERENCES "Locality"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetLocalityEvidence" ADD CONSTRAINT "AssetLocalityEvidence_observationId_fkey" FOREIGN KEY ("observationId") REFERENCES "InfrastructureObservation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetLocalityEvidence" ADD CONSTRAINT "AssetLocalityEvidence_relationshipId_fkey" FOREIGN KEY ("relationshipId") REFERENCES "AssetLocalityRelationship"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetLocalityRelationship" ADD CONSTRAINT "AssetLocalityRelationship_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "InfrastructureAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetLocalityRelationship" ADD CONSTRAINT "AssetLocalityRelationship_localityId_fkey" FOREIGN KEY ("localityId") REFERENCES "Locality"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntityMention" ADD CONSTRAINT "EntityMention_extractionId_fkey" FOREIGN KEY ("extractionId") REFERENCES "PostExtraction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntityMention" ADD CONSTRAINT "EntityMention_postId_fkey" FOREIGN KEY ("postId") REFERENCES "SourcePost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntityMention" ADD CONSTRAINT "EntityMention_processingRunId_fkey" FOREIGN KEY ("processingRunId") REFERENCES "PostProcessingRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InfrastructureObservation" ADD CONSTRAINT "InfrastructureObservation_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "InfrastructureAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InfrastructureObservation" ADD CONSTRAINT "InfrastructureObservation_extractionId_fkey" FOREIGN KEY ("extractionId") REFERENCES "PostExtraction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InfrastructureObservation" ADD CONSTRAINT "InfrastructureObservation_postId_fkey" FOREIGN KEY ("postId") REFERENCES "SourcePost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InfrastructureObservation" ADD CONSTRAINT "InfrastructureObservation_processingRunId_fkey" FOREIGN KEY ("processingRunId") REFERENCES "PostProcessingRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InfrastructureRelationship" ADD CONSTRAINT "InfrastructureRelationship_fromAssetId_fkey" FOREIGN KEY ("fromAssetId") REFERENCES "InfrastructureAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InfrastructureRelationship" ADD CONSTRAINT "InfrastructureRelationship_toAssetId_fkey" FOREIGN KEY ("toAssetId") REFERENCES "InfrastructureAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InfrastructureRelationshipEvidence" ADD CONSTRAINT "InfrastructureRelationshipEvidence_observationId_fkey" FOREIGN KEY ("observationId") REFERENCES "InfrastructureObservation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InfrastructureRelationshipEvidence" ADD CONSTRAINT "InfrastructureRelationshipEvidence_relationshipId_fkey" FOREIGN KEY ("relationshipId") REFERENCES "InfrastructureRelationship"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngestionRun" ADD CONSTRAINT "IngestionRun_sourceAccountId_fkey" FOREIGN KEY ("sourceAccountId") REFERENCES "SourceAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngestionRunPost" ADD CONSTRAINT "IngestionRunPost_ingestionRunId_fkey" FOREIGN KEY ("ingestionRunId") REFERENCES "IngestionRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngestionRunPost" ADD CONSTRAINT "IngestionRunPost_postId_fkey" FOREIGN KEY ("postId") REFERENCES "SourcePost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Locality" ADD CONSTRAINT "Locality_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocalityAlias" ADD CONSTRAINT "LocalityAlias_localityId_fkey" FOREIGN KEY ("localityId") REFERENCES "Locality"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OcrResult" ADD CONSTRAINT "OcrResult_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "PostMedia"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutageAsset" ADD CONSTRAINT "OutageAsset_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "InfrastructureAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutageAsset" ADD CONSTRAINT "OutageAsset_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "OutageIncident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutageEvent" ADD CONSTRAINT "OutageEvent_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "OutageIncident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutageEvent" ADD CONSTRAINT "OutageEvent_postId_fkey" FOREIGN KEY ("postId") REFERENCES "SourcePost"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutageEvent" ADD CONSTRAINT "OutageEvent_processingRunId_fkey" FOREIGN KEY ("processingRunId") REFERENCES "PostProcessingRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutageLocality" ADD CONSTRAINT "OutageLocality_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "OutageIncident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutageLocality" ADD CONSTRAINT "OutageLocality_localityId_fkey" FOREIGN KEY ("localityId") REFERENCES "Locality"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostExtraction" ADD CONSTRAINT "PostExtraction_processingRunId_fkey" FOREIGN KEY ("processingRunId") REFERENCES "PostProcessingRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostMedia" ADD CONSTRAINT "PostMedia_postId_fkey" FOREIGN KEY ("postId") REFERENCES "SourcePost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostProcessingRun" ADD CONSTRAINT "PostProcessingRun_postId_fkey" FOREIGN KEY ("postId") REFERENCES "SourcePost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnresolvedEntityMention" ADD CONSTRAINT "UnresolvedEntityMention_postId_fkey" FOREIGN KEY ("postId") REFERENCES "SourcePost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

