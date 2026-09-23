-- Add the Municipality concept (metro/local municipality), scope Region codes to it, and tie
-- SourceAccount to the municipality it belongs to.

CREATE TABLE "Municipality" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Municipality_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Municipality_code_key" ON "Municipality"("code");

INSERT INTO "Municipality" ("id", "name", "code") VALUES ('45824c9e-23f9-4424-a163-bf4871bcff30', 'City of Johannesburg', 'JOHANNESBURG');

-- Region: add municipalityId, backfill to the one municipality that exists so far, then enforce it.
ALTER TABLE "Region" ADD COLUMN "municipalityId" TEXT;
UPDATE "Region" SET "municipalityId" = '45824c9e-23f9-4424-a163-bf4871bcff30';
ALTER TABLE "Region" ALTER COLUMN "municipalityId" SET NOT NULL;

DROP INDEX "Region_code_key";
CREATE UNIQUE INDEX "Region_municipalityId_code_key" ON "Region"("municipalityId", "code");

ALTER TABLE "Region" ADD CONSTRAINT "Region_municipalityId_fkey" FOREIGN KEY ("municipalityId") REFERENCES "Municipality"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- SourceAccount: optional municipality link (existing City Power row is backfilled explicitly, not by
-- default, since a future account could in principle not belong to any of our tracked municipalities yet).
ALTER TABLE "SourceAccount" ADD COLUMN "municipalityId" TEXT;
UPDATE "SourceAccount" SET "municipalityId" = '45824c9e-23f9-4424-a163-bf4871bcff30' WHERE "externalId" = '337882328';
ALTER TABLE "SourceAccount" ADD CONSTRAINT "SourceAccount_municipalityId_fkey" FOREIGN KEY ("municipalityId") REFERENCES "Municipality"("id") ON DELETE SET NULL ON UPDATE CASCADE;
