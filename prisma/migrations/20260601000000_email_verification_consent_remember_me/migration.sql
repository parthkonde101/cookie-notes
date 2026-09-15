-- V6: email verification, self-declared PRN, consent records and "Keep me signed in".
--
-- ADDITIVE AND NON-DESTRUCTIVE.
--
-- There is not a single UPDATE or DELETE in this file. Every new column is
-- either nullable or NOT NULL with a DEFAULT, which Postgres fills in place
-- without rewriting user rows, so:
--
--   * no existing user is modified, re-created or re-hashed
--   * no password changes
--   * no entitlement, note, order, analytics event or audit row is touched
--   * no session is invalidated — `sessions.rememberMe` defaults to false,
--     which is exactly the behaviour every live session already has
--   * existing accounts with non-MIT-WPU email keep working: the domain rule
--     lives in the registration schema, not in the database
--   * existing accounts are exempt from verification by construction, because
--     `verificationRequired` defaults to false and only the new registration
--     path ever sets it true
--
-- Deploy this BEFORE the application code. Old code ignores unknown columns,
-- so the window between migration and deploy is safe in both directions.
-- Do not roll this migration back after users have verified: dropping
-- `emailVerifiedAt` would discard that proof irrecoverably. Roll back the code
-- instead and leave the columns inert.

-- AlterEnum: EventType
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'EMAIL_VERIFICATION_SENT';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'EMAIL_VERIFIED';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'EMAIL_VERIFICATION_FAILED';

-- AlterTable: users — identity, verification and consent
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "prn" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "emailVerifiedAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "verificationRequired" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "termsAcceptedAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "termsVersion" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "analyticsConsentAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "analyticsConsentVersion" TEXT;

-- Two students cannot share a PRN. Postgres treats NULLs as distinct in a
-- unique index, so every legacy row keeps NULL while supplied values stay
-- unique — the same property the one-note-per-unit index relies on.
CREATE UNIQUE INDEX IF NOT EXISTS "users_prn_key" ON "users"("prn");

-- AlterTable: sessions — "Keep me signed in"
--
-- Defaulting to false means every session that exists right now keeps its
-- current 7-day / 30-minute behaviour untouched and stays signed in.
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "rememberMe" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable: email_verification_tokens
CREATE TABLE IF NOT EXISTS "email_verification_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'email_verification',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,

    CONSTRAINT "email_verification_tokens_pkey" PRIMARY KEY ("id")
);

-- Finding this user's live code, and sweeping expired ones.
CREATE INDEX IF NOT EXISTS "email_verification_tokens_userId_consumedAt_idx"
    ON "email_verification_tokens"("userId", "consumedAt");
CREATE INDEX IF NOT EXISTS "email_verification_tokens_expiresAt_idx"
    ON "email_verification_tokens"("expiresAt");

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_verification_tokens_userId_fkey') THEN
        ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_userId_fkey"
            FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$$;
