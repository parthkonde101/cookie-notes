'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/prisma';
import { Errors, toActionError } from '@/lib/errors';
import { requireApiAdmin } from '@/lib/auth/guards';
import { requestContext } from '@/lib/request';
import { hashPassword, checkPasswordStrength } from '@/lib/auth/password';
import { endOtherSessions, endSession } from '@/lib/auth/session';
import { recordEvent } from '@/lib/analytics/events';
import { writeAudit } from '@/lib/audit';
import { adminUserSchema, firstError } from '@/lib/validation';

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string; code?: string };

function value(form: FormData, key: string): string {
  const raw = form.get(key);
  return typeof raw === 'string' ? raw.trim() : '';
}

export async function createUserAction(form: FormData): Promise<ActionResult> {
  try {
    const { user: admin } = await requireApiAdmin();
    const ctx = await requestContext();

    const parsed = adminUserSchema.safeParse({
      name: value(form, 'name'),
      email: value(form, 'email'),
      password: value(form, 'password'),
      role: value(form, 'role') || 'STUDENT',
      college: value(form, 'college'),
      program: value(form, 'program'),
      semester: value(form, 'semester') || undefined,
    });
    if (!parsed.success) throw Errors.validation(firstError(parsed.error));

    const strength = checkPasswordStrength(parsed.data.password, parsed.data.email);
    if (!strength.ok) throw Errors.validation(strength.problems[0]!);

    const existing = await prisma.user.findUnique({
      where: { email: parsed.data.email },
      select: { id: true },
    });
    if (existing) throw Errors.conflict('An account with that email already exists.');

    const created = await prisma.user.create({
      data: {
        name: parsed.data.name,
        email: parsed.data.email,
        passwordHash: await hashPassword(parsed.data.password),
        role: parsed.data.role,
        college: parsed.data.college || null,
        program: parsed.data.program || null,
        semester: parsed.data.semester ?? null,
        createdById: admin.id,
      },
    });

    await writeAudit({
      action: 'USER_CREATED',
      actorId: admin.id,
      actorEmail: admin.email,
      targetType: 'user',
      targetId: created.id,
      targetLabel: created.email,
      metadata: { role: created.role },
      ctx,
    });
    await recordEvent({
      type: 'ACCOUNT_CREATED',
      userId: created.id,
      ctx,
      metadata: { createdBy: admin.email },
    });

    revalidatePath('/admin/users');
    return { ok: true, message: `${created.email} created.` };
  } catch (error) {
    return toActionError(error);
  }
}

export async function setUserStatusAction(
  userId: string,
  status: 'ACTIVE' | 'DISABLED',
): Promise<ActionResult> {
  try {
    const { user: admin } = await requireApiAdmin();
    const ctx = await requestContext();

    const target = await prisma.user.findUnique({ where: { id: userId } });
    if (!target) throw Errors.notFound('That account no longer exists.');
    if (target.id === admin.id) throw Errors.validation('You cannot disable your own account.');

    await prisma.user.update({
      where: { id: userId },
      data: {
        status,
        disabledAt: status === 'DISABLED' ? new Date() : null,
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });

    // A disabled account must lose its live session immediately, not at next login.
    if (status === 'DISABLED') {
      await endOtherSessions(userId, null, 'TERMINATED', 'account_disabled');
    }

    await writeAudit({
      action: status === 'DISABLED' ? 'USER_DISABLED' : 'USER_ENABLED',
      actorId: admin.id,
      actorEmail: admin.email,
      targetType: 'user',
      targetId: target.id,
      targetLabel: target.email,
      ctx,
    });
    await recordEvent({
      type: status === 'DISABLED' ? 'ACCOUNT_DISABLED' : 'ACCOUNT_ENABLED',
      userId: target.id,
      ctx,
      metadata: { by: admin.email },
    });

    revalidatePath('/admin/users');
    revalidatePath(`/admin/users/${userId}`);
    return { ok: true, message: status === 'DISABLED' ? 'Account disabled.' : 'Account reactivated.' };
  } catch (error) {
    return toActionError(error);
  }
}

export async function updateUserAction(userId: string, form: FormData): Promise<ActionResult> {
  try {
    const { user: admin } = await requireApiAdmin();
    const ctx = await requestContext();

    const target = await prisma.user.findUnique({ where: { id: userId } });
    if (!target) throw Errors.notFound('That account no longer exists.');

    const name = value(form, 'name');
    const role = value(form, 'role') as 'STUDENT' | 'ADMIN';
    if (name.length < 2) throw Errors.validation('Enter a valid name.');
    if (!['STUDENT', 'ADMIN'].includes(role)) throw Errors.validation('Choose a valid role.');
    if (target.id === admin.id && role !== 'ADMIN') {
      throw Errors.validation('You cannot remove your own admin role.');
    }

    await prisma.user.update({
      where: { id: userId },
      data: {
        name,
        role,
        college: value(form, 'college') || null,
        program: value(form, 'program') || null,
        semester: value(form, 'semester') ? Number(value(form, 'semester')) : null,
      },
    });

    await writeAudit({
      action: 'USER_UPDATED',
      actorId: admin.id,
      actorEmail: admin.email,
      targetType: 'user',
      targetId: target.id,
      targetLabel: target.email,
      metadata: { name, role },
      ctx,
    });
    await recordEvent({ type: 'USER_MODIFIED', userId: target.id, ctx, metadata: { by: admin.email } });

    revalidatePath(`/admin/users/${userId}`);
    return { ok: true, message: 'Saved.' };
  } catch (error) {
    return toActionError(error);
  }
}

export async function resetUserPasswordAction(
  userId: string,
  form: FormData,
): Promise<ActionResult> {
  try {
    const { user: admin } = await requireApiAdmin();
    const ctx = await requestContext();

    const password = value(form, 'password');
    const target = await prisma.user.findUnique({ where: { id: userId } });
    if (!target) throw Errors.notFound('That account no longer exists.');

    const strength = checkPasswordStrength(password, target.email);
    if (!strength.ok) throw Errors.validation(strength.problems[0]!);

    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await hashPassword(password), failedLoginCount: 0, lockedUntil: null },
    });
    await endOtherSessions(userId, null, 'TERMINATED', 'password_reset_by_admin');

    await writeAudit({
      action: 'USER_PASSWORD_RESET',
      actorId: admin.id,
      actorEmail: admin.email,
      targetType: 'user',
      targetId: target.id,
      targetLabel: target.email,
      metadata: { via: 'admin' },
      ctx,
    });

    revalidatePath(`/admin/users/${userId}`);
    return { ok: true, message: 'Password updated and existing sessions ended.' };
  } catch (error) {
    return toActionError(error);
  }
}

export async function deleteUserAction(userId: string): Promise<ActionResult> {
  try {
    const { user: admin } = await requireApiAdmin();
    const ctx = await requestContext();

    const target = await prisma.user.findUnique({ where: { id: userId } });
    if (!target) throw Errors.notFound('That account no longer exists.');
    if (target.id === admin.id) throw Errors.validation('You cannot delete your own account.');
    if (target.role === 'ADMIN') {
      const adminCount = await prisma.user.count({ where: { role: 'ADMIN', status: 'ACTIVE' } });
      if (adminCount <= 1) throw Errors.validation('You cannot delete the last active admin.');
    }

    // Audit first: the row is about to disappear, the record of it must not.
    await writeAudit({
      action: 'USER_DELETED',
      actorId: admin.id,
      actorEmail: admin.email,
      targetType: 'user',
      targetId: target.id,
      targetLabel: target.email,
      metadata: { role: target.role, createdAt: target.createdAt.toISOString() },
      ctx,
    });

    await prisma.user.delete({ where: { id: userId } });

    revalidatePath('/admin/users');
    return { ok: true, message: `${target.email} deleted.` };
  } catch (error) {
    return toActionError(error);
  }
}

export async function terminateSessionAction(sessionId: string): Promise<ActionResult> {
  try {
    const { user: admin } = await requireApiAdmin();
    const ctx = await requestContext();

    const target = await prisma.session.findUnique({
      where: { id: sessionId },
      include: { user: { select: { email: true, id: true } } },
    });
    if (!target) throw Errors.notFound('That session no longer exists.');

    await endSession(sessionId, 'TERMINATED', `terminated_by_${admin.email}`);

    await writeAudit({
      action: 'SESSION_TERMINATED',
      actorId: admin.id,
      actorEmail: admin.email,
      targetType: 'session',
      targetId: sessionId,
      targetLabel: target.user.email,
      ctx,
    });
    await recordEvent({
      type: 'SESSION_TERMINATED',
      userId: target.user.id,
      sessionId,
      ctx,
      metadata: { by: admin.email },
    });

    revalidatePath('/admin/sessions');
    revalidatePath(`/admin/users/${target.userId}`);
    return { ok: true, message: 'Session ended.' };
  } catch (error) {
    return toActionError(error);
  }
}
