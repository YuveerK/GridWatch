-- AlterTable
ALTER TABLE "AutoRepairDirective" ADD COLUMN     "action" TEXT NOT NULL,
ALTER COLUMN "targetAnchorPostId" DROP NOT NULL,
ALTER COLUMN "targetAnchorFaultIndex" DROP NOT NULL,
ALTER COLUMN "targetAnchorFaultIndex" DROP DEFAULT;

