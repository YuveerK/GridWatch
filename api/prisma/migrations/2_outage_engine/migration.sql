-- CreateEnum
CREATE TYPE "ExtractionStatus" AS ENUM ('SUCCEEDED', 'FAILED', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "OutageStatus" AS ENUM ('ACTIVE', 'PARTIALLY_RESTORED', 'RESTORED', 'CLOSED', 'PLANNED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OutageKind" AS ENUM ('UNPLANNED', 'PLANNED');

-- CreateEnum
CREATE TYPE "OutagePostRole" AS ENUM ('OPENED', 'UPDATE', 'RESTORATION');

-- CreateEnum
CREATE TYPE "LinkOutcome" AS ENUM ('LINKED', 'NEW', 'NEEDS_REVIEW');

-- AlterEnum
ALTER TYPE "InfrastructureType" ADD VALUE 'KIOSK';

-- CreateTable
CREATE TABLE "PostExtraction" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "status" "ExtractionStatus" NOT NULL,
    "relevance" "Relevance",
    "result" JSONB,
    "imageText" TEXT,
    "imageCount" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "durationMs" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostExtraction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InfraNode" (
    "id" TEXT NOT NULL,
    "type" "InfrastructureType" NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedKey" TEXT NOT NULL,
    "lifecycle" "KnowledgeLifecycle" NOT NULL DEFAULT 'CANDIDATE',
    "evidenceCount" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InfraNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NodeAlias" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "normalizedKey" TEXT NOT NULL,

    CONSTRAINT "NodeAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InfraEdge" (
    "parentId" TEXT NOT NULL,
    "childId" TEXT NOT NULL,
    "evidenceCount" INTEGER NOT NULL DEFAULT 1,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InfraEdge_pkey" PRIMARY KEY ("parentId","childId")
);

-- CreateTable
CREATE TABLE "NodeLocality" (
    "nodeId" TEXT NOT NULL,
    "localityId" TEXT NOT NULL,
    "evidenceCount" INTEGER NOT NULL DEFAULT 1,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NodeLocality_pkey" PRIMARY KEY ("nodeId","localityId")
);

-- CreateTable
CREATE TABLE "Outage" (
    "id" TEXT NOT NULL,
    "kind" "OutageKind" NOT NULL DEFAULT 'UNPLANNED',
    "status" "OutageStatus" NOT NULL DEFAULT 'ACTIVE',
    "title" TEXT NOT NULL,
    "sdcName" TEXT,
    "cause" TEXT,
    "etaText" TEXT,
    "restorationPercent" INTEGER,
    "primaryNodeId" TEXT,
    "retroactive" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "lastUpdateAt" TIMESTAMP(3) NOT NULL,
    "restoredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Outage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutageNode" (
    "outageId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,

    CONSTRAINT "OutageNode_pkey" PRIMARY KEY ("outageId","nodeId")
);

-- CreateTable
CREATE TABLE "OutageLocality" (
    "outageId" TEXT NOT NULL,
    "localityId" TEXT NOT NULL,
    "restored" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "OutageLocality_pkey" PRIMARY KEY ("outageId","localityId")
);

-- CreateTable
CREATE TABLE "OutagePost" (
    "outageId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "role" "OutagePostRole" NOT NULL,
    "score" DOUBLE PRECISION,
    "reasons" JSONB,
    "postedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutagePost_pkey" PRIMARY KEY ("outageId","postId")
);

-- CreateTable
CREATE TABLE "LinkDecision" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "outcome" "LinkOutcome" NOT NULL,
    "outageId" TEXT,
    "topScore" DOUBLE PRECISION,
    "usedLlm" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "candidates" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LinkDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PostExtraction_status_idx" ON "PostExtraction"("status");

-- CreateIndex
CREATE UNIQUE INDEX "PostExtraction_postId_promptVersion_key" ON "PostExtraction"("postId", "promptVersion");

-- CreateIndex
CREATE INDEX "InfraNode_normalizedKey_idx" ON "InfraNode"("normalizedKey");

-- CreateIndex
CREATE UNIQUE INDEX "InfraNode_type_normalizedKey_key" ON "InfraNode"("type", "normalizedKey");

-- CreateIndex
CREATE INDEX "NodeAlias_normalizedKey_idx" ON "NodeAlias"("normalizedKey");

-- CreateIndex
CREATE UNIQUE INDEX "NodeAlias_nodeId_normalizedKey_key" ON "NodeAlias"("nodeId", "normalizedKey");

-- CreateIndex
CREATE INDEX "InfraEdge_childId_idx" ON "InfraEdge"("childId");

-- CreateIndex
CREATE INDEX "NodeLocality_localityId_idx" ON "NodeLocality"("localityId");

-- CreateIndex
CREATE INDEX "Outage_status_lastUpdateAt_idx" ON "Outage"("status", "lastUpdateAt" DESC);

-- CreateIndex
CREATE INDEX "OutageNode_nodeId_idx" ON "OutageNode"("nodeId");

-- CreateIndex
CREATE INDEX "OutageLocality_localityId_idx" ON "OutageLocality"("localityId");

-- CreateIndex
CREATE UNIQUE INDEX "OutagePost_postId_key" ON "OutagePost"("postId");

-- CreateIndex
CREATE INDEX "OutagePost_outageId_postedAt_idx" ON "OutagePost"("outageId", "postedAt");

-- CreateIndex
CREATE UNIQUE INDEX "LinkDecision_postId_key" ON "LinkDecision"("postId");

-- AddForeignKey
ALTER TABLE "PostExtraction" ADD CONSTRAINT "PostExtraction_postId_fkey" FOREIGN KEY ("postId") REFERENCES "SourcePost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NodeAlias" ADD CONSTRAINT "NodeAlias_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "InfraNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InfraEdge" ADD CONSTRAINT "InfraEdge_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "InfraNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InfraEdge" ADD CONSTRAINT "InfraEdge_childId_fkey" FOREIGN KEY ("childId") REFERENCES "InfraNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NodeLocality" ADD CONSTRAINT "NodeLocality_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "InfraNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NodeLocality" ADD CONSTRAINT "NodeLocality_localityId_fkey" FOREIGN KEY ("localityId") REFERENCES "Locality"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Outage" ADD CONSTRAINT "Outage_primaryNodeId_fkey" FOREIGN KEY ("primaryNodeId") REFERENCES "InfraNode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutageNode" ADD CONSTRAINT "OutageNode_outageId_fkey" FOREIGN KEY ("outageId") REFERENCES "Outage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutageNode" ADD CONSTRAINT "OutageNode_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "InfraNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutageLocality" ADD CONSTRAINT "OutageLocality_outageId_fkey" FOREIGN KEY ("outageId") REFERENCES "Outage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutageLocality" ADD CONSTRAINT "OutageLocality_localityId_fkey" FOREIGN KEY ("localityId") REFERENCES "Locality"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutagePost" ADD CONSTRAINT "OutagePost_outageId_fkey" FOREIGN KEY ("outageId") REFERENCES "Outage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutagePost" ADD CONSTRAINT "OutagePost_postId_fkey" FOREIGN KEY ("postId") REFERENCES "SourcePost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LinkDecision" ADD CONSTRAINT "LinkDecision_postId_fkey" FOREIGN KEY ("postId") REFERENCES "SourcePost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LinkDecision" ADD CONSTRAINT "LinkDecision_outageId_fkey" FOREIGN KEY ("outageId") REFERENCES "Outage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

