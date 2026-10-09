'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ChevronDown, Cookie, LogOut, Menu, Shield, UserRound, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuthModal } from '@/components/auth/auth-modal';
import { cn, initials } from '@/lib/utils';

export interface HeaderUser {
  name: string;
  email: string;
  role: 'STUDENT' | 'ADMIN';
}

const NAV_LINKS = [
  { href: '/home', label: 'Home' },
  { href: '/catalog', label: 'Catalog' },
  { href: '/about', label: 'About' },
  { href: '/feedback', label: 'Feedback' },
] as const;

/**
 * Whether a nav link matches what's currently on screen.
 *
 * Everything but the root URL is a literal pathname match. The root URL is
 * special: `/` itself shows Home to a guest and the catalogue to a signed-in
 * visitor (see the root page), so the nav should highlight whichever of
 * "Home" or "Catalog" actually matches what that visitor is looking at,
 * even though the address bar just says `/`.
 */
function isNavLinkActive(href: string, pathname: string, signedIn: boolean): boolean {
  if (pathname === href) return true;
  if (pathname === '/') {
    if (href === '/home') return !signedIn;
    if (href === '/catalog') return signedIn;
  }
  return false;
}

/**
 * One header for the whole public product. Signed out you get sign-in
 * controls, signed in you get an account menu — the nav in between is the
 * same set of destinations either way, since none of them require an account.
 */
export function SiteHeader({ user, liveUsers }: { user: HeaderUser | null; liveUsers?: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const { requestAuth } = useAuthModal();
  const [menuOpen, setMenuOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen && !navOpen) return;

    const onPointerDown = (event: MouseEvent) => {
      if (menuOpen && !menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
      if (navOpen && !navRef.current?.contains(event.target as Node)) setNavOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        setNavOpen(false);
      }
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen, navOpen]);

  // Collapse the mobile nav automatically once a link has taken us somewhere.
  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

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

        <nav aria-label="Primary" className="hidden shrink-0 items-center gap-1 md:flex">
          {NAV_LINKS.map((link) => {
            const active = isNavLinkActive(link.href, pathname, Boolean(user));
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                  active
                    ? 'text-foreground'
                    : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                )}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>

        <div className="flex-1" />

        <div className="relative shrink-0 md:hidden" ref={navRef}>
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={navOpen}
            aria-label={navOpen ? 'Close menu' : 'Open menu'}
            onClick={() => setNavOpen((value) => !value)}
            className="flex size-8 items-center justify-center rounded-md border border-border transition-colors hover:bg-secondary"
          >
            {navOpen ? <X className="size-4" /> : <Menu className="size-4" />}
          </button>

          {navOpen && (
            <div
              role="menu"
              className="absolute left-0 top-[calc(100%+0.4rem)] w-48 overflow-hidden rounded-md border border-border bg-popover py-1 shadow-xl animate-fade-in"
            >
              {NAV_LINKS.map((link) => {
                const active = isNavLinkActive(link.href, pathname, Boolean(user));
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    role="menuitem"
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'block px-3.5 py-2 text-sm transition-colors',
                      active
                        ? 'font-medium text-foreground'
                        : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                    )}
                  >
                    {link.label}
                  </Link>
                );
              })}
            </div>
          )}
        </div>

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
