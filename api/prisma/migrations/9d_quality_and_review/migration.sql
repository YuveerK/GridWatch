-- A saved quality result for every fetch/processing cycle, the bounded retries of transient failures, a queue of suspicious changes for a
-- person (and an optional independent check) to look at, and the readings that a re-read replaced (so a repair can be undone).
CREATE TABLE "CycleQuality" (
    "id" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ingestionRunId" TEXT,
    "summary" JSONB NOT NULL,
    "problems" JSONB NOT NULL,
    "posts" JSONB NOT NULL,
    "changedOutageIds" JSONB NOT NULL,
    CONSTRAINT "CycleQuality_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CycleQuality_status_check" CHECK ("status" IN ('COMPLETE','INCOMPLETE','NEEDS_REVIEW','FAILED'))
);
CREATE INDEX "CycleQuality_finishedAt_idx" ON "CycleQuality"("finishedAt");

CREATE TABLE "RetryAttempt" (
    "postId" TEXT NOT NULL,
    "faultIndex" INTEGER NOT NULL DEFAULT 0,
    "kind" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "lastError" TEXT,
    "nextRetryAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RetryAttempt_pkey" PRIMARY KEY ("postId","faultIndex","kind")
);
CREATE INDEX "RetryAttempt_nextRetryAt_idx" ON "RetryAttempt"("nextRetryAt");
ALTER TABLE "RetryAttempt" ADD CONSTRAINT "RetryAttempt_postId_fkey" FOREIGN KEY ("postId") REFERENCES "SourcePost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ReviewItem" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "faultIndex" INTEGER NOT NULL DEFAULT 0,
    "reasons" JSONB NOT NULL,
    "priority" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "sampled" BOOLEAN NOT NULL DEFAULT false,
    "verifier" JSONB,
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    CONSTRAINT "ReviewItem_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ReviewItem_status_check" CHECK ("status" IN ('OPEN','RESOLVED','DISMISSED'))
);
CREATE UNIQUE INDEX "ReviewItem_postId_faultIndex_key" ON "ReviewItem"("postId", "faultIndex");
CREATE INDEX "ReviewItem_status_priority_idx" ON "ReviewItem"("status", "priority");
ALTER TABLE "ReviewItem" ADD CONSTRAINT "ReviewItem_postId_fkey" FOREIGN KEY ("postId") REFERENCES "SourcePost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ReadingRevision" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "revision" TEXT,
    "model" TEXT,
    "result" JSONB NOT NULL,
    "replacedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReadingRevision_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ReadingRevision_postId_idx" ON "ReadingRevision"("postId");
ALTER TABLE "ReadingRevision" ADD CONSTRAINT "ReadingRevision_postId_fkey" FOREIGN KEY ("postId") REFERENCES "SourcePost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LinkOverride" ADD COLUMN "contrastPostId" TEXT;
ALTER TABLE "LinkOverride" ADD CONSTRAINT "LinkOverride_contrastPostId_fkey" FOREIGN KEY ("contrastPostId") REFERENCES "SourcePost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
