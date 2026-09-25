-- Service identity. Electricity rows keep working: every new column defaults to ELECTRICITY
-- (or LEGACY_PARENT / ASSOCIATED / EXPLICIT_SOURCE). Water is opt-in.

CREATE TYPE "ServiceType" AS ENUM ('ELECTRICITY', 'WATER');

ALTER TYPE "InfrastructureType" ADD VALUE 'WATER_SYSTEM';
ALTER TYPE "InfrastructureType" ADD VALUE 'RESERVOIR';
ALTER TYPE "InfrastructureType" ADD VALUE 'WATER_TOWER';
ALTER TYPE "InfrastructureType" ADD VALUE 'PUMP_STATION';
ALTER TYPE "InfrastructureType" ADD VALUE 'DIRECT_FEED';
ALTER TYPE "InfrastructureType" ADD VALUE 'BULK_CONNECTION';
ALTER TYPE "InfrastructureType" ADD VALUE 'BULK_METER';
ALTER TYPE "InfrastructureType" ADD VALUE 'BOOSTER_STATION';
ALTER TYPE "InfrastructureType" ADD VALUE 'TREATMENT_WORKS';
ALTER TYPE "InfrastructureType" ADD VALUE 'PRV';
ALTER TYPE "InfrastructureType" ADD VALUE 'WATER_PIPELINE';
ALTER TYPE "InfrastructureType" ADD VALUE 'WATER_OTHER';

CREATE TYPE "InfrastructureRelationType" AS ENUM ('LEGACY_PARENT', 'SUPPLIES', 'PUMPS_TO', 'DIRECTLY_SUPPLIES', 'FEEDS', 'PART_OF', 'UPSTREAM_OF', 'BYPASSES', 'BACKFEEDS');
CREATE TYPE "NodeLocalityRelationType" AS ENUM ('ASSOCIATED', 'SERVES');
CREATE TYPE "KnowledgeSourceType" AS ENUM ('OFFICIAL_WEB', 'OFFICIAL_DOCUMENT', 'MANUAL_CURATED');
CREATE TYPE "ImpactBasis" AS ENUM ('EXPLICIT_SOURCE', 'INFERRED_TOPOLOGY');
CREATE TYPE "WaterOperationalState" AS ENUM ('NORMAL', 'STABLE', 'CONSTRAINED', 'LOW', 'CRITICAL', 'EMPTY', 'NO_INCOMING_SUPPLY', 'NO_PUMPING', 'PUMPING_REDUCED', 'OUTLET_CLOSED', 'PARTIAL_SUPPLY', 'LOW_PRESSURE', 'NO_SUPPLY', 'BYPASS', 'THROTTLED', 'RECOVERING', 'UNKNOWN');

ALTER TABLE "SourceAccount" ADD COLUMN "serviceType" "ServiceType" NOT NULL DEFAULT 'ELECTRICITY';
ALTER TABLE "SourcePost" ADD COLUMN "serviceType" "ServiceType" NOT NULL DEFAULT 'ELECTRICITY';

ALTER TABLE "InfraNode" ADD COLUMN "serviceType" "ServiceType" NOT NULL DEFAULT 'ELECTRICITY';
ALTER TABLE "InfraNode" ADD COLUMN "metadata" JSONB;
ALTER TABLE "InfraNode" ADD COLUMN "lat" DOUBLE PRECISION;
ALTER TABLE "InfraNode" ADD COLUMN "lon" DOUBLE PRECISION;
ALTER TABLE "InfraNode" ADD COLUMN "boundary" JSONB;
ALTER TABLE "InfraNode" ADD COLUMN "geoSource" TEXT;

DROP INDEX IF EXISTS "InfraNode_type_normalizedKey_municipalityId_key";
DROP INDEX IF EXISTS "InfraNode_type_normalizedKey_null_municipality_key";
CREATE UNIQUE INDEX "InfraNode_serviceType_type_normalizedKey_municipalityId_key" ON "InfraNode"("serviceType", "type", "normalizedKey", "municipalityId");
CREATE UNIQUE INDEX "InfraNode_serviceType_type_normalizedKey_null_municipality_key" ON "InfraNode"("serviceType", "type", "normalizedKey") WHERE "municipalityId" IS NULL;
CREATE INDEX "InfraNode_serviceType_municipalityId_idx" ON "InfraNode"("serviceType", "municipalityId");

ALTER TABLE "InfraEdge" ADD COLUMN "relationType" "InfrastructureRelationType" NOT NULL DEFAULT 'LEGACY_PARENT';
ALTER TABLE "InfraEdge" DROP CONSTRAINT "InfraEdge_pkey";
ALTER TABLE "InfraEdge" ADD CONSTRAINT "InfraEdge_pkey" PRIMARY KEY ("parentId", "childId", "relationType");

ALTER TABLE "NodeLocality" ADD COLUMN "relationType" "NodeLocalityRelationType" NOT NULL DEFAULT 'ASSOCIATED';

CREATE TABLE "KnowledgeSource" (
  "id" TEXT NOT NULL,
  "sourceType" "KnowledgeSourceType" NOT NULL,
  "title" TEXT,
  "url" TEXT NOT NULL,
  "publishedAt" TIMESTAMP(3),
  "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "metadata" JSONB,
  CONSTRAINT "KnowledgeSource_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "KnowledgeSource_sourceType_url_key" ON "KnowledgeSource"("sourceType", "url");

CREATE TABLE "InfrastructureEvidence" (
  "id" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "nodeId" TEXT,
  "parentId" TEXT,
  "childId" TEXT,
  "localityId" TEXT,
  "relationType" "InfrastructureRelationType",
  "evidenceKind" TEXT NOT NULL,
  "metadata" JSONB,
  CONSTRAINT "InfrastructureEvidence_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "InfrastructureEvidence_nodeId_idx" ON "InfrastructureEvidence"("nodeId");
CREATE INDEX "InfrastructureEvidence_sourceId_idx" ON "InfrastructureEvidence"("sourceId");
ALTER TABLE "InfrastructureEvidence" ADD CONSTRAINT "InfrastructureEvidence_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "KnowledgeSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Outage" ADD COLUMN "serviceType" "ServiceType" NOT NULL DEFAULT 'ELECTRICITY';
ALTER TABLE "Outage" ADD COLUMN "waterState" "WaterOperationalState";
CREATE INDEX "Outage_serviceType_status_lastUpdateAt_idx" ON "Outage"("serviceType", "status", "lastUpdateAt" DESC);
CREATE INDEX "Outage_municipalityId_serviceType_lastUpdateAt_idx" ON "Outage"("municipalityId", "serviceType", "lastUpdateAt" DESC);

ALTER TABLE "OutageLocality" ADD COLUMN "impactBasis" "ImpactBasis" NOT NULL DEFAULT 'EXPLICIT_SOURCE';
