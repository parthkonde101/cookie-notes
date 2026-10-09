'use client';

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MailWarning } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * The catalogue-side half of the email gate.
 *
 * This is a courtesy, not a control. The real gate is `needsEmailMigration` in
 * `lib/auth/guards`, which the reader pages and every note API route already
 * run — an unverified student who types a note URL, refreshes one, or calls the
 * view-token endpoint directly is refused there, whatever this component does.
 * What this adds is that clicking a card explains itself instead of bouncing
 * the student to another screen without a word.
 *
 * `mustVerify` is resolved on the server, from the same helper the guards use,
 * so the dialog and the gate can never disagree about who is unverified.
 */

/** What the student was trying to do, so the dialog can say so. */
export type GatedAction = 'notes' | 'feedback';

const ACTION_COPY: Record<GatedAction, string> = {
  notes: 'Verify your MIT-WPU email address to open notes.',
  feedback: 'Verify your MIT-WPU email address to write feedback.',
};

interface VerificationGateState {
  /**
   * Ask permission to open `href`.
   *
   * Returns true when the student may proceed and the caller should navigate.
   * Returns false when the dialog has been raised instead — the caller must not
   * navigate. `action` only changes the wording; it never changes who is let in.
   */
  allowNoteOpen: (href: string, action?: GatedAction) => boolean;
}

const VerificationGateContext = createContext<VerificationGateState>({
  // Outside the provider nothing is gated: the guards still decide. This keeps
  // a card usable anywhere it is rendered rather than throwing.
  allowNoteOpen: () => true,
});

export function useVerificationGate(): VerificationGateState {
  return useContext(VerificationGateContext);
}

export function VerificationGateProvider({
  mustVerify,
  verifyPath,
  children,
}: {
  mustVerify: boolean;
  /** Where "Verify email" goes — the existing flow, never a new one. */
  verifyPath: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<{ href: string; action: GatedAction } | null>(null);

  const allowNoteOpen = useCallback(
    (href: string, action: GatedAction = 'notes') => {
      if (!mustVerify) return true;
      setPending({ href, action });
      return false;
    },
    [mustVerify],
  );

  const value = useMemo(() => ({ allowNoteOpen }), [allowNoteOpen]);

  return (
    <VerificationGateContext.Provider value={value}>
      {children}

      <Dialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <div className="mb-1 flex size-9 items-center justify-center rounded-full bg-warning/12 text-warning">
              <MailWarning className="size-4" aria-hidden />
            </div>
            <DialogTitle>Verify your email</DialogTitle>
            <DialogDescription>{ACTION_COPY[pending?.action ?? 'notes']}</DialogDescription>
          </DialogHeader>

          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                // Carry the destination along so verifying lands back on it
                // rather than on the catalogue.
                const next = pending?.href ?? null;
                setPending(null);
                router.push(
                  next && next !== '#'
                    ? `${verifyPath}?next=${encodeURIComponent(next)}`
                    : verifyPath,
                );
              }}
            >
              Verify email
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </VerificationGateContext.Provider>
  );
}
