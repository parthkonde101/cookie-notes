'use client';

import * as React from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

type PasswordInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>;

/**
 * A password field with a show/hide toggle.
 *
 * The toggle is a real button: it is reachable by keyboard, announces what it
 * will do ("Show password" / "Hide password") and its pressed state, and never
 * submits the form. Pressing it with the mouse keeps focus — and the caret — in
 * the field, so revealing a password mid-typing does not interrupt it. The
 * field goes back to hidden whenever it is disabled (for example while a form
 * is being submitted), so a password is not left on screen.
 *
 * The browser's own reveal control (Edge) is switched off so there is only ever
 * one eye.
 */
const PasswordInput = React.forwardRef<HTMLInputElement, PasswordInputProps>(
  ({ className, disabled, ...props }, ref) => {
    const [visible, setVisible] = React.useState(false);
    const shown = visible && !disabled;

    return (
      <div className="relative w-full">
        <Input
          ref={ref}
          type={shown ? 'text' : 'password'}
          disabled={disabled}
          // Keep a revealed password from being "corrected" or remembered as text.
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className={cn('pr-10 [&::-ms-clear]:hidden [&::-ms-reveal]:hidden', className)}
          {...props}
        />
        <button
          type="button"
          disabled={disabled}
          aria-label={shown ? 'Hide password' : 'Show password'}
          aria-pressed={shown}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setVisible((value) => !value)}
          className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-md text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50"
        >
          {shown ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
        </button>
      </div>
    );
  },
);
PasswordInput.displayName = 'PasswordInput';

export { PasswordInput };
