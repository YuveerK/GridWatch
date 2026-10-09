-- CreateEnum
CREATE TYPE "RepairAction" AS ENUM ('REPROCESS_STORED', 'JOIN_FAULT', 'SPLIT_FAULT', 'PROPOSE_READING_REVISION', 'PROPOSE_LESSON');

-- CreateEnum
CREATE TYPE "RepairProposalStatus" AS ENUM ('PROPOSED', 'SHADOW_EVALUATED', 'VERIFYING', 'ELIGIBLE', 'NEEDS_REVIEW', 'REJECTED', 'DEFERRED', 'APPLYING', 'APPLIED', 'ROLLED_BACK', 'RECOVERY_REQUIRED', 'SUPERSEDED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "RepairAttemptOutcome" AS ENUM ('APPLIED', 'FAILED', 'ROLLED_BACK', 'RECOVERY_REQUIRED');

-- CreateEnum
CREATE TYPE "LessonKind" AS ENUM ('INCIDENT_CONTINUATION', 'INCIDENT_SEPARATION', 'EQUIPMENT_ALIAS', 'LOCALITY_CONTEXT', 'PLANNED_RESCHEDULE', 'READING_PATTERN');

-- CreateEnum
CREATE TYPE "LessonStatus" AS ENUM ('CANDIDATE', 'REVIEWED', 'ACTIVE', 'SUSPENDED', 'RETIRED');

-- CreateTable
CREATE TABLE "RepairProposal" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "faultIndex" INTEGER NOT NULL DEFAULT 0,
    "reviewItemId" TEXT,
    "serviceType" "ServiceType" NOT NULL,
    "municipalityId" TEXT,
    "sourceAccount" TEXT NOT NULL,
    "action" "RepairAction" NOT NULL,
    "generatorName" TEXT NOT NULL,
    "generatorVersion" TEXT NOT NULL,
    "policyName" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "triggerFamily" TEXT NOT NULL,
    "sourceContentHash" TEXT NOT NULL,
    "sourceLayoutHash" TEXT NOT NULL,
    "lessonSetFingerprint" TEXT NOT NULL,
    "candidateStateFingerprint" TEXT NOT NULL,
    "targetAnchorPostId" TEXT,
    "targetAnchorFaultIndex" INTEGER,
    "observedOutageIds" JSONB,
    "evidence" JSONB NOT NULL,
    "expectedEffect" JSONB NOT NULL,
    "affectedManifest" JSONB NOT NULL,
    "beforePreview" JSONB NOT NULL,
    "afterPreview" JSONB,
    "verification" JSONB,
    "eligibility" JSONB NOT NULL,
    "status" "RepairProposalStatus" NOT NULL DEFAULT 'PROPOSED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "terminalReason" TEXT,
    "idempotencyKey" TEXT NOT NULL,

    CONSTRAINT "RepairProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepairAttempt" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "workerOwner" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "inputFingerprint" TEXT NOT NULL,
    "affectedManifest" JSONB NOT NULL,
    "snapshotRef" TEXT,
    "snapshotFormatVersion" INTEGER NOT NULL DEFAULT 1,
    "snapshotIntegrityHash" TEXT,
    "beforeSignature" TEXT,
    "afterSignature" TEXT,
    "operation" TEXT NOT NULL,
    "validation" JSONB,
    "outcome" "RepairAttemptOutcome" NOT NULL,
    "providerReservations" JSONB,
    "errorClass" TEXT,
    "recoveryOutcome" TEXT,
    "followUpReviewIds" JSONB,

    CONSTRAINT "RepairAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CorrectionLesson" (
    "id" TEXT NOT NULL,
    "kind" "LessonKind" NOT NULL,
    "status" "LessonStatus" NOT NULL DEFAULT 'CANDIDATE',
    "serviceType" "ServiceType" NOT NULL,
    "municipalityId" TEXT,
    "sourceAccountScope" TEXT,
    "assetTypeScope" JSONB,
    "temporalScope" JSONB,
    "claim" JSONB NOT NULL,
    "applicabilityPredicate" JSONB NOT NULL,
    "exclusions" JSONB,
    "counterexamples" JSONB,
    "establishedBy" TEXT NOT NULL,
    "independentSupportCount" INTEGER NOT NULL DEFAULT 1,
    "effectiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "supersedesId" TEXT,
    "validationEvidence" JSONB,
    "revocationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CorrectionLesson_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CorrectionLessonSupport" (
    "lessonId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "faultIndex" INTEGER NOT NULL DEFAULT 0,
    "role" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CorrectionLessonSupport_pkey" PRIMARY KEY ("lessonId","postId","faultIndex","role")
);

-- CreateTable
CREATE TABLE "AutoRepairDirective" (
    "postId" TEXT NOT NULL,
    "faultIndex" INTEGER NOT NULL DEFAULT 0,
    "proposalId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "targetAnchorPostId" TEXT NOT NULL,
    "targetAnchorFaultIndex" INTEGER NOT NULL DEFAULT 0,
    "policyName" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "evidenceFingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "validSince" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revalidateAt" TIMESTAMP(3),
    "invalidationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutoRepairDirective_pkey" PRIMARY KEY ("postId","faultIndex")
);

-- CreateTable
CREATE TABLE "SelfCorrectionCall" (
    "id" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "proposalId" TEXT,
    "attemptId" TEXT,
    "postId" TEXT NOT NULL,
    "reservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outcome" TEXT,
    "error" TEXT,

    CONSTRAINT "SelfCorrectionCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RepairProposal_idempotencyKey_key" ON "RepairProposal"("idempotencyKey");

-- CreateIndex
CREATE INDEX "RepairProposal_status_createdAt_idx" ON "RepairProposal"("status", "createdAt");

-- CreateIndex
CREATE INDEX "RepairProposal_postId_faultIndex_idx" ON "RepairProposal"("postId", "faultIndex");

-- CreateIndex
CREATE INDEX "RepairAttempt_proposalId_attemptNumber_idx" ON "RepairAttempt"("proposalId", "attemptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "CorrectionLesson_supersedesId_key" ON "CorrectionLesson"("supersedesId");

-- CreateIndex
CREATE INDEX "CorrectionLesson_status_serviceType_municipalityId_idx" ON "CorrectionLesson"("status", "serviceType", "municipalityId");

-- CreateIndex
CREATE UNIQUE INDEX "AutoRepairDirective_proposalId_key" ON "AutoRepairDirective"("proposalId");

-- CreateIndex
CREATE INDEX "SelfCorrectionCall_day_idx" ON "SelfCorrectionCall"("day");

-- AddForeignKey
ALTER TABLE "RepairProposal" ADD CONSTRAINT "RepairProposal_postId_fkey" FOREIGN KEY ("postId") REFERENCES "SourcePost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepairAttempt" ADD CONSTRAINT "RepairAttempt_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "RepairProposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CorrectionLesson" ADD CONSTRAINT "CorrectionLesson_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "CorrectionLesson"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CorrectionLessonSupport" ADD CONSTRAINT "CorrectionLessonSupport_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "CorrectionLesson"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CorrectionLessonSupport" ADD CONSTRAINT "CorrectionLessonSupport_postId_fkey" FOREIGN KEY ("postId") REFERENCES "SourcePost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutoRepairDirective" ADD CONSTRAINT "AutoRepairDirective_postId_fkey" FOREIGN KEY ("postId") REFERENCES "SourcePost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutoRepairDirective" ADD CONSTRAINT "AutoRepairDirective_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "RepairProposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

