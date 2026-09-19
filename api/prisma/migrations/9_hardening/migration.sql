-- Coordination, ingestion state, idempotent evidence, per-link effects, scheduled windows, summary versioning.
-- Forward-only: nothing here rewrites an earlier migration, and every new column is nullable or defaulted,
-- so existing rows stay valid without a rewrite.

CREATE TABLE "WorkLease" (
    "name" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "renewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkLease_pkey" PRIMARY KEY ("name")
);

CREATE TABLE "IngestionState" (
    "accountId" TEXT NOT NULL,
    "completedHighWater" TEXT,
    "cursorToken" TEXT,
    "cursorSinceId" TEXT,
    "cursorNewest" TEXT,
    "incomplete" BOOLEAN NOT NULL DEFAULT false,
    "lastCompletedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "IngestionState_pkey" PRIMARY KEY ("accountId")
);

CREATE TABLE "EvidenceContribution" (
    "postId" TEXT NOT NULL,
    "faultIndex" INTEGER NOT NULL DEFAULT 0,
    "kind" TEXT NOT NULL,
    "refA" TEXT NOT NULL,
    "refB" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EvidenceContribution_pkey" PRIMARY KEY ("postId","faultIndex","kind","refA","refB")
);
CREATE INDEX "EvidenceContribution_postId_idx" ON "EvidenceContribution"("postId");
ALTER TABLE "EvidenceContribution" ADD CONSTRAINT "EvidenceContribution_postId_fkey" FOREIGN KEY ("postId") REFERENCES "SourcePost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Outage" ADD COLUMN "scheduledStart" TIMESTAMP(3), ADD COLUMN "scheduledEnd" TIMESTAMP(3);
ALTER TABLE "OutagePost" ADD COLUMN "effect" JSONB;
ALTER TABLE "PostSummary" ADD COLUMN "promptVersion" TEXT;
