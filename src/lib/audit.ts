import 'server-only';
import { prisma } from '@/lib/prisma';
import type { AuditAction } from '@/generated/prisma/enums';
import type { RequestContext } from '@/lib/request';

export interface AuditInput {
  action: AuditAction;
  actorId?: string | null;
  actorEmail?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  targetLabel?: string | null;
  metadata?: Record<string, unknown> | null;
  ctx?: RequestContext | null;
}

/**
 * Append-only record of privileged actions: who did what, to whom, from where.
 * Written for every admin mutation so a security question later has an answer.
 */
export async function writeAudit(input: AuditInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action: input.action,
        actorId: input.actorId ?? null,
        actorEmail: input.actorEmail ?? null,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        targetLabel: input.targetLabel ?? null,
        metadata: (input.metadata ?? undefined) as never,
        ipAddress: input.ctx?.ip ?? null,
        userAgent: input.ctx?.userAgent?.slice(0, 512) ?? null,
      },
    });
  } catch (error) {
    console.error('[audit] failed to write audit log', input.action, error);
  }
}
