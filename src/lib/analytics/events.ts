import 'server-only';
import { prisma } from '@/lib/prisma';
import type { EventType } from '@/generated/prisma/enums';
import type { RequestContext } from '@/lib/request';

export interface EventInput {
  type: EventType;
  userId?: string | null;
  sessionId?: string | null;
  noteId?: string | null;
  subjectId?: string | null;
  ctx?: RequestContext | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * The single entry point for analytics.
 *
 * Everything the admin analytics screens show is derived from this table, so
 * nothing is estimated or hard-coded. Recording is best-effort: a failure here
 * must never break the user-facing action that triggered it.
 */
export async function recordEvent(input: EventInput): Promise<void> {
  try {
    await prisma.activityEvent.create({
      data: {
        type: input.type,
        userId: input.userId ?? null,
        sessionId: input.sessionId ?? null,
        noteId: input.noteId ?? null,
        subjectId: input.subjectId ?? null,
        ipAddress: input.ctx?.ip ?? null,
        userAgent: input.ctx?.userAgent?.slice(0, 512) ?? null,
        metadata: (input.metadata ?? undefined) as never,
      },
    });
  } catch (error) {
    console.error('[analytics] failed to record event', input.type, error);
  }
}

/** Convenience for the many places that fire an event without awaiting it. */
export function recordEventAsync(input: EventInput): void {
  void recordEvent(input);
}
