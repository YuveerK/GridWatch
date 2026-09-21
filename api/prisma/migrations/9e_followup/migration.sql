-- A cycle's quality record is created when the cycle starts (RUNNING) and completed when it ends.
ALTER TABLE "CycleQuality" DROP CONSTRAINT "CycleQuality_status_check";
ALTER TABLE "CycleQuality" ADD CONSTRAINT "CycleQuality_status_check" CHECK ("status" IN ('RUNNING','COMPLETE','INCOMPLETE','NEEDS_REVIEW','FAILED'));

-- Append-only ledger of independent-verifier calls: a call is reserved here BEFORE the provider is contacted, so repeated checks of one
-- item, failed calls and concurrent callers are all counted against the daily cap.
CREATE TABLE "VerifierCall" (
    "id" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "reservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outcome" TEXT,
    "error" TEXT,
    CONSTRAINT "VerifierCall_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "VerifierCall_day_idx" ON "VerifierCall"("day");
