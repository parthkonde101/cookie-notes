'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/prisma';
import { Errors, toActionError } from '@/lib/errors';
import { requireApiAdmin } from '@/lib/auth/guards';
import { requestContext } from '@/lib/request';
import { recordEvent } from '@/lib/analytics/events';
import { writeAudit } from '@/lib/audit';
import { grantEntitlement, revokeEntitlementById } from '@/lib/access/entitlements';
import { firstError, grantSchema } from '@/lib/validation';
import type { EntitlementScope } from '@/generated/prisma/enums';
import type { ActionResult } from '@/app/admin/_actions/users';

function value(form: FormData, key: string): string {
  const raw = form.get(key);
  return typeof raw === 'string' ? raw.trim() : '';
}

/** Human-readable name for what is being granted, for the audit trail. */
async function describeTarget(scope: EntitlementScope, targetId: string | null): Promise<string> {
  if (scope === 'ALL' || !targetId) return 'the entire catalogue';
  if (scope === 'SEMESTER') {
    const row = await prisma.semester.findUnique({ where: { id: targetId }, select: { name: true } });
    return row ? `semester “${row.name}”` : 'a semester';
  }
  if (scope === 'SUBJECT') {
    const row = await prisma.subject.findUnique({ where: { id: targetId }, select: { name: true } });
    return row ? `subject “${row.name}”` : 'a subject';
  }
  if (scope === 'UNIT') {
    const row = await prisma.unit.findUnique({ where: { id: targetId }, select: { name: true } });
    return row ? `unit “${row.name}”` : 'a unit';
  }
  const row = await prisma.note.findUnique({ where: { id: targetId }, select: { title: true } });
  return row ? `note “${row.title}”` : 'a note';
}

export async function grantAccessAction(form: FormData): Promise<ActionResult> {
  try {
    const { user: admin } = await requireApiAdmin();
    const ctx = await requestContext();

    const parsed = grantSchema.safeParse({
      userId: value(form, 'userId'),
      scope: value(form, 'scope'),
      targetId: value(form, 'targetId'),
      expiresAt: value(form, 'expiresAt'),
      note: value(form, 'note'),
    });
    if (!parsed.success) throw Errors.validation(firstError(parsed.error));

    const { userId, scope, targetId, expiresAt, note } = parsed.data;
    if (scope !== 'ALL' && !targetId) {
      throw Errors.validation('Choose what exactly you are granting access to.');
    }

    const student = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true },
    });
    if (!student) throw Errors.notFound('That student no longer exists.');

    // Verify the target actually exists — never create a grant that points nowhere.
    const target = scope === 'ALL' ? null : targetId || null;
    if (target) {
      const exists =
        scope === 'SEMESTER'
          ? await prisma.semester.count({ where: { id: target } })
          : scope === 'SUBJECT'
            ? await prisma.subject.count({ where: { id: target } })
            : scope === 'UNIT'
              ? await prisma.unit.count({ where: { id: target } })
              : await prisma.note.count({ where: { id: target } });
      if (exists === 0) throw Errors.notFound('That item no longer exists.');
    }

    await grantEntitlement({
      userId,
      scope,
      targetId: target,
      grantedById: admin.id,
      source: 'ADMIN_GRANT',
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      note: note || null,
    });

    const label = await describeTarget(scope, target);

    await writeAudit({
      action: 'ACCESS_GRANTED',
      actorId: admin.id,
      actorEmail: admin.email,
      targetType: 'entitlement',
      targetId: `${userId}:${scope}:${target ?? 'ALL'}`,
      targetLabel: `${student.email} → ${label}`,
      metadata: { scope, target, expiresAt: expiresAt || null },
      ctx,
    });
    await recordEvent({
      type: 'ACCESS_GRANTED',
      userId: student.id,
      ctx,
      metadata: { scope, target, by: admin.email },
    });

    revalidatePath('/admin/users');
    revalidatePath(`/admin/users/${userId}`);
    return { ok: true, message: `Granted ${student.email} access to ${label}.` };
  } catch (error) {
    return toActionError(error);
  }
}

export async function revokeAccessAction(entitlementId: string): Promise<ActionResult> {
  try {
    const { user: admin } = await requireApiAdmin();
    const ctx = await requestContext();

    const entitlement = await prisma.entitlement.findUnique({
      where: { id: entitlementId },
      include: { user: { select: { id: true, email: true } } },
    });
    if (!entitlement) throw Errors.notFound('That grant no longer exists.');

    const label = await describeTarget(
      entitlement.scope,
      entitlement.targetKey.split(':').slice(1).join(':') || null,
    );

    await revokeEntitlementById(entitlementId);

    await writeAudit({
      action: 'ACCESS_REVOKED',
      actorId: admin.id,
      actorEmail: admin.email,
      targetType: 'entitlement',
      targetId: entitlementId,
      targetLabel: `${entitlement.user.email} → ${label}`,
      metadata: { scope: entitlement.scope, targetKey: entitlement.targetKey },
      ctx,
    });
    await recordEvent({
      type: 'ACCESS_REVOKED',
      userId: entitlement.user.id,
      ctx,
      metadata: { scope: entitlement.scope, targetKey: entitlement.targetKey, by: admin.email },
    });

    revalidatePath('/admin/users');
    revalidatePath(`/admin/users/${entitlement.userId}`);
    return { ok: true, message: `Revoked access for ${entitlement.user.email}.` };
  } catch (error) {
    return toActionError(error);
  }
}
