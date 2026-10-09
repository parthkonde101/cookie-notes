-- V9: student feedback / testimonials.
--
-- Adds one new table (`feedback`) and extends two existing enums
-- (`EventType`, `AuditAction`) with feedback-related values. Nothing existing
-- is renamed, dropped or rewritten, and no UPDATE statement appears below.
--
-- `status` and `featured` are separate columns by design: reviewing a
-- testimonial is a moderation step, featuring it on the homepage is a
-- separate, explicit publishing decision an admin makes afterwards. The rule
-- that a testimonial may only be featured once it is REVIEWED and
-- `publicConsent` is true is enforced by the admin action in application
-- code, not by a database constraint.
--
-- The student's public display name is never stored here — `feedback.userId`
-- points at `users`, and the public-facing name (first name + last initial)
-- is derived from `users.name` at query time.
--
-- Every statement is guarded, so re-running this file is a no-op rather than
-- an error — which is what `scripts/apply-migrations.ts` needs to be safe to
-- re-run against a database that is already at V9.

-- CreateEnum
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'FeedbackStatus') THEN
        CREATE TYPE "FeedbackStatus" AS ENUM ('PENDING', 'REVIEWED', 'ARCHIVED');
    END IF;
END
$$;

-- AlterEnum: EventType gains FEEDBACK_SUBMITTED.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'EventType' AND e.enumlabel = 'FEEDBACK_SUBMITTED'
    ) THEN
        ALTER TYPE "EventType" ADD VALUE 'FEEDBACK_SUBMITTED';
    END IF;
END
$$;

-- AlterEnum: AuditAction gains the four feedback moderation actions.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'AuditAction' AND e.enumlabel = 'FEEDBACK_REVIEWED'
    ) THEN
        ALTER TYPE "AuditAction" ADD VALUE 'FEEDBACK_REVIEWED';
    END IF;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'AuditAction' AND e.enumlabel = 'FEEDBACK_FEATURED'
    ) THEN
        ALTER TYPE "AuditAction" ADD VALUE 'FEEDBACK_FEATURED';
    END IF;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'AuditAction' AND e.enumlabel = 'FEEDBACK_UNFEATURED'
    ) THEN
        ALTER TYPE "AuditAction" ADD VALUE 'FEEDBACK_UNFEATURED';
    END IF;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'AuditAction' AND e.enumlabel = 'FEEDBACK_ARCHIVED'
    ) THEN
        ALTER TYPE "AuditAction" ADD VALUE 'FEEDBACK_ARCHIVED';
    END IF;
END
$$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "feedback" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "publicConsent" BOOLEAN NOT NULL DEFAULT false,
    "status" "FeedbackStatus" NOT NULL DEFAULT 'PENDING',
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "featuredAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "feedback_status_createdAt_idx" ON "feedback"("status", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "feedback_featured_featuredAt_idx" ON "feedback"("featured", "featuredAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "feedback_userId_createdAt_idx" ON "feedback"("userId", "createdAt");

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feedback_userId_fkey') THEN
        ALTER TABLE "feedback" ADD CONSTRAINT "feedback_userId_fkey"
            FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feedback_reviewedById_fkey') THEN
        ALTER TABLE "feedback" ADD CONSTRAINT "feedback_reviewedById_fkey"
            FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END
$$;
