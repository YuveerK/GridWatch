ALTER TABLE "OutagePost" DROP CONSTRAINT "OutagePost_pkey";
ALTER TABLE "OutagePost" ADD CONSTRAINT "OutagePost_pkey" PRIMARY KEY ("outageId", "postId", "faultIndex");
ALTER TABLE "ReviewItem" ADD COLUMN "evidenceFingerprint" TEXT;

CREATE TABLE "ReviewCase" (
  "id" TEXT PRIMARY KEY, "subjectKey" TEXT NOT NULL UNIQUE,
  "postId" TEXT, "faultIndex" INTEGER, "source" TEXT, "stage" TEXT,
  "workflow" TEXT NOT NULL DEFAULT 'OPEN', "fingerprint" TEXT NOT NULL,
  "note" TEXT, "summary" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "ReviewCase_workflow_updatedAt_idx" ON "ReviewCase"("workflow", "updatedAt");
CREATE INDEX "ReviewCase_postId_idx" ON "ReviewCase"("postId");

CREATE TABLE "ReadingOverride" (
  "postId" TEXT PRIMARY KEY REFERENCES "SourcePost"("id") ON DELETE CASCADE,
  "schemaVersion" INTEGER NOT NULL DEFAULT 1, "serviceType" "ServiceType" NOT NULL,
  "sourceHash" TEXT NOT NULL, "baseReadingHash" TEXT, "payload" JSONB NOT NULL,
  "evidence" JSONB NOT NULL, "note" TEXT NOT NULL, "revision" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "ReviewAction" (
  "id" TEXT PRIMARY KEY, "caseId" TEXT NOT NULL REFERENCES "ReviewCase"("id"),
  "requestId" TEXT NOT NULL UNIQUE, "type" TEXT NOT NULL, "state" TEXT NOT NULL,
  "operator" TEXT NOT NULL, "note" TEXT NOT NULL, "evidence" JSONB NOT NULL,
  "input" JSONB NOT NULL, "fingerprint" TEXT NOT NULL, "before" JSONB, "after" JSONB,
  "snapshot" JSONB, "validation" JSONB, "result" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "finishedAt" TIMESTAMP(3)
);
CREATE INDEX "ReviewAction_caseId_createdAt_idx" ON "ReviewAction"("caseId", "createdAt");
CREATE INDEX "ReviewAction_state_idx" ON "ReviewAction"("state");
