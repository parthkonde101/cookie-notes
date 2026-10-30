'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/feedback';
import { ActionForm, Field } from '@/components/admin/action-form';
import { setNoteAccessAction, type NoteAccessMode } from '@/app/admin/_actions/commerce';
import { formatInr, minorToInputValue, parsePriceInput } from '@/lib/commerce/money';
import { cn } from '@/lib/utils';

interface Props {
  noteId: string;
  initialMode: NoteAccessMode;
  initialPriceMinor: number;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  /** OPEN_ACCESS_MODE is on: restricted notes are readable by any signed-in student. */
  previewOn: boolean;
  paymentsReady: boolean;
  sales: { orders: number; grossMinor: number };
}

const OPTIONS: { value: NoteAccessMode; title: string; body: (preview: boolean) => string }[] = [
  {
    value: 'FREE',
    title: 'Free',
    body: () => 'Any signed-in student can open it.',
  },
  {
    value: 'RESTRICTED',
    title: 'Restricted',
    body: (preview) =>
      preview
        ? 'Needs a grant — but open preview is on, so any signed-in student can still open it for now.'
        : 'Only students you grant access to can open it.',
  },
  {
    value: 'PAID',
    title: 'For sale',
    body: () => 'Students buy it once and keep it. Opens only for buyers and students you grant access to.',
  },
];

/**
 * How one note is offered, and what it costs.
 *
 * This is the only place a price is set. A price belongs to "For sale" and nowhere else, so
 * a free or restricted note cannot be bought because a number was left in a box. Saving
 * changes the price for FUTURE purchases only: what past buyers paid stays on their orders.
 */
export function NoteAccessForm({ noteId, initialMode, initialPriceMinor, status, previewOn, paymentsReady, sales }: Props) {
  const [mode, setMode] = useState<NoteAccessMode>(initialMode);
  const [price, setPrice] = useState(minorToInputValue(initialPriceMinor));

  const parsed = mode === 'PAID' ? parsePriceInput(price) : null;

  return (
    <ActionForm action={setNoteAccessAction.bind(null, noteId)} submitLabel="Save">
      <fieldset className="space-y-2">
        <legend className="sr-only">How this note is offered</legend>
        {OPTIONS.map((option) => (
          <label
            key={option.value}
            htmlFor={`mode-${option.value}`}
            className={cn(
              'flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors',
              mode === option.value ? 'border-primary/60 bg-primary/5' : 'border-border hover:bg-secondary/40',
            )}
          >
            <input
              id={`mode-${option.value}`}
              type="radio"
              name="mode"
              value={option.value}
              checked={mode === option.value}
              onChange={() => setMode(option.value)}
              className="mt-0.5 size-4 shrink-0 accent-primary"
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{option.title}</span>
              <span className="block text-xs text-muted-foreground">{option.body(previewOn)}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {mode === 'PAID' && (
        <div className="space-y-3">
          <Field
            label="Price (₹)"
            htmlFor="price"
            hint={
              parsed?.ok
                ? `Students will see ${formatInr(parsed.minor)}.`
                : 'Between ₹1 and ₹50,000. Paise are allowed (499.50).'
            }
          >
            <Input
              id="price"
              name="price"
              inputMode="decimal"
              autoComplete="off"
              placeholder="499"
              value={price}
              onChange={(event) => setPrice(event.target.value)}
              aria-invalid={parsed ? !parsed.ok : undefined}
              required
            />
          </Field>
          {parsed && !parsed.ok && price.trim() !== '' && <p className="text-xs text-destructive">{parsed.error}</p>}
          {status !== 'PUBLISHED' && (
            <Alert variant="warning" title="Not published yet">
              A note can only be bought while it is published. You can set the price now and publish it
              later.
            </Alert>
          )}
          {!paymentsReady && (
            <Alert variant="warning" title="Payments are not configured">
              The price is saved and shown, but nobody can buy until Razorpay is set up on the server.
            </Alert>
          )}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Changing the price affects future purchases only. Students who already bought this note keep it,
        and every past order keeps the amount that was charged.
        {sales.orders > 0 && (
          <>
            {' '}
            So far: {sales.orders} {sales.orders === 1 ? 'sale' : 'sales'}, {formatInr(sales.grossMinor)} gross (before refunds).
          </>
        )}
      </p>
    </ActionForm>
  );
}
