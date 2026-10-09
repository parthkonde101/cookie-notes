'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { BEATS, CTA, type Beat, type BeatLine } from '@/components/home/cinematic/story-config';
import { smoothstep, windowed } from '@/components/home/cinematic/math';
import type { StoryState } from '@/components/home/cinematic/story-state';

/**
 * Two shadows, not one: a tight, dark edge that separates each letter from
 * whatever is directly behind it, and a wide soft one that sinks the area
 * around the words. Together they read as depth, not as an outline.
 */
const SHADOW = '[text-shadow:0_1px_2px_rgba(0,0,0,0.8),0_6px_32px_rgba(0,0,0,0.85)]';

const TONE: Record<NonNullable<BeatLine['tone']>, string> = {
  headline: `text-balance text-[clamp(1.9rem,5.2vw,4.4rem)] font-semibold leading-[1.06] tracking-tight text-[#fbf5ea] ${SHADOW}`,
  support: `mt-4 whitespace-pre-line text-balance text-[clamp(1.1rem,1.8vw,1.55rem)] font-medium leading-snug text-[#eadfce] first:mt-0 ${SHADOW}`,
  list: `mt-3 text-[clamp(1.3rem,2.7vw,2.3rem)] font-semibold leading-tight tracking-tight text-[#fbf5ea] ${SHADOW}`,
  brand: `text-[clamp(2.8rem,8.5vw,7.5rem)] font-semibold leading-none tracking-tight text-[#fbf5ea] ${SHADOW}`,
  tagline: `mt-4 font-letter text-[clamp(1.3rem,2.6vw,2.2rem)] font-medium text-[#e3b06a] ${SHADOW}`,
};

/**
 * On a narrow, tall screen every beat sits across the top, centred, above the
 * scene (each shot carries its subject down the frame to make room). On a
 * wide one it sits where the camera leaves room for it.
 *
 * "Wide" is the same test the camera uses — an aspect ratio of 1.15 or more,
 * written out as 23/20 — so a tablet held upright gets the phone layout in
 * both places, not the phone camera with desktop text. The class names are
 * spelled out in full because Tailwind only generates what it can read.
 */
const PLACE: Record<Beat['place'], string> = {
  left: '[@media(min-aspect-ratio:23/20)]:items-center [@media(min-aspect-ratio:23/20)]:justify-start [@media(min-aspect-ratio:23/20)]:pl-[7vw] [@media(min-aspect-ratio:23/20)]:pt-0 [@media(min-aspect-ratio:23/20)]:text-left',
  right:
    '[@media(min-aspect-ratio:23/20)]:items-center [@media(min-aspect-ratio:23/20)]:justify-end [@media(min-aspect-ratio:23/20)]:pr-[7vw] [@media(min-aspect-ratio:23/20)]:pt-0 [@media(min-aspect-ratio:23/20)]:text-right',
  top: '[@media(min-aspect-ratio:23/20)]:items-start [@media(min-aspect-ratio:23/20)]:justify-center [@media(min-aspect-ratio:23/20)]:pt-[15vh] [@media(min-aspect-ratio:23/20)]:text-center',
  'upper-left':
    '[@media(min-aspect-ratio:23/20)]:items-start [@media(min-aspect-ratio:23/20)]:justify-start [@media(min-aspect-ratio:23/20)]:pl-[7vw] [@media(min-aspect-ratio:23/20)]:pt-[6vh] [@media(min-aspect-ratio:23/20)]:text-left',
  'upper-right':
    '[@media(min-aspect-ratio:23/20)]:items-start [@media(min-aspect-ratio:23/20)]:justify-end [@media(min-aspect-ratio:23/20)]:pr-[7vw] [@media(min-aspect-ratio:23/20)]:pt-[6vh] [@media(min-aspect-ratio:23/20)]:text-right',
};

/**
 * How a beat enters and leaves. It arrives from the side it sits on, rising a
 * little and resolving out of a soft blur; it leaves by drifting up and
 * softening again. Quiet, and always the same grammar.
 */
function beatMotion(beat: Beat, p: number, side: number) {
  const entering = smoothstep(beat.in[0], beat.in[1], p);
  const leaving = smoothstep(beat.out[0], beat.out[1], p);
  return {
    opacity: entering * (1 - leaving),
    x: (1 - entering) * 28 * side,
    y: (1 - entering) * 14 - leaving * 12,
    blur: (1 - entering) * 6 + leaving * 5,
  };
}

/** Which way a beat comes in from on a wide screen: the side it sits on. */
function sideOf(place: Beat['place']) {
  if (place === 'left' || place === 'upper-left') return -1;
  if (place === 'right' || place === 'upper-right') return 1;
  return 0;
}

function beatOpacity(beat: Beat, p: number) {
  return windowed(p, beat.in, beat.out);
}

function lineOpacity(line: BeatLine, p: number) {
  return line.at === undefined ? 1 : smoothstep(line.at, line.at + 0.02, p);
}

function ctaOpacity(p: number) {
  return smoothstep(CTA.at, CTA.at + 0.015, p);
}

/**
 * The words of the story. They are real DOM — selectable, translatable,
 * readable by a screen reader — whose opacity and offset are written straight
 * from the scroll each frame, with no React render in between.
 */
export function StoryOverlay({ story }: { story: StoryState }) {
  const beatEls = useRef<(HTMLDivElement | null)[]>([]);
  const lineEls = useRef<(HTMLElement | null)[][]>(BEATS.map(() => []));
  const hintEl = useRef<HTMLDivElement>(null);
  const ctaEl = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // The side-slide only makes sense where the words sit to one side.
    const wide = window.matchMedia('(min-aspect-ratio: 23/20)');

    const apply = (p: number) => {
      BEATS.forEach((beat, bi) => {
        const el = beatEls.current[bi];
        if (!el) return;
        const m = beatMotion(beat, p, wide.matches ? sideOf(beat.place) : 0);
        el.style.opacity = m.opacity.toFixed(3);
        el.style.transform = `translate3d(${m.x.toFixed(1)}px, ${m.y.toFixed(1)}px, 0)`;
        el.style.filter = m.blur > 0.05 ? `blur(${m.blur.toFixed(1)}px)` : 'none';

        beat.lines.forEach((line, li) => {
          const lineEl = lineEls.current[bi][li];
          if (!lineEl || line.at === undefined) return;
          const lo = lineOpacity(line, p);
          lineEl.style.opacity = lo.toFixed(3);
          lineEl.style.transform = `translate3d(0, ${((1 - lo) * 12).toFixed(1)}px, 0)`;
        });
      });

      if (hintEl.current) hintEl.current.style.opacity = (1 - smoothstep(0.0, 0.03, p)).toFixed(3);

      if (ctaEl.current) {
        const o = ctaOpacity(p);
        ctaEl.current.style.opacity = o.toFixed(3);
        ctaEl.current.style.transform = `translate3d(0, ${((1 - o) * 12).toFixed(1)}px, 0)`;
        // Invisible means unreachable: no focus, no clicks.
        ctaEl.current.style.visibility = o < 0.02 ? 'hidden' : 'visible';
      }
    };

    apply(story.smooth);
    story.subscribers.add(apply);
    return () => {
      story.subscribers.delete(apply);
    };
  }, [story]);

  return (
    <div className="pointer-events-none absolute inset-0">
      {BEATS.map((beat, bi) => (
        <div
          key={beat.id}
          className={`absolute inset-0 flex items-start justify-center px-6 pt-[5svh] text-center ${PLACE[beat.place]}`}
        >
          <div
            ref={(el) => {
              beatEls.current[bi] = el;
            }}
            // Server-rendered at progress 0, so the first line is already there.
            style={{
              opacity: beatOpacity(beat, 0),
              transform: `translate3d(0, ${(1 - beatOpacity(beat, 0)) * 14}px, 0)`,
              willChange: 'opacity, transform, filter',
            }}
            className="relative max-w-[36rem] md:max-w-[44rem]"
          >
            {/* A soft pool of darkness behind the words — no edge, no box. Its
                strength is set per beat, to suit what is behind it. */}
            <div
              aria-hidden
              style={{
                background: `radial-gradient(closest-side, rgba(8,6,4,${beat.scrim}) 0%, rgba(8,6,4,${(beat.scrim * 0.6).toFixed(2)}) 45%, rgba(8,6,4,0) 100%)`,
              }}
              className="absolute left-1/2 top-1/2 -z-10 h-[190%] w-[150%] -translate-x-1/2 -translate-y-1/2"
            />
            {beat.lines.map((line, li) => {
              const tone = line.tone ?? 'headline';
              const Tag =
                bi === 0 && li === 0 ? 'h1' : beat.id === 'final' && li === 0 ? 'h2' : 'p';
              return (
                <Tag
                  key={line.text}
                  ref={(el: HTMLElement | null) => {
                    lineEls.current[bi][li] = el;
                  }}
                  style={
                    line.at === undefined
                      ? undefined
                      : { opacity: lineOpacity(line, 0), willChange: 'opacity, transform' }
                  }
                  className={TONE[tone]}
                >
                  {line.text}
                </Tag>
              );
            })}

            {beat.id === 'final' && (
              <div
                ref={ctaEl}
                style={{ opacity: ctaOpacity(0), visibility: 'hidden' }}
                className="pointer-events-auto mt-8 flex justify-center"
              >
                <Link
                  href={CTA.href}
                  className="inline-flex h-12 items-center justify-center rounded-full bg-[#d6a05a] px-8 text-base font-medium text-[#1a1208] transition-colors hover:bg-[#e2b06b] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#f3ebdf]"
                >
                  {CTA.label}
                </Link>
              </div>
            )}
          </div>
        </div>
      ))}

      <div
        ref={hintEl}
        className="absolute inset-x-0 bottom-6 flex flex-col items-center gap-2 text-[11px] uppercase tracking-[0.3em] text-[#b9ac9a]"
      >
        Scroll
        <span aria-hidden className="h-8 w-px bg-gradient-to-b from-[#b9ac9a] to-transparent" />
      </div>
    </div>
  );
}
