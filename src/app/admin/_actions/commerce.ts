'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { Errors, toActionError } from '@/lib/errors';
import { requireApiAdmin } from '@/lib/auth/guards';
import { requestContext } from '@/lib/request';
import { writeAudit } from '@/lib/audit';
import { formatInr, parsePriceInput } from '@/lib/commerce/money';
import { createBundle, deleteBundle, saveBundle, setNoteAccess } from '@/lib/commerce/admin';
import { requestRefund, retryRefund } from '@/lib/commerce/refunds';
import { reconcileOrder } from '@/lib/commerce/orders';
import type { ActionResult } from '@/app/admin/_actions/users';

/**
 * Admin actions for selling: pricing a note, composing bundles, and refunds.
 *
 * Every action starts with `requireApiAdmin()` — the pages are admin-only too, but a
 * server action is a public endpoint, so the role is re-read from the database here, not
 * trusted from where the call came from. Every change is validated on the server whatever
 * the form did, and every one is written to the audit log.
 */

function text(form: FormData, key: string): string {
  const raw = form.get(key);
  return typeof raw === 'string' ? raw.trim() : '';
}

function flag(form: FormData, key: string): boolean {
  const raw = form.get(key);
  return raw === 'on' || raw === 'true' || raw === '1';
}

function list(form: FormData, key: string): string[] {
  return [...new Set(form.getAll(key).filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim()))];
}

// ---------------------------------------------------------------------------
// Pricing one note
// ---------------------------------------------------------------------------

export type { NoteAccessMode } from '@/lib/commerce/admin';

/** Sets how one note is offered: free, restricted, or for sale at a price. Rules: `lib/commerce/admin.ts`. */
export async function setNoteAccessAction(noteId: string, form: FormData): Promise<ActionResult> {
  try {
    const { user: admin } = await requireApiAdmin();
    const result = await setNoteAccess({
      noteId,
      mode: text(form, 'mode'),
      priceRaw: text(form, 'price'),
      actor: { id: admin.id, email: admin.email },
      ctx: await requestContext(),
    });
    revalidatePath('/admin/notes');
    revalidatePath(`/admin/notes/${noteId}`);
    revalidatePath('/admin/bundles');
    revalidatePath('/subject', 'layout');
    revalidatePath('/');
    return { ok: true, message: result.message };
  } catch (error) {
    return toActionError(error);
  }
}

// ---------------------------------------------------------------------------
// Bundles
// ---------------------------------------------------------------------------

/** Creates an empty, inactive bundle with a title and a price, then opens it for editing. */
export async function createBundleAction(form: FormData): Promise<ActionResult> {
  let createdId: string;
  try {
    const { user: admin } = await requireApiAdmin();
    const created = await createBundle({
      title: text(form, 'title'),
      priceRaw: text(form, 'price'),
      actor: { id: admin.id, email: admin.email },
      ctx: await requestContext(),
    });
    createdId = created.id;
    revalidatePath('/admin/bundles');
  } catch (error) {
    return toActionError(error);
  }
  redirect(`/admin/bundles/${createdId}`);
}

/** Saves a bundle: its text, price, notes, promoted subjects, cover and visibility. */
export async function saveBundleAction(bundleId: string, form: FormData): Promise<ActionResult> {
  try {
    const { user: admin } = await requireApiAdmin();
    const result = await saveBundle({
      bundleId,
      title: text(form, 'title'),
      description: text(form, 'description'),
      priceRaw: text(form, 'price'),
      position: text(form, 'position'),
      isActive: flag(form, 'isActive'),
      isFeatured: flag(form, 'isFeatured'),
      noteIds: list(form, 'noteIds'),
      subjectIds: list(form, 'subjectIds'),
      coverSubjectId: text(form, 'coverSubjectId') || null,
      actor: { id: admin.id, email: admin.email },
      ctx: await requestContext(),
    });
    revalidatePath('/admin/bundles');
    revalidatePath(`/admin/bundles/${bundleId}`);
    revalidatePath('/subject', 'layout');
    return { ok: true, message: result.message };
  } catch (error) {
    return toActionError(error);
  }
}

/** Deletes a bundle that nobody has bought; a bundle with sales can only be deactivated. */
export async function deleteBundleAction(bundleId: string): Promise<ActionResult> {
  try {
    const { user: admin } = await requireApiAdmin();
    await deleteBundle({ bundleId, actor: { id: admin.id, email: admin.email }, ctx: await requestContext() });
    revalidatePath('/admin/bundles');
  } catch (error) {
    return toActionError(error);
  }
  redirect('/admin/bundles');
}

// ---------------------------------------------------------------------------
// Refunds and order maintenance
// ---------------------------------------------------------------------------

/**
 * Refunds what is left of an order, through the gateway. The confirmation is in the
 * button's dialog; nothing here changes an order's status — see `requestRefund`.
 */
export async function refundOrderAction(orderId: string, form?: FormData): Promise<ActionResult> {
  try {
    const { user: admin } = await requireApiAdmin();
    const ctx = await requestContext();

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, amountMinor: true, refundedMinor: true, customerEmail: true },
    });
    if (!order) throw Errors.notFound('That order no longer exists.');

    let amountMinor: number | undefined;
    const raw = form ? text(form, 'amount') : '';
    if (raw) {
      const parsed = parsePriceInput(raw);
      if (!parsed.ok) throw Errors.validation(parsed.error);
      amountMinor = parsed.minor;
    }
    const reason = form ? text(form, 'reason') : '';

    const result = await requestRefund({ orderId, adminId: admin.id, amountMinor, reason: reason || undefined });

    await writeAudit({
      action: 'REFUND_INITIATED',
      actorId: admin.id,
      actorEmail: admin.email,
      targetType: 'order',
      targetId: orderId,
      targetLabel: order.customerEmail,
      metadata: { refundId: result.refundId, amountMinor: result.amountMinor, status: result.status, reason: reason || null },
      ctx,
    });

    revalidatePath(`/admin/sales/orders/${orderId}`);
    revalidatePath('/admin/sales');
    return {
      ok: true,
      message:
        result.status === 'PROCESSED'
          ? `Refunded ${formatInr(result.amountMinor)}.`
          : `Refund of ${formatInr(result.amountMinor)} requested; the gateway is still processing it.`,
    };
  } catch (error) {
    return toActionError(error);
  }
}

export async function retryRefundAction(refundId: string): Promise<ActionResult> {
  try {
    await requireApiAdmin();
    const result = await retryRefund(refundId);
    const refund = await prisma.refund.findUnique({ where: { id: refundId }, select: { orderId: true } });
    if (refund) revalidatePath(`/admin/sales/orders/${refund.orderId}`);
    return { ok: true, message: result.status === 'PROCESSED' ? 'Refund completed.' : 'Refund sent; waiting for the gateway.' };
  } catch (error) {
    return toActionError(error);
  }
}

/** Asks the gateway about every payment on an order and applies what it says. */
export async function recheckOrderAction(orderId: string): Promise<ActionResult> {
  try {
    await requireApiAdmin();
    const result = await reconcileOrder(orderId);
    revalidatePath(`/admin/sales/orders/${orderId}`);
    revalidatePath('/admin/sales');
    return { ok: true, message: result ? `Checked with the gateway: order is ${result.orderStatus.toLowerCase().replace('_', ' ')}.` : 'Nothing to check for this order.' };
  } catch (error) {
    return toActionError(error);
  }
}
