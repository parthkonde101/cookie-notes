'use client';

import { Button } from '@/components/ui/button';
import { useAuthModal } from '@/components/auth/auth-modal';

/** Opens the same registration modal the header's "Create account" uses. */
export function GetStartedButton() {
  const { requestAuth } = useAuthModal();

  return (
    <Button size="lg" onClick={() => requestAuth('/catalog', { mode: 'register' })}>
      Get started
    </Button>
  );
}
