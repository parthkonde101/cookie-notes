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

interface VerificationGateState {
  /**
   * Ask permission to open `href`.
   *
   * Returns true when the student may proceed and the caller should navigate.
   * Returns false when the dialog has been raised instead — the caller must not
   * navigate.
   */
  allowNoteOpen: (href: string) => boolean;
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
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  const allowNoteOpen = useCallback(
    (href: string) => {
      if (!mustVerify) return true;
      setPendingHref(href);
      return false;
    },
    [mustVerify],
  );

  const value = useMemo(() => ({ allowNoteOpen }), [allowNoteOpen]);

  return (
    <VerificationGateContext.Provider value={value}>
      {children}

      <Dialog open={pendingHref !== null} onOpenChange={(open) => !open && setPendingHref(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <div className="mb-1 flex size-9 items-center justify-center rounded-full bg-warning/12 text-warning">
              <MailWarning className="size-4" aria-hidden />
            </div>
            <DialogTitle>Verify your email</DialogTitle>
            <DialogDescription>
              Verify your MIT-WPU email address to open notes.
            </DialogDescription>
          </DialogHeader>

          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingHref(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                // Carry the note along so verifying lands back on it rather
                // than on the catalogue.
                const next = pendingHref;
                setPendingHref(null);
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
