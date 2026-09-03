'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { RotateCw, TriangleAlert } from 'lucide-react';
import { drawWatermark, type WatermarkIdentity } from '@/components/notes/watermark';

/**
 * One page of the protected reader.
 *
 * ## Why this is a component rather than a loop over one shared routine
 *
 * pdf.js keeps a module-level `WeakSet` of canvases that currently have a live
 * render task (`InternalRenderTask.#canvasInUse`). Starting a second `render()`
 * against a canvas already in that set throws:
 *
 *     Cannot use the same canvas during multiple render() operations.
 *
 * The throw happens *inside* the render pipeline, so it surfaces as a rejected
 * RenderTask promise rather than at the call site — easy to swallow, and the
 * canvas is left half-painted or, worse, wiped: assigning to `canvas.width`
 * resets the entire bitmap, so a second attempt erases whatever the first had
 * already drawn. That is what produced blank white pages carrying only a
 * watermark.
 *
 * Making each page its own component with its own canvas and its own effect
 * means React's lifecycle does the hard part: one render attempt per page at a
 * time, cancelled deterministically on cleanup, with no shared mutable map of
 * "which pages are done" to fall out of sync.
 *
 * ## The rules this component keeps
 *
 * 1. At most one live RenderTask per canvas, held in `taskRef`.
 * 2. The canvas is never resized while a task is live — resizing clears it.
 * 3. Cleanup cancels the task and the effect's own `cancelled` flag stops any
 *    continuation from touching the canvas afterwards.
 * 4. `RenderingCancelledException` is expected and silent; every other failure
 *    becomes a visible error card with a retry, never a silent white page.
 * 5. The task is registered with the parent so the document cannot be destroyed
 *    while it is running.
 */

/**
 * Safari — especially on iOS — caps how much canvas backing store a page may
 * hold, and silently hands back a blank canvas when the cap is passed rather
 * than throwing. A full-page scan at devicePixelRatio 3 easily exceeds it, so
 * the render scale is reduced until the bitmap fits. 16.7M px is the widely
 * observed iOS ceiling (4096²) and is comfortably safe elsewhere.
 */
const MAX_CANVAS_PIXELS = 16_777_216;

/** Upper bound on the CSS width a page is rasterised for. */
const MAX_PAGE_WIDTH = 1100;

export interface PdfPageProps {
  doc: import('pdfjs-dist').PDFDocumentProxy;
  pageNumber: number;
  /** CSS pixel width available to the page. Re-renders when it changes. */
  width: number;
  identity: WatermarkIdentity;
  /** Lazy rendering: only pages near the viewport paint. */
  shouldRender: boolean;
  /** Lets the viewer wait for in-flight work before destroying the document. */
  registerTask: (task: import('pdfjs-dist').RenderTask) => () => void;
}

type PageStatus = 'idle' | 'rendering' | 'done' | 'error';

export function PdfPage({
  doc,
  pageNumber,
  width,
  identity,
  shouldRender,
  registerTask,
}: PdfPageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const taskRef = useRef<import('pdfjs-dist').RenderTask | null>(null);
  const [status, setStatus] = useState<PageStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Bumped by the retry button to re-run the effect.
  const [attempt, setAttempt] = useState(0);
  // Keeps the element's height stable before the first paint so the page does
  // not jump under the reader as canvases size themselves.
  const [ratio, setRatio] = useState<number | null>(null);

  const retry = useCallback(() => {
    setErrorMessage(null);
    setStatus('idle');
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!shouldRender || width <= 0) return;

    let cancelled = false;
    let unregister: (() => void) | null = null;

    async function render() {
      const canvas = canvasRef.current;
      if (!canvas) return;

      // A task from a previous width or attempt may still be live on this
      // canvas. Cancel it and wait for it to settle before touching the canvas:
      // pdf.js only releases its canvas lock when the task ends.
      await cancelActiveTask(taskRef);
      if (cancelled) return;

      setStatus('rendering');
      setErrorMessage(null);

      try {
        const page = await doc.getPage(pageNumber);
        if (cancelled) return;

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const cssWidth = Math.min(width, MAX_PAGE_WIDTH);
        const base = page.getViewport({ scale: 1 });

        // Fit the page to the available width, then step the resolution back
        // if the resulting bitmap would be too large for the browser to hold.
        let scale = (cssWidth / base.width) * dpr;
        const area = base.width * scale * (base.height * scale);
        if (area > MAX_CANVAS_PIXELS) {
          scale *= Math.sqrt(MAX_CANVAS_PIXELS / area);
        }

        const viewport = page.getViewport({ scale });
        const pixelWidth = Math.max(1, Math.floor(viewport.width));
        const pixelHeight = Math.max(1, Math.floor(viewport.height));

        if (cancelled) return;

        // Safe to resize: nothing is rendering into this canvas right now.
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
        setRatio(pixelWidth / pixelHeight);

        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) throw new Error('This browser did not provide a 2D canvas context.');

        // Resizing leaves the bitmap transparent; PDF pages assume white paper.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, pixelWidth, pixelHeight);

        const task = page.render({ canvasContext: ctx, viewport });
        taskRef.current = task;
        unregister = registerTask(task);

        await task.promise;

        // The effect may have been torn down while the page was painting.
        if (cancelled) return;

        // Burn the watermark into the same pixels as the content. The scale is
        // device pixels per CSS pixel, so the watermark keeps a constant
        // on-screen size even when the resolution was stepped back above.
        drawWatermark(ctx, pixelWidth, pixelHeight, identity, pixelWidth / cssWidth);

        taskRef.current = null;
        setStatus('done');
      } catch (error) {
        taskRef.current = null;
        if (cancelled || isCancellation(error)) return;
        setErrorMessage(describeRenderError(error));
        setStatus('error');
      } finally {
        unregister?.();
        unregister = null;
      }
    }

    void render();

    return () => {
      cancelled = true;
      // Stop the task now so the canvas lock is released and no continuation
      // paints into a canvas this component no longer owns.
      taskRef.current?.cancel();
      taskRef.current = null;
      unregister?.();
    };
  }, [doc, pageNumber, width, identity, shouldRender, attempt, registerTask]);

  // Before the first paint the wrapper holds a page-shaped placeholder so the
  // scroll height is stable. A page that failed before it ever painted shrinks
  // to the size of its message instead, so the error is visible on screen
  // rather than centred in a full page of empty space.
  const placeholder =
    ratio !== null
      ? undefined
      : status === 'error'
        ? { minHeight: '18rem' }
        : { aspectRatio: '1 / 1.414' };

  return (
    <div
      data-page-wrapper={pageNumber}
      data-page-status={status}
      className="relative w-full max-w-full overflow-hidden rounded-md border border-border bg-white shadow-sm"
      style={placeholder}
    >
      <canvas
        ref={canvasRef}
        data-page={pageNumber}
        className="no-drag block h-auto w-full"
        aria-label={`Page ${pageNumber}`}
      />

      {status === 'error' && (
        <div data-page-error={pageNumber} className="absolute inset-0 bg-card">
          {/*
           * A failed page still occupies the space the page would have, so the
           * document does not reflow underneath the reader. The message sticks
           * just below the toolbar so it is on screen wherever within that
           * space the reader happens to be scrolled.
           */}
          <div className="sticky top-0 flex flex-col items-center gap-3 px-6 py-14 text-center">
            <TriangleAlert className="size-5 text-warning" />
            <div>
              <p className="text-sm font-medium">Page {pageNumber} could not be displayed</p>
              <p className="mt-1 text-xs text-muted-foreground">{errorMessage}</p>
            </div>
            <button
              type="button"
              onClick={retry}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-secondary"
            >
              <RotateCw className="size-3.5" />
              Try again
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Cancels whatever is rendering into a canvas and waits for it to finish.
 *
 * pdf.js removes the canvas from its in-use set inside `cancel()`, but the
 * task's promise still rejects afterwards; awaiting it here keeps that
 * rejection handled and guarantees the pipeline has stopped before the caller
 * resizes or repaints the canvas.
 */
async function cancelActiveTask(
  ref: { current: import('pdfjs-dist').RenderTask | null },
): Promise<void> {
  const task = ref.current;
  if (!task) return;
  ref.current = null;
  task.cancel();
  await task.promise.catch(() => undefined);
}

/** True for the rejection pdf.js raises when a render is deliberately stopped. */
function isCancellation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  return name === 'RenderingCancelledException' || name === 'AbortException';
}

function describeRenderError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/canvas/i.test(message) && /size|memory|allocat/i.test(message)) {
    return 'This page is too large for the browser to display. Try closing other tabs.';
  }
  return message.slice(0, 160) || 'The page failed to render.';
}
