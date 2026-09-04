-- V3: subject notebook covers and previous-year question papers.
--
-- Additive only. No existing column is altered or dropped, no row is touched,
-- and every new column is nullable or defaulted, so existing semesters,
-- subjects, units, topics, notes, users, entitlements, orders, activity events
-- and audit logs are unaffected.
--
-- Covers
-- ------
-- `coverStorageKey` is an opaque key inside the same private bucket the notes
-- live in — never a public URL. Covers are catalogue imagery rather than
-- protected content, so they are served by their own application route which
-- may be cached, but the bucket itself stays private. NULL means the UI draws a
-- generated cover instead, so no backfill is required.
--
-- PYQs
-- ----
-- A previous-year paper belongs to a subject as a whole and has no position in
-- the unit → topic hierarchy, so it gets its own table rather than a synthetic
-- unit per subject. Storage and delivery are identical to a note: private key,
-- short-lived view token, canvas reader.
--
-- Postgres allows ALTER TYPE ... ADD VALUE inside a transaction on 12+ provided
-- the new label is not *used* in the same transaction. Nothing below inserts a
-- row carrying one, so this is safe under the migration runner's BEGIN/COMMIT.

-- AlterEnum: EventType
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'PYQ_OPENED';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'PYQ_UPLOADED';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'PYQ_REPLACED';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'PYQ_DELETED';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'SUBJECT_COVER_UPDATED';

-- AlterEnum: AuditAction
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PYQ_UPLOADED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PYQ_REPLACED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PYQ_DELETED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SUBJECT_COVER_UPDATED';

-- AlterTable: notebook cover on a subject
ALTER TABLE "subjects" ADD COLUMN IF NOT EXISTS "coverStorageKey" TEXT;
ALTER TABLE "subjects" ADD COLUMN IF NOT EXISTS "coverMimeType" TEXT;
ALTER TABLE "subjects" ADD COLUMN IF NOT EXISTS "coverUpdatedAt" TIMESTAMP(3);

-- CreateTable: pyqs
CREATE TABLE IF NOT EXISTS "pyqs" (
    "id" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "label" TEXT,
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'application/pdf',
    "checksum" TEXT,
    "pageCount" INTEGER,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "lastViewedAt" TIMESTAMP(3),
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pyqs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "pyqs_subjectId_year_idx" ON "pyqs"("subjectId", "year");

-- One paper per subject per year: keeps the student list unambiguous and makes
-- "replace the 2024 paper" an update rather than a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS "pyqs_subjectId_year_key" ON "pyqs"("subjectId", "year");

-- AddForeignKey
ALTER TABLE "pyqs" ADD CONSTRAINT "pyqs_subjectId_fkey"
    FOREIGN KEY ("subjectId") REFERENCES "subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "pyqs" ADD CONSTRAINT "pyqs_uploadedById_fkey"
    FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
