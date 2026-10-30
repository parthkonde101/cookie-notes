'use client';

import { Input } from '@/components/ui/input';
import { ActionForm, Field } from '@/components/admin/action-form';
import { createBundleAction } from '@/app/admin/_actions/commerce';

/** Starts a bundle as a draft; the notes, subjects and cover are chosen on the next screen. */
export function NewBundleForm() {
  return (
    <ActionForm action={createBundleAction} submitLabel="Create bundle">
      <Field label="Title" htmlFor="title">
        <Input id="title" name="title" required maxLength={120} placeholder="Semester 3 exam pack" />
      </Field>
      <Field label="Bundle price (₹)" htmlFor="price" hint="You can change it any time; past orders keep what was charged.">
        <Input id="price" name="price" inputMode="decimal" autoComplete="off" required placeholder="499" />
      </Field>
    </ActionForm>
  );
}
