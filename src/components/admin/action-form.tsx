'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/feedback';
import { cn } from '@/lib/utils';

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

interface ActionFormProps {
  action: (formData: FormData) => Promise<ActionResult>;
  children: React.ReactNode;
  submitLabel: string;
  className?: string;
  /** Clear the form on success — right for "add" forms, wrong for "edit" ones. */
  resetOnSuccess?: boolean;
  onSuccess?: () => void;
  footer?: React.ReactNode;
}

/** Wraps a server action in a form with inline error reporting and a toast. */
export function ActionForm({
  action,
  children,
  submitLabel,
  className,
  resetOnSuccess = false,
  onSuccess,
  footer,
}: ActionFormProps) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setError(null);

    startTransition(async () => {
      try {
        const result = await action(formData);
        if (result.ok) {
          toast.success(result.message ?? 'Saved.');
          if (resetOnSuccess) formRef.current?.reset();
          onSuccess?.();
          router.refresh();
        } else {
          setError(result.error);
        }
      } catch {
        setError('That did not go through. Please try again.');
      }
    });
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} className={cn('space-y-4', className)}>
      {error && <Alert variant="error">{error}</Alert>}
      {children}
      <div className="flex items-center gap-2">
        <Button type="submit" loading={pending}>
          {submitLabel}
        </Button>
        {footer}
      </div>
    </form>
  );
}

/** Small labelled field wrapper used across the admin forms. */
export function Field({
  label,
  htmlFor,
  hint,
  children,
  className,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={htmlFor} className="text-sm font-medium text-foreground/90">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
