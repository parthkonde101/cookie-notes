import Link from 'next/link';
import { LogoMark } from '@/components/brand/logo';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-dvh flex-col">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-[radial-gradient(55%_100%_at_50%_0%,hsl(var(--primary)/0.14),transparent)]"
      />

      <header className="relative z-10 px-6 py-6">
        <Link href="/" className="inline-flex items-center gap-2">
          <LogoMark className="size-9 text-primary" />
          <span className="text-sm font-semibold tracking-tight">Cookie Notes</span>
        </Link>
      </header>

      <main className="relative z-10 flex flex-1 items-start justify-center px-4 pb-16 pt-4 sm:items-center sm:pt-0">
        <div className="w-full max-w-md animate-fade-in">{children}</div>
      </main>
    </div>
  );
}
