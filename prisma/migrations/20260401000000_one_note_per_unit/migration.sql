-- V4: one unit, one PDF.
--
-- Nothing is dropped, renamed or emptied. No column is altered and no row is
-- touched. The only structural change is an index swap on `notes`: the plain
-- `("unitId")` index is replaced by a UNIQUE index on the same column, which
-- serves every lookup the old one did and additionally enforces the new rule.
-- The `topics` table, `notes.topicId` and every existing foreign key are left
-- exactly as they are — nothing here depends on them being gone, and dropping
-- them would be a cosmetic change that could break older data or migrations.
--
-- Why a plain UNIQUE and not a partial index
-- ------------------------------------------
-- Postgres treats NULLs as distinct inside a unique index, so
-- UNIQUE ("unitId") constrains only the rows that actually name a unit: each
-- unit may have at most one note, while any number of notes may still sit
-- outside the unit structure with a NULL `unitId`. That is precisely the rule we
-- want, and unlike a partial index it is expressible in the Prisma schema, so
-- the client and the database cannot drift apart.
--
-- Pre-flight
-- ----------
-- The previous model deliberately allowed a unit to hold several notes (one per
-- topic), so a database that has been in use may already violate the new rule.
-- Silently deleting or re-parenting those notes would destroy an admin's work,
-- so instead this migration refuses to run and names the units involved. The
-- fix is a decision only a human can make: keep one note per listed unit and
-- either detach the rest (set `unitId` to NULL, which keeps the file and the
-- note) or archive them, then re-run the migration.

DO $$
DECLARE
    offenders text;
    offending_units int;
BEGIN
    SELECT string_agg(detail, E'\n  ' ORDER BY detail), count(*)
      INTO offenders, offending_units
      FROM (
        SELECT 'unit ' || u.id || ' (' || u."name" || ') has ' || count(n.id) || ' notes: '
                 || string_agg(n.id, ', ' ORDER BY n."createdAt") AS detail
          FROM "notes" n
          JOIN "units" u ON u.id = n."unitId"
         WHERE n."unitId" IS NOT NULL
         GROUP BY u.id, u."name"
        HAVING count(n.id) > 1
      ) AS duplicates;

    IF offending_units > 0 THEN
        RAISE EXCEPTION E'Cannot enforce one note per unit: % unit(s) already hold more than one note.\n  %\n\nNo data has been changed. Decide which note each unit should keep, then either detach the others (UPDATE "notes" SET "unitId" = NULL WHERE id IN (...)) or archive them (UPDATE "notes" SET "status" = ''ARCHIVED'', "unitId" = NULL WHERE id IN (...)), and run the migration again.',
            offending_units, offenders;
    END IF;
END
$$;

-- The unique index below covers every query the plain index served, so keeping
-- both would only cost writes.
DROP INDEX IF EXISTS "notes_unitId_idx";

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "notes_unitId_key" ON "notes"("unitId");
