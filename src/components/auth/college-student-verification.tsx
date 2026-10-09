'use client';

import { useState } from 'react';
import { CollegeEmailForm } from '@/components/auth/college-email-form';
import { CurrentEmailForm } from '@/components/auth/current-email-form';

/**
 * The verification screen for a student whose address is already on the college
 * domain.
 *
 * Most of them just need to prove they can read the mailbox they have, so that
 * is where they start. But some made a mistake when they signed up — a mistyped
 * address that happens to end in the college domain — and for them verifying
 * "the address on the account" is the wrong thing to do. So there is a way to
 * move to the correct address instead.
 *
 * Moving is not a new mechanism: it is the existing address-change flow, which
 * sends a code to the NEW address and changes the account only once that code
 * comes back. The two paths are separate on the server and neither can spend the
 * other's code.
 *
 * A student who already proposed a different address starts in the change flow,
 * at the code step, so closing the tab does not lose their place.
 */
export function CollegeStudentVerification({
  email,
  initialSentAt,
  initialPending,
  nextHref = '/',
}: {
  email: string;
  initialSentAt: string | null;
  initialPending: string | null;
  nextHref?: string;
}) {
  const [mode, setMode] = useState<'current' | 'change'>(initialPending ? 'change' : 'current');

  if (mode === 'current') {
    return (
      <CurrentEmailForm
        email={email}
        initialSentAt={initialSentAt}
        nextHref={nextHref}
        onUseDifferent={() => setMode('change')}
      />
    );
  }

  return (
    <CollegeEmailForm
      initialPending={initialPending}
      nextHref={nextHref}
      description="Signed up with the wrong address? Enter your correct MIT-WPU email and we will send a code to it. Your account changes only once you confirm that code."
      currentEmail={email}
      onUseCurrent={() => setMode('current')}
    />
  );
}
