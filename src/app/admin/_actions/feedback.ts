'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/prisma';
import { Errors, toActionError } from '@/lib/errors';
import { requireApiAdmin } from '@/lib/auth/guards';
import { requestContext } from '@/lib/request';
import { writeAudit } from '@/lib/audit';
import type { ActionResult } from '@/app/admin/_actions/users';

async function loadTarget(id: string) {
  const feedback = await prisma.feedback.findUnique({
    where: { id },
    select: { id: true, status: true, featured: true, publicConsent: true, userId: true },
  });
  if (!feedback) throw Errors.notFound('That feedback no longer exists.');
  return feedback;
}

export async function markFeedbackReviewedAction(id: string): Promise<ActionResult> {
  try {
    const { user: admin } = await requireApiAdmin();
    const ctx = await requestContext();
    const feedback = await loadTarget(id);

    await prisma.feedback.update({
      where: { id },
      data: { status: 'REVIEWED', reviewedAt: new Date(), reviewedById: admin.id },
    });

    await writeAudit({
      action: 'FEEDBACK_REVIEWED',
      actorId: admin.id,
      actorEmail: admin.email,
      targetType: 'feedback',
      targetId: feedback.id,
      ctx,
    });

    revalidatePath('/admin/feedback');
    return { ok: true, message: 'Marked as reviewed.' };
  } catch (error) {
    return toActionError(error);
  }
}

/** Requires REVIEWED + publicConsent — both checked here, not left to the UI. */
export async function featureFeedbackAction(id: string): Promise<ActionResult> {
  try {
    const { user: admin } = await requireApiAdmin();
    const ctx = await requestContext();
    const feedback = await loadTarget(id);

    if (feedback.status !== 'REVIEWED') {
      throw Errors.validation('Review this feedback before featuring it.');
    }
    if (!feedback.publicConsent) {
      throw Errors.validation("This student hasn't consented to public display, so this can't be featured.");
    }

    await prisma.feedback.update({
      where: { id },
      data: { featured: true, featuredAt: new Date() },
    });

    await writeAudit({
      action: 'FEEDBACK_FEATURED',
      actorId: admin.id,
      actorEmail: admin.email,
      targetType: 'feedback',
      targetId: feedback.id,
      ctx,
    });

    revalidatePath('/admin/feedback');
    revalidatePath('/');
    return { ok: true, message: 'Featured on the homepage.' };
  } catch (error) {
    return toActionError(error);
  }
}

export async function unfeatureFeedbackAction(id: string): Promise<ActionResult> {
  try {
    const { user: admin } = await requireApiAdmin();
    const ctx = await requestContext();
    const feedback = await loadTarget(id);

    await prisma.feedback.update({
      where: { id },
      data: { featured: false },
    });

    await writeAudit({
      action: 'FEEDBACK_UNFEATURED',
      actorId: admin.id,
      actorEmail: admin.email,
      targetType: 'feedback',
      targetId: feedback.id,
      ctx,
    });

    revalidatePath('/admin/feedback');
    revalidatePath('/');
    return { ok: true, message: 'Removed from the homepage.' };
  } catch (error) {
    return toActionError(error);
  }
}

export async function archiveFeedbackAction(id: string): Promise<ActionResult> {
  try {
    const { user: admin } = await requireApiAdmin();
    const ctx = await requestContext();
    const feedback = await loadTarget(id);

    await prisma.feedback.update({
      where: { id },
      data: { status: 'ARCHIVED', featured: false },
    });

    await writeAudit({
      action: 'FEEDBACK_ARCHIVED',
      actorId: admin.id,
      actorEmail: admin.email,
      targetType: 'feedback',
      targetId: feedback.id,
      ctx,
    });

    revalidatePath('/admin/feedback');
    revalidatePath('/');
    return { ok: true, message: 'Archived.' };
  } catch (error) {
    return toActionError(error);
  }
}
