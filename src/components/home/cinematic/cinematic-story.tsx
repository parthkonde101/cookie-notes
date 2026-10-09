'use client';

import dynamic from 'next/dynamic';
import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { clamp } from '@/components/home/cinematic/math';
import { StaticStory } from '@/components/home/cinematic/static-story';
import { StoryOverlay } from '@/components/home/cinematic/story-overlay';
import {
  HOLD_END,
  PALETTE,
  SCROLL_HEIGHT_VH,
  SETTLE,
  SMOOTH_TIME,
} from '@/components/home/cinematic/story-config';
import { createStoryState, type StoryState } from '@/components/home/cinematic/story-state';
import { prefetchStudent } from '@/components/home/cinematic/student-asset';
import { easeInOutCubic, glideDuration, pickStop } from '@/components/home/cinematic/settle';

// The 3D scene (and Three.js with it) is a separate chunk, fetched after the
// page has rendered. Nothing about the first paint waits for it.
const StudyScene = dynamic(() => import('@/components/home/cinematic/scene/study-scene'), {
  ssr: false,
  loading: () => null,
});

/** The site header is sticky and this tall; the stage sits just beneath it. */
const HEADER_PX = 64;

class SceneBoundary extends Component<
  { onError: () => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    this.props.onError();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function canRunWebGL() {
  try {
    const probe = document.createElement('canvas');
    return Boolean(probe.getContext('webgl2') || probe.getContext('webgl'));
  } catch {
    return false;
  }
}

/**
 * The Home page's story: one tall scroll track with a full-screen stage pinned
 * inside it. Scrolling moves a camera through a single 3D scene while the
 * words fade in and out at the right moments.
 *
 * Until JavaScript decides the scene can run — and always, for anyone who has
 * asked for reduced motion — the page shows `StaticStory` instead: the same
 * words and the same ending, with nothing moving.
 */
export function CinematicStory() {
  const container = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const storyRef = useRef<StoryState | null>(null);
  if (!storyRef.current) storyRef.current = createStoryState();
  const story = storyRef.current;

  const [phase, setPhase] = useState<'checking' | 'scene' | 'fallback'>('checking');
  const [active, setActive] = useState(true);
  const [ready, setReady] = useState(false);
  const onReady = useCallback(() => setReady(true), []);

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const runs = !reduced && canRunWebGL();
    // Start fetching the character now, in parallel with the 3D code, rather
    // than after that code has arrived.
    if (runs) prefetchStudent().catch(() => {});
    setPhase(runs ? 'scene' : 'fallback');
  }, []);

  // Scroll → progress. Runs only while the stage is on screen.
  useEffect(() => {
    if (phase !== 'scene') return;
    const track = container.current;
    const pinned = stage.current;
    if (!track || !pinned) return;

    let raf = 0;
    let visible = true;
    let last = performance.now();

    // Settling: when the viewer stops scrolling, the film glides on to the
    // next topic's resting point. Anything the viewer does cancels it at once.
    let lastTarget = story.target;
    let anchor = story.target;
    let lastMoveAt = last;
    let gesturing = false;
    let touching = false;
    let glide: {
      from: number;
      to: number;
      start: number;
      duration: number;
      y0: number;
      y1: number;
    } | null = null;
    let lastSetY = window.scrollY;

    const geometry = () => {
      const rect = track.getBoundingClientRect();
      const range = Math.max(1, rect.height - pinned.offsetHeight);
      return { rect, range };
    };

    const measure = () => {
      const { rect, range } = geometry();
      story.target = clamp((HEADER_PX - rect.top) / range / (1 - HOLD_END));
    };

    /** The scroll position at which the film sits at `progress`. */
    const scrollFor = (progress: number) => {
      const { rect, range } = geometry();
      const wantTop = HEADER_PX - progress * (1 - HOLD_END) * range;
      return window.scrollY + (rect.top - wantTop);
    };

    const cancelGlide = () => {
      glide = null;
    };

    const startGlide = (to: number, now: number) => {
      const y1 = scrollFor(to);
      glide = {
        from: story.target,
        to,
        start: now,
        duration: glideDuration(to - story.target),
        y0: window.scrollY,
        y1,
      };
      lastSetY = window.scrollY;
    };

    const settle = (now: number) => {
      if (glide) {
        // The viewer took over mid-glide (scrollbar, keys, a drag): let go.
        if (Math.abs(window.scrollY - lastSetY) > 3) {
          glide = null;
          lastMoveAt = now;
          return;
        }
        const k = Math.min(1, (now - glide.start) / glide.duration);
        const y = glide.y0 + (glide.y1 - glide.y0) * easeInOutCubic(k);
        lastSetY = y;
        window.scrollTo({ top: y, behavior: 'instant' as ScrollBehavior });
        lastSetY = window.scrollY;
        if (k >= 1) {
          glide = null;
          gesturing = false;
          anchor = story.target;
          lastTarget = story.target;
        }
        return;
      }

      if (Math.abs(story.target - lastTarget) > 1e-5) {
        if (!gesturing) {
          gesturing = true;
          anchor = lastTarget;
        }
        lastTarget = story.target;
        lastMoveAt = now;
        return;
      }

      if (gesturing && !touching && now - lastMoveAt > SETTLE.idleMs) {
        gesturing = false;
        const to = pickStop(story.target, anchor);
        if (to !== null) startGlide(to, now);
        else anchor = story.target;
      }
    };

    const tick = (now: number) => {
      raf = 0;
      if (!visible) return;
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      measure();
      settle(now);
      // Critically damped follow (the SmoothDamp form): no overshoot, and the
      // speed carries across frames instead of restarting at every scroll tick.
      const omega = 2 / SMOOTH_TIME;
      const x = omega * dt;
      const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
      const change = story.smooth - story.target;
      const carried = (story.velocity + omega * change) * dt;
      story.velocity = (story.velocity - omega * carried) * decay;
      story.smooth = story.target + (change + carried) * decay;
      if (Math.abs(story.target - story.smooth) < 0.00005 && Math.abs(story.velocity) < 0.0005) {
        story.smooth = story.target;
        story.velocity = 0;
      }
      story.subscribers.forEach((fn) => fn(story.smooth));
      raf = requestAnimationFrame(tick);
    };

    // Any input from the viewer ends a glide straight away.
    const onWheel = () => cancelGlide();
    const onTouchStart = () => {
      touching = true;
      cancelGlide();
    };
    const onTouchEnd = () => {
      touching = false;
      lastMoveAt = performance.now();
    };
    const onKey = (e: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key))
        cancelGlide();
    };
    window.addEventListener('wheel', onWheel, { passive: true });
    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchend', onTouchEnd, { passive: true });
    window.addEventListener('touchcancel', onTouchEnd, { passive: true });
    window.addEventListener('keydown', onKey);

    // Arriving part-way down (a reload, a back button) starts there, not at 0.
    measure();
    story.smooth = story.target;
    story.velocity = 0;
    lastTarget = story.target;
    anchor = story.target;

    const observer = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
        setActive(entry.isIntersecting);
        if (visible && !raf) {
          last = performance.now();
          raf = requestAnimationFrame(tick);
        }
      },
      { rootMargin: '150px 0px' },
    );
    observer.observe(track);
    raf = requestAnimationFrame(tick);

    return () => {
      observer.disconnect();
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchend', onTouchEnd);
      window.removeEventListener('touchcancel', onTouchEnd);
      window.removeEventListener('keydown', onKey);
    };
  }, [phase, story]);

  const fallback = phase === 'fallback';

  return (
    <>
      <StaticStory className={fallback ? '' : 'hidden motion-reduce:block'} />

      <div
        ref={container}
        className={fallback ? 'hidden' : 'motion-reduce:hidden'}
        style={{ height: `${SCROLL_HEIGHT_VH}svh` }}
      >
        <div
          ref={stage}
          className="sticky top-16 h-[calc(100svh-4rem)] overflow-hidden"
          style={{ backgroundColor: PALETTE.room }}
        >
          {phase === 'scene' && (
            <div
              className={`absolute inset-0 transition-opacity duration-700 ${
                ready ? 'opacity-100' : 'opacity-0'
              }`}
            >
              <SceneBoundary onError={() => setPhase('fallback')}>
                <StudyScene story={story} active={active} onReady={onReady} />
              </SceneBoundary>
            </div>
          )}

          {/* A soft vignette keeps the eye in the middle and the words legible. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_45%,transparent_45%,rgba(8,6,4,0.55)_100%)]"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-2/5 bg-gradient-to-b from-[rgba(8,6,4,0.6)] to-transparent [@media(min-aspect-ratio:23/20)]:hidden"
          />

          <StoryOverlay story={story} />
        </div>
      </div>
    </>
  );
}
