import Image from 'next/image';
import Link from 'next/link';
import { BEATS, CTA, NOTE_PAGES } from '@/components/home/cinematic/story-config';

const HERO_PAGE = NOTE_PAGES.find((n) => n.hero) ?? NOTE_PAGES[0];

/**
 * The same story without the camera: for people who ask for reduced motion,
 * and for browsers that cannot run WebGL. Same words, same order, same
 * ending — only nothing moves.
 */
export function StaticStory({ className = '' }: { className?: string }) {
  const beats = BEATS.filter((b) => b.id !== 'final');
  const finale = BEATS.find((b) => b.id === 'final');

  return (
    <section
      aria-label="Cookie Notes"
      className={`bg-[#0d0b09] px-6 py-20 text-[#f3ebdf] sm:py-28 ${className}`}
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-16 sm:gap-24">
        {beats.map((beat, bi) => (
          <div key={beat.id} className="flex flex-col gap-4">
            {beat.lines.map((line, li) => {
              const Tag = bi === 0 && li === 0 ? 'h1' : 'p';
              const base =
                line.tone === 'headline'
                  ? 'text-balance text-4xl font-semibold leading-[1.08] tracking-tight sm:text-5xl'
                  : line.tone === 'list'
                    ? 'text-2xl font-semibold tracking-tight sm:text-3xl'
                    : 'whitespace-pre-line text-balance text-lg leading-snug text-[#cdbfaa] sm:text-xl';
              return (
                <Tag key={line.text} className={base}>
                  {line.text}
                </Tag>
              );
            })}

            {beat.id === 'cookie-notes' && (
              <figure className="mt-6">
                <Image
                  src={HERO_PAGE.src}
                  alt={`A page of real Cookie Notes: ${HERO_PAGE.title}`}
                  width={664}
                  height={858}
                  sizes="(min-width: 640px) 384px, 80vw"
                  className="h-auto w-full max-w-sm rounded-lg border border-[#2b231b]"
                />
              </figure>
            )}
          </div>
        ))}

        {finale && (
          <div className="flex flex-col items-start gap-4">
            <h2 className="text-6xl font-semibold leading-none tracking-tight sm:text-7xl">
              {finale.lines[0].text}
            </h2>
            <p className="font-letter text-2xl text-[#d6a05a] sm:text-3xl">
              {finale.lines[1].text}
            </p>
            <Link
              href={CTA.href}
              className="mt-4 inline-flex h-12 items-center justify-center rounded-full bg-[#d6a05a] px-8 text-base font-medium text-[#1a1208] transition-colors hover:bg-[#e2b06b]"
            >
              {CTA.label}
            </Link>
          </div>
        )}
      </div>
    </section>
  );
}
