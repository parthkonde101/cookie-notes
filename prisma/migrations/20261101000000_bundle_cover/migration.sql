-- V11: bundles can have their own cover picture, or none.
--
-- Additive. No existing row is rewritten: every bundle gets coverMode = 'SUBJECT', which is
-- exactly how bundle covers have always worked (a subject's notebook cover), so nothing a
-- student sees changes until an admin chooses otherwise.
--
--   bundles.coverMode        NEW enum: SUBJECT (default) | CUSTOM | NONE.
--   bundles.coverStorageKey  NEW, nullable. The uploaded image's key in private storage.
--   bundles.coverMimeType    NEW, nullable.
--   bundles.coverUpdatedAt   NEW, nullable. Version stamp for the cover URL.
--
-- Rollback: drop the three columns, then the column and the type. Nothing refers to them but
-- the application. Every statement is guarded, so re-running this file is a no-op.

-- CreateEnum
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'BundleCoverMode') THEN
        CREATE TYPE "BundleCoverMode" AS ENUM ('SUBJECT', 'CUSTOM', 'NONE');
    END IF;
END
$$;

-- AlterTable
ALTER TABLE "bundles" ADD COLUMN IF NOT EXISTS "coverMode" "BundleCoverMode" NOT NULL DEFAULT 'SUBJECT';
ALTER TABLE "bundles" ADD COLUMN IF NOT EXISTS "coverStorageKey" TEXT;
ALTER TABLE "bundles" ADD COLUMN IF NOT EXISTS "coverMimeType" TEXT;
ALTER TABLE "bundles" ADD COLUMN IF NOT EXISTS "coverUpdatedAt" TIMESTAMP(3);
