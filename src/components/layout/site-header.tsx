'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronDown, Cookie, LogOut, Shield, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuthModal } from '@/components/auth/auth-modal';
import { cn, initials } from '@/lib/utils';

export interface HeaderUser {
  name: string;
  email: string;
  role: 'STUDENT' | 'ADMIN';
}

/**
 * One header for the whole public product. The catalogue is the destination, so
 * there is nothing else to navigate to — signed out you get sign-in controls,
 * signed in you get an account menu, and the page under it never changes.
 */
export function SiteHeader({ user, liveUsers }: { user: HeaderUser | null; liveUsers?: number }) {
  const router = useRouter();
  const { requestAuth } = useAuthModal();
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  async function signOut() {
    setSigningOut(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      setMenuOpen(false);
      setSigningOut(false);
      router.replace('/');
      router.refresh();
    }
  }

  const others = Math.max(0, (liveUsers ?? 0) - 1);

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-3 px-4 sm:px-6">
        {/* The actions on the right are fixed-width, so the brand is what gives
            way on a narrow phone — the mark stays, the wordmark truncates. That
            is what keeps the header from pushing the page sideways at 320px. */}
        <Link href="/" className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/12 text-primary ring-1 ring-inset ring-primary/25">
            <Cookie className="size-4" />
          </span>
          <span className="truncate text-[0.95rem] font-semibold tracking-tight">Cookie Notes</span>
        </Link>

        <div className="flex-1" />

        {user && others > 0 && (
          <span className="mr-1 hidden items-center gap-2 rounded-full border border-border px-3 py-1 text-xs text-muted-foreground sm:inline-flex">
            <span className="relative flex size-1.5">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-70" />
              <span className="relative inline-flex size-1.5 rounded-full bg-success" />
            </span>
            <span className="tabular-nums text-foreground">{others}</span> studying now
          </span>
        )}

        {user ? (
          <div className="relative shrink-0" ref={menuRef}>
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((value) => !value)}
              className={cn(
                'flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-sm transition-colors',
                menuOpen ? 'border-primary/40 bg-secondary' : 'hover:bg-secondary',
              )}
            >
              <span className="flex size-6 items-center justify-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary">
                {initials(user.name)}
              </span>
              <span className="hidden max-w-[9rem] truncate sm:inline">{user.name}</span>
              <ChevronDown className="size-3.5 text-muted-foreground" />
            </button>

            {menuOpen && (
              <div
                role="menu"
                className="absolute right-0 top-[calc(100%+0.4rem)] w-60 overflow-hidden rounded-md border border-border bg-popover shadow-xl animate-fade-in"
              >
                <div className="border-b border-border px-3 py-2.5">
                  <p className="truncate text-sm font-medium">{user.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{user.email}</p>
                </div>

                {user.role === 'ADMIN' && (
                  <Link
                    href="/admin"
                    role="menuitem"
                    className="flex items-center gap-2.5 px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                  >
                    <Shield className="size-4" />
                    Admin
                  </Link>
                )}

                <Link
                  href="/account"
                  role="menuitem"
                  className="flex items-center gap-2.5 px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                >
                  <UserRound className="size-4" />
                  Account
                </Link>

                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void signOut()}
                  disabled={signingOut}
                  className="flex w-full items-center gap-2.5 border-t border-border px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-60"
                >
                  <LogOut className="size-4" />
                  {signingOut ? 'Signing out…' : 'Sign out'}
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => requestAuth('/', { mode: 'signin' })}>
              Sign in
            </Button>
            <Button size="sm" onClick={() => requestAuth('/', { mode: 'register' })}>
              <span className="sm:hidden">Sign up</span>
              <span className="hidden sm:inline">Create account</span>
            </Button>
          </div>
        )}
      </div>
    </header>
  );
}
