import Link from 'next/link';
import { CoverImage } from '@/components/catalog/cover-image';
import { cn } from '@/lib/utils';

export interface NotebookCardProps {
  name: string;
  slug: string;
  /** Application URL for the uploaded cover, or null to draw a generated one. */
  cover: string | null;
  /** Nothing published yet — the notebook is shown but reads as not ready. */
  unavailable?: boolean;
  /** True for the first row, which should not be lazy-loaded. */
  priority?: boolean;
}

/**
 * A subject, as a notebook.
 *
 * The cover carries the personality, so it is the dominant element and
 * everything else is deliberately quiet: a spine down the binding edge and the
 * subject name. Deliberately nothing else — the course code is an
 * administrative label, not something a student picks a notebook by, so it
 * lives on the subject page and in the admin rather than on the shelf. The card
 * is a single link, which makes the whole notebook one keyboard-focusable
 * target rather than a card with a button buried inside it.
 *
 * Sizing is left entirely to the parent grid. The card sets no width of its
 * own — it fills its column and derives its height from a fixed cover aspect
 * ratio, so a row of notebooks lines up whatever the column count happens to be.
 */
export function NotebookCard({
  name,
  slug,
  cover,
  unavailable = false,
  priority = false,
}: NotebookCardProps) {
  return (
    <Link
      href={`/subject/${slug}`}
      aria-label={`${name} — open notebook`}
      className={cn(
        'group relative flex w-full min-w-0 flex-col overflow-hidden rounded-lg',
        'border border-border bg-card shadow-sm',
        'transition-[border-color,transform,box-shadow] duration-150',
        'hover:-translate-y-0.5 hover:border-primary/45 hover:shadow-lg',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        unavailable && 'opacity-70',
      )}
    >
      {/* Cover */}
      <div className="relative aspect-[3/4] w-full overflow-hidden bg-muted">
        {cover ? (
          <CoverImage
            src={cover}
            alt={`Cover of the ${name} notebook`}
            // Mirrors the grid below: roughly a fifth of a wide page, half of a
            // small one. Keeps the browser from fetching a desktop-sized image
            // for a phone.
            sizes="(max-width: 480px) 45vw, (max-width: 768px) 30vw, (max-width: 1280px) 22vw, 200px"
            priority={priority}
            fallback={<GeneratedCover name={name} />}
          />
        ) : (
          <GeneratedCover name={name} />
        )}

        {/* The binding: a narrow spine down the left edge, drawn over whatever
            the cover is, so every notebook reads as the same object. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-[10px] bg-gradient-to-r from-black/55 via-black/25 to-transparent"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-[10px] w-px bg-white/10"
        />

        {unavailable && (
          <span className="absolute right-2 top-2 rounded border border-border/80 bg-background/85 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground backdrop-blur">
            Coming soon
          </span>
        )}
      </div>

      {/* Label — the subject name, and nothing competing with it. Two lines are
          allowed so a long name is readable rather than cut off mid-word. */}
      <div className="flex min-w-0 flex-1 items-start border-t border-border px-3 py-2.5">
        <h3
          className="line-clamp-2 text-sm font-medium leading-snug transition-colors group-hover:text-primary"
          title={name}
        >
          {name}
        </h3>
      </div>
    </Link>
  );
}

/**
 * The cover for a subject that has not been given one.
 *
 * Drawn rather than illustrated: a warm ruled field with the subject's initials,
 * so an un-covered notebook still looks deliberate instead of like a broken
 * image. Two subjects with different names get different — but stable — tints.
 */
function GeneratedCover({ name }: { name: string }) {
  const hue = hueFor(name);
  const initials = name
    .split(/\s+/)
    .filter((word) => /[a-z0-9]/i.test(word))
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <div
      aria-hidden
      className="relative flex h-full w-full flex-col justify-between p-3"
      style={{
        backgroundColor: `hsl(${hue} 32% 16%)`,
        backgroundImage:
          'repeating-linear-gradient(to bottom, transparent 0 17px, hsl(0 0% 100% / 0.05) 17px 18px)',
      }}
    >
      <span
        className="self-end rounded-sm px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider"
        style={{ color: `hsl(${hue} 55% 78%)`, backgroundColor: 'hsl(0 0% 0% / 0.25)' }}
      >
        Notes
      </span>
      <span
        className="text-3xl font-semibold tracking-tight"
        style={{ color: `hsl(${hue} 60% 82%)` }}
      >
        {initials || '••'}
      </span>
    </div>
  );
}

/**
 * A stable hue per subject, kept in the warm half of the wheel so a generated
 * cover never fights the cookie-brown palette.
 */
function hueFor(name: string): number {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) % 100_000;
  }
  // 12°–58°: rust through amber. Never a cold or unrelated colour.
  return 12 + (hash % 47);
}
