import 'server-only';
import { prisma } from '@/lib/prisma';
import { env } from '@/lib/env';
import { noteReadyEmail, sendMailBatch } from '@/lib/mail';
import { recordEvent } from '@/lib/analytics/events';
import { writeAudit } from '@/lib/audit';
import type { RequestContext } from '@/lib/request';

/**
 * "Your notes are ready" delivery.
 *
 * Everything here runs *after* a note row exists. The caller only reaches this
 * module once the bytes are in private storage and the database has committed,
 * so a failed upload or a failed write can never produce an email — and an
 * email failure never unwinds the upload: the note stays published and the
 * problem is recorded against the recipient row and logged.
 *
 * Exactly-once is enforced by the database rather than by care:
 *
 *   1. Work out the recipient set (subscribers, plus every eligible user when
 *      the admin ticked "Notify all"), deduplicated by user id.
 *   2. Insert a PENDING `NoteNotification` row per recipient with
 *      `skipDuplicates`, keyed unique on (eventKey, userId).
 *   3. Send only to the rows this call actually created.
 *
 * A retry — a double-submitted form, a redeploy mid-request, an admin clicking
 * twice — inserts nothing at step 2, finds nothing at step 3, and mails nobody.
 */

export type NoteNotifyReason = 'first_upload' | 'admin_broadcast';

export interface NotifyNoteReadyInput {
  unitId: string;
  noteId: string;
  /** Identifies this specific upload; the event key is built from it. */
  noteVersionId: string;
  /** True when the admin ticked "Notify all users" in the upload dialog. */
  notifyAll: boolean;
  /**
   * False for a replacement upload. Subscribers are notified automatically only
   * when a unit gets its *first* PDF; a replacement notifies nobody unless the
   * admin explicitly asks via `notifyAll`.
   */
  notifySubscribers: boolean;
  actor: { id: string; email: string };
  ctx: RequestContext;
}

export interface NotifyNoteReadyResult {
  eventKey: string;
  /** Recipients this call claimed and attempted. */
  attempted: number;
  sent: number;
  failed: number;
  /** True when the event had already been dispatched and nothing was resent. */
  alreadyDispatched: boolean;
  subscribers: number;
}

export function noteReadyEventKey(unitId: string, noteVersionId: string): string {
  return `unit-ready:${unitId}:${noteVersionId}`;
}

export async function notifyNoteReady(
  input: NotifyNoteReadyInput,
): Promise<NotifyNoteReadyResult> {
  const { unitId, noteId, noteVersionId, notifyAll, notifySubscribers, actor, ctx } = input;
  const eventKey = noteReadyEventKey(unitId, noteVersionId);

  const unit = await prisma.unit.findUnique({
    where: { id: unitId },
    select: {
      id: true,
      name: true,
      subject: {
        select: {
          id: true,
          name: true,
          slug: true,
          units: { orderBy: [{ position: 'asc' }, { name: 'asc' }], select: { id: true } },
        },
      },
    },
  });
  if (!unit) {
    return { eventKey, attempted: 0, sent: 0, failed: 0, alreadyDispatched: false, subscribers: 0 };
  }

  // The number a student sees on the card, so the email agrees with the app.
  const unitIndex = Math.max(1, unit.subject.units.findIndex((u) => u.id === unit.id) + 1);

  const subscriberRows = notifySubscribers
    ? await prisma.unitNotificationSubscription.findMany({
        where: { unitId, user: { status: 'ACTIVE', deletedAt: null } },
        select: { user: { select: { id: true, email: true, name: true } } },
      })
    : [];

  const broadcastRows = notifyAll
    ? await prisma.user.findMany({
        // Eligible = an account that can actually sign in and read the note.
        // Disabled and deleted accounts are never mailed.
        where: { status: 'ACTIVE', deletedAt: null },
        select: { id: true, email: true, name: true },
      })
    : [];

  // Deduplicate by user id: a subscriber who is also in the broadcast list is
  // one recipient, and gets one email.
  const recipients = new Map<string, { id: string; email: string; name: string }>();
  const viaSubscription = new Set<string>();
  for (const row of subscriberRows) {
    recipients.set(row.user.id, row.user);
    viaSubscription.add(row.user.id);
  }
  for (const user of broadcastRows) recipients.set(user.id, user);

  const subscribers = subscriberRows.length;
  if (recipients.size === 0) {
    return { eventKey, attempted: 0, sent: 0, failed: 0, alreadyDispatched: false, subscribers };
  }

  // Claim the recipients. Anything already present belongs to an earlier
  // dispatch of this same event and is deliberately skipped.
  await prisma.noteNotification.createMany({
    data: [...recipients.values()].map((user) => ({
      eventKey,
      unitId,
      noteId,
      userId: user.id,
      viaSubscription: viaSubscription.has(user.id),
    })),
    skipDuplicates: true,
  });

  const claimed = await prisma.noteNotification.findMany({
    where: { eventKey, status: 'PENDING' },
    select: { id: true, userId: true },
  });

  if (claimed.length === 0) {
    console.info(`[notify] ${eventKey} already dispatched; nothing to send`);
    return {
      eventKey,
      attempted: 0,
      sent: 0,
      failed: 0,
      alreadyDispatched: true,
      subscribers,
    };
  }

  const url = `${env.appUrl.replace(/\/$/, '')}/subject/${unit.subject.slug}`;
  const byUser = new Map(claimed.map((row) => [row.userId, row.id]));

  const messages = claimed.flatMap((row) => {
    const user = recipients.get(row.userId);
    if (!user) return [];
    return [
      {
        ...noteReadyEmail({
          name: user.name,
          subjectName: unit.subject.name,
          unitName: unit.name,
          unitIndex,
          url,
        }),
        to: user.email,
      },
    ];
  });

  await prisma.noteNotification.updateMany({
    where: { id: { in: claimed.map((row) => row.id) } },
    data: { attempts: { increment: 1 } },
  });

  const result = await sendMailBatch(messages, { idempotencyKey: eventKey });

  const emailToUser = new Map<string, string>();
  for (const [userId] of byUser) {
    const user = recipients.get(userId);
    if (user) emailToUser.set(user.email, userId);
  }

  const sentIds = result.sent
    .map((email) => byUser.get(emailToUser.get(email) ?? ''))
    .filter((id): id is string => Boolean(id));

  if (sentIds.length > 0) {
    await prisma.noteNotification.updateMany({
      where: { id: { in: sentIds } },
      data: { status: 'SENT', sentAt: new Date(), error: null },
    });
  }

  for (const failure of result.failed) {
    const id = byUser.get(emailToUser.get(failure.to) ?? '');
    if (!id) continue;
    await prisma.noteNotification.update({
      where: { id },
      data: { status: 'FAILED', error: failure.error.slice(0, 500) },
    });
  }

  if (result.failed.length > 0) {
    // Loud, but not fatal: the note is published and stays published.
    console.error(
      `[notify] ${eventKey}: ${result.failed.length}/${messages.length} note-ready emails failed. ` +
        `First error: ${result.failed[0]?.error ?? 'unknown'}`,
    );
  }

  await writeAudit({
    action: 'NOTE_NOTIFICATION_SENT',
    actorId: actor.id,
    actorEmail: actor.email,
    targetType: 'unit',
    targetId: unitId,
    targetLabel: `${unit.subject.name} · ${unit.name}`,
    metadata: {
      eventKey,
      attempted: messages.length,
      sent: result.sent.length,
      failed: result.failed.length,
      notifyAll,
      subscribers,
    },
    ctx,
  });

  await recordEvent({
    type: 'NOTE_NOTIFICATION_SENT',
    userId: actor.id,
    noteId,
    subjectId: unit.subject.id,
    ctx,
    metadata: { eventKey, sent: result.sent.length, failed: result.failed.length },
  });

  return {
    eventKey,
    attempted: messages.length,
    sent: result.sent.length,
    failed: result.failed.length,
    alreadyDispatched: false,
    subscribers,
  };
}
