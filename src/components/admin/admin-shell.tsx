'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  BookOpen,
  ClipboardList,
  Cookie,
  FileText,
  LayoutDashboard,
  LogOut,
  Menu,
  MonitorSmartphone,
  TrendingUp,
  Users,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn, initials } from '@/lib/utils';

/**
 * Admin chrome.
 *
 * Six destinations, no duplicates: access lives inside Users and content
 * management lives inside Notes, so nothing here is a shortcut to something you
 * can also reach elsewhere.
 */
interface AdminNavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  exact?: boolean;
}

const NAV: AdminNavItem[] = [
  { href: '/admin', label: 'Overview', icon: LayoutDashboard, exact: true },
  { href: '/admin/users', label: 'Users', icon: Users },
  { href: '/admin/notes', label: 'Notes', icon: FileText },
  { href: '/admin/analytics', label: 'Analytics', icon: TrendingUp },
  { href: '/admin/sessions', label: 'Sessions', icon: MonitorSmartphone },
  { href: '/admin/audit', label: 'Audit', icon: ClipboardList },
];

export function AdminShell({
  user,
  children,
}: {
  user: { name: string; email: string };
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  async function signOut() {
    setSigningOut(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      router.replace('/');
      router.refresh();
    }
  }

  const sidebar = (
    <div className="flex h-full flex-col gap-1 px-3 py-4">
      <Link href="/admin" className="mb-5 flex items-center gap-2.5 px-2">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/12 text-primary ring-1 ring-inset ring-primary/25">
          <Cookie className="size-4" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold tracking-tight">Cookie Notes</span>
          <span className="block text-[11px] font-medium uppercase tracking-wider text-primary">
            Admin
          </span>
        </span>
      </Link>

      <nav className="flex-1 space-y-0.5">
        {NAV.map((item) => {
          const active = item.exact
            ? pathname === item.href
            : pathname === item.href || pathname.startsWith(`${item.href}/`);
          const Icon = item.icon;

          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                active
                  ? 'bg-primary/12 font-medium text-primary'
                  : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
              )}
            >
              <Icon className="size-4 shrink-0" />
              <span className="truncate">{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="mt-2 space-y-1 border-t border-border pt-3">
        <Link
          href="/"
          className="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <BookOpen className="size-4 shrink-0" />
          View catalogue
        </Link>

        <div className="flex items-center gap-3 rounded-md px-2 py-2">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
            {initials(user.name)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{user.name}</span>
            <span className="block truncate text-xs text-muted-foreground">{user.email}</span>
          </span>
        </div>

        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start text-muted-foreground"
          onClick={() => void signOut()}
          loading={signingOut}
        >
          <LogOut className="size-4" />
          Sign out
        </Button>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-dvh">
      <aside className="fixed inset-y-0 left-0 hidden w-60 border-r border-border bg-card/40 lg:block">
        {sidebar}
      </aside>

      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            className="absolute inset-0 bg-black/70"
            onClick={() => setOpen(false)}
            aria-label="Close navigation"
          />
          <aside className="absolute inset-y-0 left-0 w-64 border-r border-border bg-card shadow-xl animate-fade-in">
            <button
              className="absolute right-3 top-4 rounded-md p-1 text-muted-foreground hover:text-foreground"
              onClick={() => setOpen(false)}
              aria-label="Close navigation"
            >
              <X className="size-4" />
            </button>
            {sidebar}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col lg:pl-60">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background/85 px-4 backdrop-blur lg:hidden">
          <button
            className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            onClick={() => setOpen(true)}
            aria-label="Open navigation"
          >
            <Menu className="size-5" />
          </button>
          <Link href="/admin" className="flex items-center gap-2">
            <Cookie className="size-4 text-primary" />
            <span className="text-sm font-semibold">Cookie Notes</span>
            <span className="text-[11px] uppercase tracking-wider text-primary">Admin</span>
          </Link>
        </header>

        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
