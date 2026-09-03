'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Loader2,
  ShieldCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/feedback';
import { PdfPage } from '@/components/notes/pdf-page';
import { watermarkCaption, type WatermarkIdentity } from '@/components/notes/watermark';
import { cn } from '@/lib/utils';

interface ViewerProps {
  noteId: string;
  title: string;
  subtitle: string;
  backHref: string;
}

interface OpenResponse {
  viewId: string;
  contentUrl: string;
  watermark: { email: string; name: string; sessionRef: string; issuedAt: string };
}

type Status = 'loading' | 'ready' | 'error';

/**
 * In-app PDF reader.
 *
 * Pages are rasterised to a canvas with pdf.js rather than handed to the
 * browser's built-in PDF plugin, which means there is no download button, no
 * print control and no selectable text layer to copy out — and it lets the
 * watermark be burned into the same pixels the reader sees.
 *
 * Pages always render to fit the available width; the browser's own zoom is
 * left to do the rest, so the toolbar carries page navigation only.
 *
 * Each page owns its canvas and its render lifecycle (see `PdfPage`). This
 * component is responsible for the three things that must be coordinated
 * across pages: which pages are near enough to the viewport to paint, how wide
 * they should paint, and — critically — not destroying the PDF document while
 * any page is still rendering into it.
 *
 * See the README for what this does and does not protect against.
 */
export function NoteViewer({ noteId, title, subtitle, backHref }: ViewerProps) {
  const [status, setStatus] = useState<Status>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [doc, setDoc] = useState<import('pdfjs-dist').PDFDocumentProxy | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [visiblePages, setVisiblePages] = useState<ReadonlySet<number>>(() => new Set([1]));
  const [pageWidth, setPageWidth] = useState(0);
  const [obscured, setObscured] = useState(false);
  const [identity, setIdentity] = useState<WatermarkIdentity | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const viewIdRef = useRef<string | null>(null);
  const activeMsRef = useRef(0);
  const lastTickRef = useRef(Date.now());
  const maxPageRef = useRef(1);

  /**
   * Every render task currently painting a page of this document.
   *
   * pdf.js forbids tearing a document down while it is still rendering, and a
   * destroyed document makes in-flight renders fail in ways that leave a blank
   * canvas behind. Pages register here so teardown can cancel them and wait.
   */
  const tasksRef = useRef(new Set<import('pdfjs-dist').RenderTask>());

  // Stable for the life of the component, so it never re-triggers a page's
  // render effect.
  const registerTask = useCallback((task: import('pdfjs-dist').RenderTask) => {
    tasksRef.current.add(task);
    return () => {
      tasksRef.current.delete(task);
    };
  }, []);

  // --- telemetry -----------------------------------------------------------

  const report = useCallback(
    (body: Record<string, unknown>, beacon = false) => {
      if (!viewIdRef.current) return;
      const payload = JSON.stringify({ ...body, viewId: viewIdRef.current });
      const url = `/api/notes/${noteId}/events`;

      if (beacon && typeof navigator !== 'undefined' && navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([payload], { type: 'application/json' }));
        return;
      }
      void fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: beacon,
      }).catch(() => undefined);
    },
    [noteId],
  );

  const flagSuspicious = useCallback(
    (signal: string) => report({ type: 'suspicious', signal }),
    [report],
  );

  // --- load the document ---------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    let loaded: import('pdfjs-dist').PDFDocumentProxy | null = null;
    const tasks = tasksRef.current;

    async function load() {
      try {
        // 1. Ask the server to authorise this reading session.
        const openResponse = await fetch(`/api/notes/${noteId}/view-token`, {
          method: 'POST',
          cache: 'no-store',
        });

        if (!openResponse.ok) {
          const data = (await openResponse.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? 'This note is not available on your account.');
        }

        const open = (await openResponse.json()) as OpenResponse;
        if (cancelled) return;

        viewIdRef.current = open.viewId;
        setIdentity({
          email: open.watermark.email,
          sessionRef: open.watermark.sessionRef,
          dateLabel: new Date(open.watermark.issuedAt).toLocaleDateString('en-GB', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
          }),
        });

        // 2. Fetch the bytes. They never touch a public URL and are not cached.
        const contentResponse = await fetch(open.contentUrl, { cache: 'no-store' });
        if (!contentResponse.ok) {
          throw new Error('We could not load this file. Please reopen the note.');
        }
        const buffer = await contentResponse.arrayBuffer();
        if (cancelled) return;

        // 3. Render with pdf.js (client-side only).
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';

        const document_ = await pdfjs.getDocument({
          data: new Uint8Array(buffer),
          isEvalSupported: false,
          disableAutoFetch: true,
        }).promise;

        if (cancelled) {
          void document_.destroy();
          return;
        }

        loaded = document_;
        setDoc(document_);
        setPageCount(document_.numPages);
        setStatus('ready');
        report({ type: 'heartbeat', pageCount: document_.numPages, page: 1 });
      } catch (error) {
        if (cancelled) return;
        setErrorMessage(error instanceof Error ? error.message : 'Something went wrong.');
        setStatus('error');
      }
    }

    void load();

    return () => {
      cancelled = true;

      // Tear the document down only once nothing is painting into it. Each page
      // also cancels its own task on unmount; this is the backstop that makes
      // the ordering explicit and waits for the cancellations to settle.
      const pending = [...tasks];
      tasks.clear();
      for (const task of pending) task.cancel();

      const settled = Promise.all(pending.map((task) => task.promise.catch(() => undefined)));
      void settled.then(() => loaded?.destroy());
    };
  }, [noteId, report]);

  // --- how wide should a page paint ----------------------------------------

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Quantised so ordinary scroll-driven layout jitter never re-renders a
    // page, while a real resize or an orientation change does.
    const measure = () => {
      const available = container.clientWidth - 24;
      const quantised = Math.max(240, Math.round(available / 40) * 40);
      setPageWidth((current) => (current === quantised ? current : quantised));
    };

    measure();

    let frame = 0;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(frame);
      frame = window.setTimeout(measure, 250);
    });
    observer.observe(container);

    return () => {
      window.clearTimeout(frame);
      observer.disconnect();
    };
  }, [status]);

  // --- which pages are near enough to paint --------------------------------

  useEffect(() => {
    if (status !== 'ready' || pageCount === 0) return;
    const container = containerRef.current;
    if (!container) return;

    const observer = new IntersectionObserver(
      (entries) => {
        setVisiblePages((current) => {
          const next = new Set(current);
          let changed = false;

          for (const entry of entries) {
            const pageNumber = Number((entry.target as HTMLElement).dataset.pageWrapper);
            if (!pageNumber) continue;

            if (entry.isIntersecting) {
              if (!next.has(pageNumber)) {
                next.add(pageNumber);
                changed = true;
              }
              if (entry.intersectionRatio > 0.5) {
                setCurrentPage(pageNumber);
                if (pageNumber > maxPageRef.current) {
                  maxPageRef.current = pageNumber;
                  report({ type: 'page', page: pageNumber, pageCount });
                }
              }
            }
          }

          return changed ? next : current;
        });
      },
      { root: null, rootMargin: '600px 0px', threshold: [0, 0.5] },
    );

    const elements = container.querySelectorAll('[data-page-wrapper]');
    elements.forEach((element) => observer.observe(element));

    return () => observer.disconnect();
  }, [status, pageCount, report]);

  // --- reading time --------------------------------------------------------

  useEffect(() => {
    if (status !== 'ready') return;
    lastTickRef.current = Date.now();

    const tick = setInterval(() => {
      if (document.visibilityState === 'visible') {
        activeMsRef.current += Date.now() - lastTickRef.current;
      }
      lastTickRef.current = Date.now();
    }, 5_000);

    const beat = setInterval(() => {
      report({
        type: 'heartbeat',
        durationMs: activeMsRef.current,
        page: currentPage,
        pageCount,
      });
    }, 30_000);

    const finish = () => {
      report(
        { type: 'close', durationMs: activeMsRef.current, page: currentPage, pageCount },
        true,
      );
    };
    window.addEventListener('pagehide', finish);

    return () => {
      clearInterval(tick);
      clearInterval(beat);
      window.removeEventListener('pagehide', finish);
      finish();
    };
  }, [status, report, currentPage, pageCount]);

  // --- best-effort content protection -------------------------------------

  useEffect(() => {
    const stop = (event: Event) => event.preventDefault();

    const onKeyDown = (event: KeyboardEvent) => {
      const meta = event.ctrlKey || event.metaKey;

      if (meta && ['p', 's'].includes(event.key.toLowerCase())) {
        event.preventDefault();
        flagSuspicious(event.key.toLowerCase() === 'p' ? 'print_shortcut' : 'save_shortcut');
      }
      // macOS screenshot shortcuts and the Windows PrintScreen key. These cannot
      // be blocked — we only note that they happened.
      if (event.key === 'PrintScreen' || (event.metaKey && event.shiftKey && /[34565]/.test(event.key))) {
        flagSuspicious('screenshot_shortcut');
      }
    };

    const onBeforePrint = () => flagSuspicious('print_dialog');

    const onVisibility = () => {
      const hidden = document.visibilityState !== 'visible';
      setObscured(hidden);
      if (hidden) flagSuspicious('window_hidden');
    };

    document.addEventListener('contextmenu', stop);
    document.addEventListener('selectstart', stop);
    document.addEventListener('dragstart', stop);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('beforeprint', onBeforePrint);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      document.removeEventListener('contextmenu', stop);
      document.removeEventListener('selectstart', stop);
      document.removeEventListener('dragstart', stop);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('beforeprint', onBeforePrint);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [flagSuspicious]);

  // --- navigation ----------------------------------------------------------

  const goToPage = useCallback((pageNumber: number) => {
    const target = containerRef.current?.querySelector<HTMLElement>(
      `[data-page-wrapper="${pageNumber}"]`,
    );
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const pages = useMemo(
    () => Array.from({ length: pageCount }, (_, index) => index + 1),
    [pageCount],
  );

  if (status === 'error') {
    return (
      <div className="mx-auto max-w-lg px-4 py-16">
        <Alert variant="error" title="This note could not be opened">
          {errorMessage}
        </Alert>
        <Button asChild variant="outline" className="mt-4">
          <Link href={backHref}>
            <ArrowLeft className="size-4" /> Go back
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      {/* Toolbar */}
      <header className="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur print-hidden">
        <div className="flex h-14 items-center gap-3 px-3 sm:px-4">
          <Button asChild variant="ghost" size="icon-sm" aria-label="Back">
            <Link href={backHref}>
              <ArrowLeft className="size-4" />
            </Link>
          </Button>

          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium leading-tight">{title}</p>
            <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
          </div>

          <div className="flex items-center gap-1 rounded-md border border-border px-1">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Previous page"
              disabled={currentPage <= 1}
              onClick={() => goToPage(currentPage - 1)}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span className="min-w-[4.5rem] text-center text-xs tabular-nums">
              {currentPage} / {pageCount || '–'}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Next page"
              disabled={currentPage >= pageCount}
              onClick={() => goToPage(currentPage + 1)}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      </header>

      {/* Pages */}
      <div
        ref={containerRef}
        className={cn(
          'protected-content no-select relative flex-1 overflow-y-auto bg-muted/30 px-3 py-6 sm:px-6',
          obscured && 'select-none',
        )}
      >
        {status === 'loading' && (
          <div className="flex flex-col items-center justify-center gap-3 py-24 text-muted-foreground">
            <Loader2 className="size-6 animate-spin" />
            <p className="text-sm">Preparing your copy…</p>
          </div>
        )}

        <div className="mx-auto flex max-w-[1100px] flex-col items-center gap-6">
          {doc &&
            identity &&
            pages.map((pageNumber) => (
              <PdfPage
                key={pageNumber}
                doc={doc}
                pageNumber={pageNumber}
                width={pageWidth}
                identity={identity}
                shouldRender={visiblePages.has(pageNumber)}
                registerTask={registerTask}
              />
            ))}
        </div>

        {identity && status === 'ready' && (
          <p className="mt-8 text-center text-[11px] text-muted-foreground">
            {watermarkCaption(identity)}
          </p>
        )}

        {/* Blur the content when the window loses focus. */}
        {obscured && (
          <div className="pointer-events-none fixed inset-0 z-20 flex items-center justify-center bg-background/80 backdrop-blur-md">
            <div className="flex items-center gap-2 rounded-md border border-border bg-card px-4 py-3 text-sm">
              <ShieldCheck className="size-4 text-primary" />
              Content hidden while this window is not in focus
            </div>
          </div>
        )}
      </div>

      <footer className="border-t border-border px-4 py-2.5 print-hidden">
        <p className="flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
          <AlertTriangle className="size-3" />
          Personalised copy — sharing or redistributing it is traceable to your account.
        </p>
      </footer>
    </div>
  );
}
