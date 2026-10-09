import type { Metadata } from 'next';
import { CatalogueScreen } from '@/components/catalog/catalogue-screen';

export const metadata: Metadata = {
  title: 'Cookie Notes — baked for exams',
};
export const dynamic = 'force-dynamic';

/**
 * The catalogue, always — signed in or not. `/` shows this too for a signed-in
 * visitor, but this route exists so "Catalog" in the nav is a stable place to
 * land regardless of who is looking, matching the fact that browsing has never
 * required an account.
 */
export default function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <CatalogueScreen searchParams={searchParams} />;
}
