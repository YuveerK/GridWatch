-- A digest graphic can describe several faults: one post may link to several outages.
ALTER TABLE "LinkDecision" ADD COLUMN "faultIndex" INTEGER NOT NULL DEFAULT 0;
DROP INDEX "LinkDecision_postId_key";
CREATE UNIQUE INDEX "LinkDecision_postId_faultIndex_key" ON "LinkDecision"("postId", "faultIndex");
DROP INDEX "OutagePost_postId_key";
CREATE INDEX "OutagePost_postId_idx" ON "OutagePost"("postId");
