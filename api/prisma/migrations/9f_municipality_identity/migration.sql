-- Municipality scoping for identity resolution (ENGINE_AUDIT_2026-09-23.md finding 1): equipment,
-- learned localities and outages are namespaced by municipality, so a same-named station/suburb in
-- two different tracked utilities is never silently treated as the same thing without explicit
-- evidence. All new columns are nullable and additive; existing rows are left null ("not scoped
-- yet"), backfilled separately and idempotently by scripts/backfill-municipality.js, not by this
-- migration - the correct municipality for existing equipment/outages is derived from which
-- account's posts taught the graph about them, which this migration has no way to compute safely
-- inline (a mixed/ambiguous case must be logged for a person, not guessed).

-- Locality: mainly for LEARNED suburbs (regionId null), which otherwise have no municipality at all.
ALTER TABLE "Locality" ADD COLUMN "municipalityId" TEXT;
ALTER TABLE "Locality" ADD CONSTRAINT "Locality_municipalityId_fkey" FOREIGN KEY ("municipalityId") REFERENCES "Municipality"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- InfraNode: equipment identity becomes (type, normalizedKey, municipalityId). Postgres treats NULL
-- as distinct in a composite unique index, so without the partial index below, two DIFFERENT nodes
-- could both end up with municipalityId IS NULL and the same (type, normalizedKey) without
-- violating any constraint - silently reintroducing the exact ambiguity this migration exists to
-- remove, for any caller (tests, or a code path with no account context) that doesn't supply one.
ALTER TABLE "InfraNode" ADD COLUMN "municipalityId" TEXT;
DROP INDEX "InfraNode_type_normalizedKey_key";
CREATE UNIQUE INDEX "InfraNode_type_normalizedKey_municipalityId_key" ON "InfraNode"("type", "normalizedKey", "municipalityId");
CREATE UNIQUE INDEX "InfraNode_type_normalizedKey_null_municipality_key" ON "InfraNode"("type", "normalizedKey") WHERE "municipalityId" IS NULL;
ALTER TABLE "InfraNode" ADD CONSTRAINT "InfraNode_municipalityId_fkey" FOREIGN KEY ("municipalityId") REFERENCES "Municipality"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Outage: set at creation from the opening post's account; used to scope loadCandidates so an
-- outage never becomes a linking candidate for a post from a different, known municipality.
ALTER TABLE "Outage" ADD COLUMN "municipalityId" TEXT;
ALTER TABLE "Outage" ADD CONSTRAINT "Outage_municipalityId_fkey" FOREIGN KEY ("municipalityId") REFERENCES "Municipality"("id") ON DELETE SET NULL ON UPDATE CASCADE;
