-- V2: note pricing and the catalogue event.
--
-- `priceMinor` is the list price in the smallest currency unit (paise). Nothing
-- charges against it yet — it drives what the public catalogue displays so the
-- paid model is visible before payments are wired up.
--
-- `CATALOG_VIEWED` replaces `DASHBOARD_VIEWED` as the event fired on the main
-- student surface. The old value is left in the enum so historical rows stay
-- readable; Postgres cannot drop an enum value that is still referenced.

-- AlterEnum
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'CATALOG_VIEWED';

-- AlterTable
ALTER TABLE "notes" ADD COLUMN "priceMinor" INTEGER NOT NULL DEFAULT 0;
