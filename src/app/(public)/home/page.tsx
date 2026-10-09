import type { Metadata } from 'next';
import { HomeIntro } from '@/components/home/home-intro';
import { trackPageView } from '@/lib/analytics/page-views';

export const metadata: Metadata = {
  title: 'Cookie Notes — baked for exams',
};
export const dynamic = 'force-dynamic';

/**
 * The Home page, always — signed in or not. `/` shows this too for a
 * signed-out visitor (and shows the catalogue instead for a signed-in one),
 * but this route exists so "Home" in the nav is a stable place to land
 * regardless of who is looking, matching how "Catalog" already works.
 */
export default async function HomePage() {
  await trackPageView('home');
  return <HomeIntro />;
}
