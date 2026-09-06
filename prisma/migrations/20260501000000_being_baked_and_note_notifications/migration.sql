-- V5: "Being Baked" unit status, note-ready subscriptions, and delivery records.
--
-- Additive only. No existing column is altered or dropped and no existing row is
-- touched: one defaulted boolean is added to `units`, two new tables are
-- created, and a few enum labels are appended. Semesters, subjects, units,
-- topics, notes, note versions, PYQs, users, sessions, entitlements, orders,
-- activity events and audit logs are all left exactly as they are.
--
-- Postgres allows ALTER TYPE ... ADD VALUE inside a transaction on 12+ provided
-- the new label is not *used* in the same transaction. Nothing below inserts a
-- row carrying one, so this is safe under the migration runner's BEGIN/COMMIT.

-- AlterEnum: EventType
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'UNIT_SUBSCRIBED';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'UNIT_UNSUBSCRIBED';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'NOTE_NOTIFICATION_SENT';

-- AlterEnum: AuditAction
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'UNIT_BAKING_ENABLED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'UNIT_BAKING_DISABLED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'NOTE_NOTIFICATION_SENT';

-- CreateEnum
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'NoteNotificationStatus') THEN
        CREATE TYPE "NoteNotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');
    END IF;
END
$$;

-- AlterTable: the Being Baked flag.
--
-- Defaults to false, so every existing unit keeps exactly the behaviour it has
-- today ("Not uploaded yet" when empty, a normal unit when it has a PDF).
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "beingBaked" BOOLEAN NOT NULL DEFAULT false;

-- Partial: only the flagged units are ever looked up by this, and they are a
-- small minority of the table.
CREATE INDEX IF NOT EXISTS "units_beingBaked_idx" ON "units"("beingBaked");

-- CreateTable: unit_notification_subscriptions
CREATE TABLE IF NOT EXISTS "unit_notification_subscriptions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "unit_notification_subscriptions_pkey" PRIMARY KEY ("id")
);

-- One subscription per student per unit: this is what makes "Notify me" a
-- toggle instead of a way to queue duplicate emails.
CREATE UNIQUE INDEX IF NOT EXISTS "unit_notification_subscriptions_userId_unitId_key"
    ON "unit_notification_subscriptions"("userId", "unitId");
CREATE INDEX IF NOT EXISTS "unit_notification_subscriptions_unitId_idx"
    ON "unit_notification_subscriptions"("unitId");
CREATE INDEX IF NOT EXISTS "unit_notification_subscriptions_userId_idx"
    ON "unit_notification_subscriptions"("userId");

-- CreateTable: note_notifications
--
-- One row per recipient per upload event. Rows are written before anything is
-- sent, so the unique index below is the thing that makes a retry a no-op
-- rather than a second mailing.
CREATE TABLE IF NOT EXISTS "note_notifications" (
    "id" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "noteId" TEXT,
    "userId" TEXT NOT NULL,
    "status" "NoteNotificationStatus" NOT NULL DEFAULT 'PENDING',
    "viaSubscription" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "note_notifications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "note_notifications_eventKey_userId_key"
    ON "note_notifications"("eventKey", "userId");
CREATE INDEX IF NOT EXISTS "note_notifications_eventKey_status_idx"
    ON "note_notifications"("eventKey", "status");
CREATE INDEX IF NOT EXISTS "note_notifications_unitId_createdAt_idx"
    ON "note_notifications"("unitId", "createdAt");

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unit_notification_subscriptions_userId_fkey') THEN
        ALTER TABLE "unit_notification_subscriptions" ADD CONSTRAINT "unit_notification_subscriptions_userId_fkey"
            FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unit_notification_subscriptions_unitId_fkey') THEN
        ALTER TABLE "unit_notification_subscriptions" ADD CONSTRAINT "unit_notification_subscriptions_unitId_fkey"
            FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'note_notifications_unitId_fkey') THEN
        ALTER TABLE "note_notifications" ADD CONSTRAINT "note_notifications_unitId_fkey"
            FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    -- The delivery record outlives the note it announced, the same way an
    -- activity event does.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'note_notifications_noteId_fkey') THEN
        ALTER TABLE "note_notifications" ADD CONSTRAINT "note_notifications_noteId_fkey"
            FOREIGN KEY ("noteId") REFERENCES "notes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'note_notifications_userId_fkey') THEN
        ALTER TABLE "note_notifications" ADD CONSTRAINT "note_notifications_userId_fkey"
            FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$$;

-- Data hygiene: nothing can have been flagged before this migration, but make
-- the invariant true by construction anyway — a unit that already holds a PDF
-- is never "being baked".
UPDATE "units" u
   SET "beingBaked" = false
 WHERE u."beingBaked" = true
   AND EXISTS (SELECT 1 FROM "notes" n WHERE n."unitId" = u.id);
