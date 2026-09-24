-- V8: the Program axis — B.Tech and Polytechnic as a property of the catalogue.
--
-- PROGRAM IS A CONTENT DIMENSION, NOT A STUDENT ATTRIBUTE.
--
-- It lands on `semesters` and on nothing else. A subject's program is its
-- semester's; a note's is its subject's semester's. Always derived, never
-- copied — one column to be right about instead of a denormalised field per
-- note and a repair script for the first time they drift.
--
-- `users` is deliberately untouched. Every student can read both programs, the
-- selector at the top of the catalogue is a view preference kept in the
-- browser, and no authorisation path knows this enum exists. In particular the
-- existing free-text `users.program` column — whatever students typed into the
-- optional "Programme" box at sign-up — keeps its name, its type and its data.
--
-- ADDITIVE AND NON-DESTRUCTIVE. No row is rewritten, nothing is dropped or
-- renamed, and no UPDATE statement appears below.
--
--   * no user, password, role, status, session or entitlement is touched
--   * no note, order, analytics event or audit row is touched
--   * the catalogue keeps working unchanged: every existing semester becomes
--     BTECH, which is what all existing content in fact is
--
-- THE BACKFILL IS THE DEFAULT, WHICH IS WHY THERE IS NO UPDATE.
--
-- `NOT NULL DEFAULT` on a non-volatile value is a catalogue change in Postgres
-- 11+: the default is stored once in pg_attribute and materialised on read, so
-- adding it to a table of any size does not rewrite a single page and does not
-- take a long lock. Every existing semester becomes BTECH the instant this
-- runs, with no write amplification and no risk of a half-finished backfill.
--
-- Every statement is guarded, so re-running the file is a no-op rather than an
-- error — which is what `scripts/apply-migrations.ts` needs to be safe to
-- re-run against a database that is already at V8.

-- CreateEnum
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'Program') THEN
        CREATE TYPE "Program" AS ENUM ('BTECH', 'POLYTECHNIC');
    END IF;
END
$$;

-- AlterTable: semesters — the catalogue gains its program axis.
ALTER TABLE "semesters" ADD COLUMN IF NOT EXISTS "program" "Program" NOT NULL DEFAULT 'BTECH';

-- Index.
--
-- `semesters(program, isArchived, position)` is the catalogue's read path, for
-- both the student shelf and the admin tree: give me this program's live
-- semesters in display order. It mirrors the existing
-- `semesters(isArchived, position)` with the program column in front.
CREATE INDEX IF NOT EXISTS "semesters_program_isArchived_position_idx"
    ON "semesters"("program", "isArchived", "position");
