import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { Errors, toErrorResponse } from '@/lib/errors';
import { contextFromHeaders } from '@/lib/request';
import { requireApiAdmin } from '@/lib/auth/guards';
import { storage } from '@/lib/storage/index';
import { recordEvent } from '@/lib/analytics/events';
import { writeAudit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Removes a previous-year paper and the file behind it. */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user: admin } = await requireApiAdmin();
    const ctx = contextFromHeaders(request.headers);

    const pyq = await prisma.pyq.findUnique({
      where: { id },
      select: {
        id: true,
        year: true,
        storageKey: true,
        subjectId: true,
        subject: { select: { name: true } },
      },
    });
    if (!pyq) throw Errors.notFound('That paper does not exist.');

    await prisma.pyq.delete({ where: { id: pyq.id } });

    // The row is the source of truth; a leftover object is tidied up after it,
    // and a failure here must not make the delete look unsuccessful.
    await storage().delete(pyq.storageKey).catch(() => undefined);

    await writeAudit({
      action: 'PYQ_DELETED',
      actorId: admin.id,
      actorEmail: admin.email,
      targetType: 'pyq',
      targetId: pyq.id,
      targetLabel: `${pyq.subject.name} — ${pyq.year}`,
      metadata: { year: pyq.year },
      ctx,
    });
    await recordEvent({
      type: 'PYQ_DELETED',
      userId: admin.id,
      subjectId: pyq.subjectId,
      ctx,
      metadata: { pyqId: pyq.id, year: pyq.year },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
