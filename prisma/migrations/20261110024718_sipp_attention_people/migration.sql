-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'EDITORIAL_REMINDER';

-- AlterTable
ALTER TABLE "cases" ADD COLUMN     "sippUrl" TEXT;

-- AlterTable
ALTER TABLE "defendants" ADD COLUMN     "slug" TEXT NOT NULL DEFAULT '';

-- Backfill: same rules as slugify() in src/lib/slug.js (strip accents, lowercase,
-- non-alphanumerics to "-", trim "-", cap at 80 chars).
UPDATE "defendants"
SET "slug" = COALESCE(
  NULLIF(
    trim(both '-' from left(
      trim(both '-' from regexp_replace(
        lower(regexp_replace(normalize("name", NFKD), '[' || chr(768) || '-' || chr(879) || ']', '', 'g')),
        '[^a-z0-9]+', '-', 'g'
      )),
      80
    )),
    ''
  ),
  'pihak'
);

ALTER TABLE "defendants" ALTER COLUMN "slug" DROP DEFAULT;

-- CreateTable
CREATE TABLE "job_runs" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "runDate" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "job_runs_name_runDate_key" ON "job_runs"("name", "runDate");

-- CreateIndex
CREATE INDEX "defendants_slug_idx" ON "defendants"("slug");
