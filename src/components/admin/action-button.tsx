'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button, type ButtonProps } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

interface ActionButtonProps extends Omit<ButtonProps, 'onClick' | 'formAction'> {
  action: () => Promise<ActionResult>;
  /** When set, the action runs only after the admin confirms in a dialog. */
  confirm?: { title: string; description: string; confirmLabel?: string; destructive?: boolean };
}

/**
 * Runs a server action from an admin screen and reports the outcome.
 *
 * The action itself re-checks the caller's admin role on the server — this
 * component is only about feedback, never about permission.
 */
export function ActionButton({ action, confirm, children, ...props }: ActionButtonProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);

  function run() {
    setOpen(false);
    startTransition(async () => {
      try {
        const result = await action();
        if (result.ok) {
          toast.success(result.message ?? 'Done.');
          router.refresh();
        } else {
          toast.error(result.error);
        }
      } catch {
        toast.error('That did not go through. Please try again.');
      }
    });
  }

  return (
    <>
      <Button
        {...props}
        loading={pending}
        onClick={() => (confirm ? setOpen(true) : run())}
      >
        {children}
      </Button>

      {confirm && (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{confirm.title}</DialogTitle>
              <DialogDescription>{confirm.description}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button variant={confirm.destructive ? 'destructive' : 'default'} onClick={run}>
                {confirm.confirmLabel ?? 'Confirm'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
