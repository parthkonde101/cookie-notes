import 'server-only';
import { after } from 'next/server';
import { headers } from 'next/headers';
import { optionalUser } from '@/lib/auth/guards';
import { PAGE_VIEW_EVENT, recordEvent } from '@/lib/analytics/events';
import { requestContext } from '@/lib/request';

/** The public pages whose reach the admin analytics report. */
export type TrackedPage = 'home' | 'about';

/**
 * Records that someone looked at a public page.
 *
 * Signed-in students are recorded with their id, so "how many students" is a
 * count of distinct people; a signed-out visitor is recorded without one. Admin
 * views are recorded too but left out of the reports.
 *
 * Link prefetches are skipped: the nav prefetches pages the visitor has not
 * opened, and counting those would put a view on a page nobody saw.
 *
 * The write happens after the response, so it never slows the page. Everything
 * the callback needs is read first — request APIs are not available inside
 * `after()`.
 */
export async function trackPageView(page: TrackedPage): Promise<void> {
  const h = await headers();
  if (h.get('next-router-prefetch') || h.get('purpose') === 'prefetch') return;

  const [auth, ctx] = await Promise.all([optionalUser(), requestContext()]);

  after(() =>
    recordEvent({
      type: PAGE_VIEW_EVENT,
      userId: auth?.user.id ?? null,
      sessionId: auth?.session.id ?? null,
      ctx,
      metadata: { page },
    }),
  );
}
