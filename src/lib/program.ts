import type { Program } from '@/generated/prisma/enums';

/**
 * The program axis, as the application talks about it.
 *
 * ## What a program is, and what it is not
 *
 * A program is a property of *content*. It lives on `Semester` and is inherited
 * downwards — a subject's program is its semester's, a note's is its subject's
 * semester's. Nothing else in the database carries it.
 *
 * It is emphatically **not** a property of a student. There is no
 * `User.program`, no program claim on the session, and no branch anywhere in
 * `lib/access` that reads this module. Every student may read every program;
 * choosing one only decides which shelf the catalogue draws. That is why the
 * selection lives in a cookie and a query string rather than in the database:
 * it is a view preference, and losing it costs nobody anything.
 *
 * Keeping this file free of imports from `lib/prisma` or `lib/auth` is
 * deliberate — it is shared by server components and by the client selector, so
 * it must stay safe to pull into a browser bundle.
 */

export type { Program };

/** The default shelf: what a visitor sees before they have chosen anything. */
export const DEFAULT_PROGRAM: Program = 'BTECH';

/**
 * Remembers the last shelf a visitor looked at.
 *
 * Readable by script on purpose. The selector writes it directly so the choice
 * survives a refresh without a round trip, and there is nothing to protect: the
 * worst a forged value can do is show you the other catalogue, which is a
 * button press away regardless. Not `HttpOnly`, not `secure`-only, and
 * explicitly *not* modelled on the session cookies in `lib/auth/session.ts` —
 * those guard access, this one guards nothing.
 */
export const PROGRAM_COOKIE = 'cn_program';

/**
 * The same idea for the admin Notes screen, kept in a separate cookie.
 *
 * An admin spending the afternoon filing Polytechnic PDFs should not find the
 * public catalogue has quietly switched to Polytechnic underneath them, and
 * browsing the student shelf should not move the tree they are working in. Two
 * surfaces, two memories, no surprises.
 */
export const ADMIN_PROGRAM_COOKIE = 'cn_admin_program';

/** How long a shelf choice is remembered. A year, then back to B.Tech. */
export const PROGRAM_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** The query-string key, so a link can carry the shelf it was copied from. */
export const PROGRAM_PARAM = 'program';

export interface ProgramOption {
  value: Program;
  /** What students and admins read. Never the enum name. */
  label: string;
}

/**
 * The two programs, in the order they are offered.
 *
 * B.Tech first because it is the default and holds all the existing content.
 * The selector renders whatever is in this array, so adding a third program
 * later is a one-line change here plus a value on the enum.
 */
export const PROGRAMS: readonly ProgramOption[] = [
  { value: 'BTECH', label: 'B.Tech' },
  { value: 'POLYTECHNIC', label: 'Polytechnic' },
] as const;

/** The display label for a program, for headings and form hints. */
export function programLabel(program: Program): string {
  return PROGRAMS.find((option) => option.value === program)?.label ?? program;
}

/**
 * Drops a program name from the front of a semester's title, for display.
 *
 * ## Why this exists
 *
 * Before programs were a column, the only way to tell a B.Tech semester from a
 * Polytechnic one was to say so in its name — so catalogues are full of
 * semesters called "B.Tech Semester 1". Now that the selector states the
 * program once, repeating it on every heading underneath is noise:
 *
 *     B.Tech · Semester 1      →  Semester 1
 *     B.Tech Semester 2        →  Semester 2
 *     Polytechnic - Year 1     →  Year 1
 *
 * PRESENTATION ONLY. Nothing is renamed and nothing is written: the stored
 * name is untouched, the admin still sees and edits the real thing, and the
 * program association lives where it always has, on `Semester.program`. This
 * only decides what a heading reads.
 *
 * ## What it refuses to do
 *
 * It strips only a *leading* program name, only when a separator or whitespace
 * follows it, and only when something is left over. "B.Tech" as an entire
 * semester name survives intact, and so does "Advanced B.Tech Topics" — a name
 * that merely contains the words is not a prefix. Matching ignores case,
 * dots and spaces, so "BTech", "B Tech" and "b.tech" are all recognised as the
 * same prefix a student would read as redundant.
 */
export function stripProgramPrefix(name: string, program: Program): string {
  const trimmed = name.trim();
  // "B.Tech" → "btech", so the spelling in the database does not have to match
  // the spelling in PROGRAMS for the prefix to be recognised.
  const flatten = (value: string) => value.toLowerCase().replace(/[.\s]/g, '');
  const target = flatten(programLabel(program));

  for (let cut = 1; cut <= trimmed.length; cut += 1) {
    if (flatten(trimmed.slice(0, cut)) !== target) continue;

    // A separator must follow, or "Polytechnical" would lose its head.
    const rest = trimmed.slice(cut).replace(/^[\s·:—–-]+/, '');
    if (rest === trimmed.slice(cut)) break;
    // Never return an empty heading: a semester actually called "B.Tech" keeps
    // its name rather than rendering as a blank row.
    return rest.length > 0 ? rest : trimmed;
  }

  return trimmed;
}

/**
 * Narrows arbitrary input — a query parameter, a cookie, a form field — to a
 * program, or `null` when it is not one.
 *
 * Returning `null` rather than the default is what lets callers distinguish
 * "asked for something invalid" from "did not ask", which matters on the admin
 * side: an upload naming a program that does not exist should be rejected, not
 * quietly filed under B.Tech.
 */
export function parseProgram(value: unknown): Program | null {
  return PROGRAMS.some((option) => option.value === value) ? (value as Program) : null;
}

/**
 * Resolves the shelf to render from the two places a choice can come from.
 *
 * The query string wins over the cookie so that a pasted link opens the shelf
 * it was copied from, whatever the recipient last looked at. Anything
 * unrecognised falls through to B.Tech rather than erroring — a mistyped URL
 * should show the catalogue, not a stack trace.
 */
export function resolveProgram(
  param: string | string[] | undefined,
  cookieValue: string | undefined,
): Program {
  const fromParam = parseProgram(Array.isArray(param) ? param[0] : param);
  if (fromParam) return fromParam;
  return parseProgram(cookieValue) ?? DEFAULT_PROGRAM;
}
