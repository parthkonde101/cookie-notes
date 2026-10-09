import type { Metadata } from 'next';
import { CatalogueScreen } from '@/components/catalog/catalogue-screen';
import { HomeIntro } from '@/components/home/home-intro';
import { optionalUser } from '@/lib/auth/guards';
import { trackPageView } from '@/lib/analytics/page-views';

export const metadata: Metadata = {
  title: 'Cookie Notes — baked for exams',
};
export const dynamic = 'force-dynamic';

/**
 * `/`. This is the personalised *entry point*, not a nav destination — nothing
 * in the nav links here. A signed-out visitor gets the introduction — what
 * Cookie Notes is and why to sign up. A signed-in student has already been
 * sold; showing them the catalogue directly is more useful than a page they
 * have seen before.
 *
 * "Home" and "Catalog" in the nav point at `/home` and `/catalog` instead, so
 * either is reachable on demand — signed in or not — at a stable URL that
 * always shows the same thing regardless of who is looking. A signed-in
 * student landing here still sees the catalogue, but clicking "Home" takes
 * them to the real Home page rather than back to what they're already on.
 */
export default async function RootPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const auth = await optionalUser();

  if (auth) {
    return <CatalogueScreen searchParams={searchParams} />;
  }

  // A signed-out visitor sees Home here, so it counts as a Home view.
  await trackPageView('home');
  return <HomeIntro />;
}
