-- A person's correction of where one post (fault) belongs. Kept apart from outages so it survives every rebuild.
CREATE TABLE "LinkOverride" (
    "postId" TEXT NOT NULL,
    "faultIndex" INTEGER NOT NULL DEFAULT 0,
    "action" TEXT NOT NULL,
    "anchorPostId" TEXT,
    "anchorFaultIndex" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LinkOverride_pkey" PRIMARY KEY ("postId","faultIndex"),
    CONSTRAINT "LinkOverride_action_check" CHECK ("action" IN ('JOIN','SPLIT') AND ("action" = 'SPLIT' OR "anchorPostId" IS NOT NULL))
);
ALTER TABLE "LinkOverride" ADD CONSTRAINT "LinkOverride_postId_fkey" FOREIGN KEY ("postId") REFERENCES "SourcePost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LinkOverride" ADD CONSTRAINT "LinkOverride_anchorPostId_fkey" FOREIGN KEY ("anchorPostId") REFERENCES "SourcePost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
