-- V10: paid notes, bundles and purchases.
--
-- Additive, except for two deliberate changes on the (unused, so empty) `orders`
-- table described below. Nothing existing is renamed, dropped or rewritten, and
-- no UPDATE statement appears: every existing note stays exactly as it is.
--
--   notes.isPaid            NEW, default false. Nothing becomes "for sale" until an
--                           admin sets it. A legacy `priceMinor` value does nothing
--                           on its own. CHECK constraints keep a paid note RESTRICTED
--                           and inside the allowed price range (₹1 – ₹50,000).
--   bundles, bundle_items,
--   bundle_subjects         NEW. A bundle is a set of notes sold together.
--   orders                  EXTENDED with receipt, buyer snapshot, refund total and
--                           timestamps. `userId` becomes nullable and its foreign key
--                           changes from CASCADE to SET NULL, so deleting an account
--                           never erases the financial record (the buyer's email and
--                           name are copied onto the order). The table has no rows
--                           under the MVP, which is why this is safe to change.
--   order_items             NEW. What an order bought, with immutable price and
--                           contents snapshots.
--   payment_transactions    NEW. One row per gateway payment, unique on the
--                           gateway's payment id.
--   refunds                 NEW.
--   payment_events          NEW. The webhook ledger, unique on the gateway's event id.
--   purchase_grants         NEW. Access that came from a purchase, one row per note
--                           per order item. Admin, promotional and sign-up grants
--                           stay in `entitlements`, untouched.
--
-- Postgres 12+ allows ALTER TYPE ... ADD VALUE inside a transaction provided the new
-- value is not used in the same transaction; nothing below uses one.
--
-- Rollback: the new tables and columns can be dropped; the enum values cannot be
-- removed from Postgres once added (harmless — nothing refers to them until used).
-- Every statement is guarded, so re-running this file is a no-op.


-- CreateEnum
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ProductType') THEN
        CREATE TYPE "ProductType" AS ENUM ('NOTE', 'BUNDLE');
    END IF;
END
$$;

-- CreateEnum
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PaymentTxStatus') THEN
        CREATE TYPE "PaymentTxStatus" AS ENUM ('PENDING', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED');
    END IF;
END
$$;

-- CreateEnum
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RefundStatus') THEN
        CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'PROCESSED', 'FAILED');
    END IF;
END
$$;

-- CreateEnum
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PaymentEventStatus') THEN
        CREATE TYPE "PaymentEventStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED', 'IGNORED');
    END IF;
END
$$;

-- AlterEnum
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'PARTIALLY_REFUNDED';

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'NOTE_PRICE_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'BUNDLE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'BUNDLE_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'BUNDLE_DELETED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'REFUND_INITIATED';

-- DropForeignKey
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_userId_fkey";

-- AlterTable
ALTER TABLE "notes" ADD COLUMN IF NOT EXISTS "isPaid" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cancelledAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "customerEmail" TEXT,
ADD COLUMN IF NOT EXISTS "customerName" TEXT,
ADD COLUMN IF NOT EXISTS "failedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "receipt" TEXT,
ADD COLUMN IF NOT EXISTS "refundedMinor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "userId" DROP NOT NULL;

-- CreateTable
CREATE TABLE IF NOT EXISTS "order_items" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productType" "ProductType" NOT NULL,
    "noteId" TEXT,
    "bundleId" TEXT,
    "title" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPriceMinor" INTEGER NOT NULL,
    "discountMinor" INTEGER NOT NULL DEFAULT 0,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "contents" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "payment_transactions" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerPaymentId" TEXT NOT NULL,
    "providerOrderId" TEXT,
    "status" "PaymentTxStatus" NOT NULL DEFAULT 'PENDING',
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "method" TEXT,
    "errorCode" TEXT,
    "errorDescription" TEXT,
    "refundedMinor" INTEGER NOT NULL DEFAULT 0,
    "flag" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "capturedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),

    CONSTRAINT "payment_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "refunds" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "paymentTransactionId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerRefundId" TEXT,
    "receipt" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "failureReason" TEXT,
    "initiatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "payment_events" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "status" "PaymentEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "data" JSONB,

    CONSTRAINT "payment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "purchase_grants" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "noteId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,
    "refundId" TEXT,

    CONSTRAINT "purchase_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "bundles" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "priceMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "isFeatured" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "coverSubjectId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bundles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "bundle_items" (
    "id" TEXT NOT NULL,
    "bundleId" TEXT NOT NULL,
    "noteId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "bundle_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "bundle_subjects" (
    "bundleId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,

    CONSTRAINT "bundle_subjects_pkey" PRIMARY KEY ("bundleId","subjectId")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "order_items_orderId_idx" ON "order_items"("orderId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "order_items_noteId_idx" ON "order_items"("noteId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "order_items_bundleId_idx" ON "order_items"("bundleId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "payment_transactions_orderId_idx" ON "payment_transactions"("orderId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "payment_transactions_status_createdAt_idx" ON "payment_transactions"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "payment_transactions_provider_providerPaymentId_key" ON "payment_transactions"("provider", "providerPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "refunds_receipt_key" ON "refunds"("receipt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "refunds_orderId_idx" ON "refunds"("orderId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "refunds_status_processedAt_idx" ON "refunds"("status", "processedAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "refunds_provider_providerRefundId_key" ON "refunds"("provider", "providerRefundId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "payment_events_status_receivedAt_idx" ON "payment_events"("status", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "payment_events_provider_eventId_key" ON "payment_events"("provider", "eventId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "purchase_grants_userId_noteId_revokedAt_idx" ON "purchase_grants"("userId", "noteId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "purchase_grants_orderItemId_noteId_key" ON "purchase_grants"("orderItemId", "noteId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "bundles_isActive_isFeatured_position_idx" ON "bundles"("isActive", "isFeatured", "position");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "bundle_items_noteId_idx" ON "bundle_items"("noteId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "bundle_items_bundleId_noteId_key" ON "bundle_items"("bundleId", "noteId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "bundle_subjects_subjectId_idx" ON "bundle_subjects"("subjectId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "orders_receipt_key" ON "orders"("receipt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "orders_status_createdAt_idx" ON "orders"("status", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "orders_paidAt_idx" ON "orders"("paidAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "orders_provider_providerOrderId_key" ON "orders"("provider", "providerOrderId");

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_userId_fkey') THEN
        ALTER TABLE "orders" ADD CONSTRAINT "orders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END
$$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_items_orderId_fkey') THEN
        ALTER TABLE "order_items" ADD CONSTRAINT "order_items_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_items_noteId_fkey') THEN
        ALTER TABLE "order_items" ADD CONSTRAINT "order_items_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "notes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END
$$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_items_bundleId_fkey') THEN
        ALTER TABLE "order_items" ADD CONSTRAINT "order_items_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "bundles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END
$$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_transactions_orderId_fkey') THEN
        ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'refunds_orderId_fkey') THEN
        ALTER TABLE "refunds" ADD CONSTRAINT "refunds_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'refunds_paymentTransactionId_fkey') THEN
        ALTER TABLE "refunds" ADD CONSTRAINT "refunds_paymentTransactionId_fkey" FOREIGN KEY ("paymentTransactionId") REFERENCES "payment_transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'refunds_initiatedById_fkey') THEN
        ALTER TABLE "refunds" ADD CONSTRAINT "refunds_initiatedById_fkey" FOREIGN KEY ("initiatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END
$$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'purchase_grants_userId_fkey') THEN
        ALTER TABLE "purchase_grants" ADD CONSTRAINT "purchase_grants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'purchase_grants_noteId_fkey') THEN
        ALTER TABLE "purchase_grants" ADD CONSTRAINT "purchase_grants_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'purchase_grants_orderItemId_fkey') THEN
        ALTER TABLE "purchase_grants" ADD CONSTRAINT "purchase_grants_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'purchase_grants_refundId_fkey') THEN
        ALTER TABLE "purchase_grants" ADD CONSTRAINT "purchase_grants_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "refunds"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END
$$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bundles_coverSubjectId_fkey') THEN
        ALTER TABLE "bundles" ADD CONSTRAINT "bundles_coverSubjectId_fkey" FOREIGN KEY ("coverSubjectId") REFERENCES "subjects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END
$$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bundles_createdById_fkey') THEN
        ALTER TABLE "bundles" ADD CONSTRAINT "bundles_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END
$$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bundle_items_bundleId_fkey') THEN
        ALTER TABLE "bundle_items" ADD CONSTRAINT "bundle_items_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "bundles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bundle_items_noteId_fkey') THEN
        ALTER TABLE "bundle_items" ADD CONSTRAINT "bundle_items_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bundle_subjects_bundleId_fkey') THEN
        ALTER TABLE "bundle_subjects" ADD CONSTRAINT "bundle_subjects_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "bundles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$$;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bundle_subjects_subjectId_fkey') THEN
        ALTER TABLE "bundle_subjects" ADD CONSTRAINT "bundle_subjects_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$$;

-- Integrity constraints. The application validates all of these first; the database
-- is the backstop that makes them true even for a code path that forgets.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notes_paid_requires_restricted') THEN
        ALTER TABLE "notes" ADD CONSTRAINT "notes_paid_requires_restricted" CHECK (NOT "isPaid" OR "visibility" = 'RESTRICTED');
    END IF;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notes_paid_price_range') THEN
        ALTER TABLE "notes" ADD CONSTRAINT "notes_paid_price_range" CHECK (NOT "isPaid" OR ("priceMinor" >= 100 AND "priceMinor" <= 5000000));
    END IF;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bundles_price_range') THEN
        ALTER TABLE "bundles" ADD CONSTRAINT "bundles_price_range" CHECK ("priceMinor" >= 100 AND "priceMinor" <= 5000000);
    END IF;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_amounts_valid') THEN
        ALTER TABLE "orders" ADD CONSTRAINT "orders_amounts_valid" CHECK ("amountMinor" >= 0 AND "refundedMinor" >= 0 AND "refundedMinor" <= "amountMinor");
    END IF;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_items_amounts_valid') THEN
        ALTER TABLE "order_items" ADD CONSTRAINT "order_items_amounts_valid" CHECK ("quantity" >= 1 AND "unitPriceMinor" >= 0 AND "discountMinor" >= 0 AND "amountMinor" >= 0);
    END IF;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_items_product_shape') THEN
        ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_shape" CHECK (("productType" <> 'NOTE' OR "bundleId" IS NULL) AND ("productType" <> 'BUNDLE' OR "noteId" IS NULL));
    END IF;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_transactions_amounts_valid') THEN
        ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_amounts_valid" CHECK ("amountMinor" >= 0 AND "refundedMinor" >= 0 AND "refundedMinor" <= "amountMinor");
    END IF;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'refunds_amount_positive') THEN
        ALTER TABLE "refunds" ADD CONSTRAINT "refunds_amount_positive" CHECK ("amountMinor" > 0);
    END IF;
END
$$;
