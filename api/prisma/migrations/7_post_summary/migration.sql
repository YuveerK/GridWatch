ALTER TABLE "OutagePost" ADD COLUMN "faultIndex" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "PostSummary" (
    "postId" TEXT NOT NULL,
    "faultIndex" INTEGER NOT NULL DEFAULT 0,
    "summary" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PostSummary_pkey" PRIMARY KEY ("postId","faultIndex")
);

ALTER TABLE "PostSummary" ADD CONSTRAINT "PostSummary_postId_fkey" FOREIGN KEY ("postId") REFERENCES "SourcePost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
