import Link from 'next/link';
import { GetStartedButton } from '@/components/home/get-started-button';

/** The first thing a signed-out visitor sees at `/`. */
export function HeroSection() {
  return (
    <section className="relative border-b border-border">
      <div aria-hidden className="hero-glow pointer-events-none absolute inset-x-0 top-0 h-64" />
      <div className="relative mx-auto flex w-full max-w-3xl flex-col items-center px-4 py-16 text-center sm:px-6 sm:py-24">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">Cookie Notes</h1>
        <p className="mt-3 text-lg text-muted-foreground sm:text-xl">Baked for exams.</p>
        <p className="mt-6 max-w-xl text-balance text-sm text-muted-foreground sm:text-base">
          Notes for every MIT-WPU B.Tech and Polytechnic subject, organised by semester and ready
          the moment you need them.
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <GetStartedButton />
          <Link
            href="/catalog"
            className="inline-flex h-9 items-center justify-center rounded-md px-4 text-sm font-medium text-foreground underline-offset-4 hover:underline"
          >
            Browse the catalogue
          </Link>
        </div>
      </div>
    </section>
  );
}
