import 'server-only';
import { prisma } from '@/lib/prisma';
import { env } from '@/lib/env';
import { Errors } from '@/lib/errors';
import type { EntitlementScope, EntitlementSource } from '@/generated/prisma/enums';
import type { Prisma } from '@/generated/prisma/client';

/**
 * Authorisation for note content.
 *
 * Rules, in order:
 *   1. Admins can read everything.
 *   2. A note that is not PUBLISHED is invisible to students, full stop.
 *   3. A PUBLISHED note with visibility FREE is readable by any active student.
 *   4. Otherwise the student needs a non-expired entitlement covering the note,
 *      its unit, its subject, its semester, or the whole catalogue.
 *   5. Finally, while OPEN_ACCESS_MODE is on, any *signed-in* active student may
 *      read any published note. See `openAccessGrantsNote` below.
 *
 * The catalogue itself is public and identical for everyone — browsing is not
 * gated. These checks decide what happens when someone tries to *open* a note,
 * and they run on the server every time. The UI hides things it should not show,
 * but hiding is a courtesy; this file is the actual gate.
 */

export function targetKeyFor(scope: EntitlementScope, targetId: string | null): string {
  return `${scope}:${targetId ?? 'ALL'}`;
}

export interface GrantInput {
  userId: string;
  scope: EntitlementScope;
  targetId: string | null;
  grantedById?: string | null;
  source?: EntitlementSource;
  expiresAt?: Date | null;
  note?: string | null;
  /** Set by the future payment flow; the manual admin grant leaves it null. */
  orderId?: string | null;
}

/** Creates (or refreshes) an entitlement. Idempotent per (user, target). */
export async function grantEntitlement(input: GrantInput) {
  const targetKey = targetKeyFor(input.scope, input.targetId);

  const data = {
    userId: input.userId,
    scope: input.scope,
    targetKey,
    source: input.source ?? 'ADMIN_GRANT',
    grantedById: input.grantedById ?? null,
    orderId: input.orderId ?? null,
    note: input.note ?? null,
    expiresAt: input.expiresAt ?? null,
    semesterId: input.scope === 'SEMESTER' ? input.targetId : null,
    subjectId: input.scope === 'SUBJECT' ? input.targetId : null,
    unitId: input.scope === 'UNIT' ? input.targetId : null,
    noteId: input.scope === 'NOTE' ? input.targetId : null,
  };

  return prisma.entitlement.upsert({
    where: { userId_targetKey: { userId: input.userId, targetKey } },
    create: data,
    update: {
      source: data.source,
      grantedById: data.grantedById,
      expiresAt: data.expiresAt,
      note: data.note,
      grantedAt: new Date(),
    },
  });
}

/** Removes an entitlement. History stays in the audit log. */
export async function revokeEntitlement(
  userId: string,
  scope: EntitlementScope,
  targetId: string | null,
) {
  const targetKey = targetKeyFor(scope, targetId);
  return prisma.entitlement.deleteMany({ where: { userId, targetKey } });
}

export async function revokeEntitlementById(id: string) {
  return prisma.entitlement.delete({ where: { id } });
}

/** All target keys that currently grant this user access to something. */
export async function activeTargetKeys(userId: string): Promise<string[]> {
  const now = new Date();
  const rows = await prisma.entitlement.findMany({
    where: {
      userId,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    select: { targetKey: true },
  });
  return rows.map((r) => r.targetKey);
}

/**
 * A Prisma `where` fragment matching only the notes a student is *entitled* to.
 *
 * The public catalogue does not use this — everyone sees the same content. It is
 * used by the admin "what can this account actually open" panel, and it is what
 * a personalised view would use if one is ever wanted.
 */
export async function entitledNoteFilter(userId: string): Promise<Prisma.NoteWhereInput> {
  const keys = await activeTargetKeys(userId);

  if (keys.includes(targetKeyFor('ALL', null))) {
    return { status: 'PUBLISHED' };
  }

  const noteIds = keys.filter((k) => k.startsWith('NOTE:')).map((k) => k.slice(5));
  const unitIds = keys.filter((k) => k.startsWith('UNIT:')).map((k) => k.slice(5));
  const subjectIds = keys.filter((k) => k.startsWith('SUBJECT:')).map((k) => k.slice(8));
  const semesterIds = keys.filter((k) => k.startsWith('SEMESTER:')).map((k) => k.slice(9));

  const or: Prisma.NoteWhereInput[] = [{ visibility: 'FREE' }];
  if (noteIds.length) or.push({ id: { in: noteIds } });
  if (unitIds.length) or.push({ unitId: { in: unitIds } });
  if (subjectIds.length) or.push({ subjectId: { in: subjectIds } });
  if (semesterIds.length) or.push({ subject: { semesterId: { in: semesterIds } } });

  return { status: 'PUBLISHED', OR: or };
}

// ---------------------------------------------------------------------------
// Per-note decisions
// ---------------------------------------------------------------------------

export type AccessReason =
  | 'admin'
  | 'free'
  | 'entitlement'
  | 'open_access'
  | 'not_found'
  | 'not_published'
  | 'no_entitlement';

export type AccessDecision =
  | { allowed: true; reason: Extract<AccessReason, 'admin' | 'free' | 'entitlement' | 'open_access'>; via?: string }
  | { allowed: false; reason: Extract<AccessReason, 'not_found' | 'not_published' | 'no_entitlement'> };

/**
 * Preview mode.
 *
 * While `OPEN_ACCESS_MODE` is on, a signed-in active student may open any
 * published note. Everything else in the chain still applies: they must be
 * authenticated with a live session, the note must be published, and the
 * content route still demands a valid short-lived view token.
 *
 * Crucially this is checked *after* entitlements, so a genuine grant is still
 * recorded as the reason — turning the flag off changes who can read, and
 * nothing else.
 */
function openAccessGrantsNote(): boolean {
  return env.catalog.openAccess;
}

/**
 * The authoritative per-note check. Called before listing metadata, before
 * issuing a view token, and again before a single byte of content is streamed.
 */
export async function checkNoteAccess(
  userId: string,
  role: 'STUDENT' | 'ADMIN',
  noteId: string,
): Promise<AccessDecision> {
  const note = await prisma.note.findUnique({
    where: { id: noteId },
    select: {
      id: true,
      status: true,
      visibility: true,
      unitId: true,
      subjectId: true,
      subject: { select: { semesterId: true } },
    },
  });

  if (!note) return { allowed: false, reason: 'not_found' };
  if (role === 'ADMIN') return { allowed: true, reason: 'admin' };
  if (note.status !== 'PUBLISHED') return { allowed: false, reason: 'not_published' };
  if (note.visibility === 'FREE') return { allowed: true, reason: 'free' };

  const candidates = candidateKeys({
    noteId: note.id,
    unitId: note.unitId,
    subjectId: note.subjectId,
    semesterId: note.subject.semesterId,
  });

  const now = new Date();
  const match = await prisma.entitlement.findFirst({
    where: {
      userId,
      targetKey: { in: candidates },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    select: { targetKey: true },
  });

  if (match) return { allowed: true, reason: 'entitlement', via: match.targetKey };
  if (openAccessGrantsNote()) return { allowed: true, reason: 'open_access' };

  return { allowed: false, reason: 'no_entitlement' };
}

/** Throws the right HTTP error instead of returning a decision. */
export async function assertNoteAccess(
  userId: string,
  role: 'STUDENT' | 'ADMIN',
  noteId: string,
): Promise<void> {
  const decision = await checkNoteAccess(userId, role, noteId);
  if (decision.allowed) return;

  // "Does not exist" and "not allowed to you" answer the same way, so the
  // endpoint cannot be used to enumerate which note ids are real.
  throw Errors.notFound('This note is not available on your account.');
}

function candidateKeys(location: {
  noteId: string;
  unitId: string | null;
  subjectId: string;
  semesterId: string;
}): string[] {
  return [
    targetKeyFor('NOTE', location.noteId),
    location.unitId ? targetKeyFor('UNIT', location.unitId) : null,
    targetKeyFor('SUBJECT', location.subjectId),
    targetKeyFor('SEMESTER', location.semesterId),
    targetKeyFor('ALL', null),
  ].filter((value): value is string => value !== null);
}

// ---------------------------------------------------------------------------
// Batch state for the catalogue
// ---------------------------------------------------------------------------

/**
 * What a note card should offer the current visitor.
 *
 * This is a *display* state only — it decides which action a card shows. Every
 * actual read still goes through `checkNoteAccess` on the server, so nothing
 * here can grant access on its own.
 */
export type NoteAccessState =
  /** Signed out: clicking opens the sign-in modal. */
  | { kind: 'sign_in_required' }
  /**
   * Readable right now. `via` records *why* for analytics and admin tooling;
   * the student-facing card deliberately does not surface it.
   */
  | { kind: 'open'; via: 'admin' | 'free' | 'entitlement' | 'preview' }
  /** Signed in, but this note is not on their account and preview mode is off. */
  | { kind: 'unavailable' };

export interface NoteLocationInput {
  id: string;
  visibility: 'FREE' | 'RESTRICTED';
  unitId: string | null;
  subjectId: string;
  semesterId: string;
}

/**
 * Resolves the access state for a page of notes with a single entitlement query,
 * using exactly the rules `checkNoteAccess` applies one note at a time.
 *
 * The catalogue is identical for everyone, so this never filters anything out —
 * it only decides which action each card offers.
 */
export async function resolveNoteAccessStates(
  viewer: { id: string; role: 'STUDENT' | 'ADMIN' } | null,
  notes: NoteLocationInput[],
): Promise<Map<string, NoteAccessState>> {
  const states = new Map<string, NoteAccessState>();
  if (notes.length === 0) return states;

  if (!viewer) {
    for (const note of notes) states.set(note.id, { kind: 'sign_in_required' });
    return states;
  }

  if (viewer.role === 'ADMIN') {
    for (const note of notes) states.set(note.id, { kind: 'open', via: 'admin' });
    return states;
  }

  const keys = new Set(await activeTargetKeys(viewer.id));
  const preview = openAccessGrantsNote();

  for (const note of notes) {
    if (note.visibility === 'FREE') {
      states.set(note.id, { kind: 'open', via: 'free' });
      continue;
    }

    const entitled = candidateKeys({
      noteId: note.id,
      unitId: note.unitId,
      subjectId: note.subjectId,
      semesterId: note.semesterId,
    }).some((key) => keys.has(key));

    if (entitled) {
      states.set(note.id, { kind: 'open', via: 'entitlement' });
    } else if (preview) {
      states.set(note.id, { kind: 'open', via: 'preview' });
    } else {
      states.set(note.id, { kind: 'unavailable' });
    }
  }

  return states;
}

/** True when the platform is running in open preview. Display use only. */
export function isPreviewMode(): boolean {
  return env.catalog.openAccess;
}
