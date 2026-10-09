import { trackPageView } from '@/lib/analytics/page-views';

export const dynamic = 'force-dynamic';

/**
 * Counts views of the About page for the admin analytics.
 *
 * It lives in a layout so the page itself — and everything it renders — stays
 * exactly as it was; this adds no markup and changes nothing a visitor sees.
 */
export default async function AboutLayout({ children }: { children: React.ReactNode }) {
  await trackPageView('about');
  return children;
}
