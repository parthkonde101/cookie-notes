import 'server-only';
import { prisma } from '@/lib/prisma';
import { publicDisplayName } from '@/lib/utils';

export interface Testimonial {
  id: string;
  message: string;
  name: string;
}

/**
 * What the homepage marquee shows — nothing else reaches this query.
 *
 * The `select` is the whole security model: email, user id and every other
 * account field are simply never fetched, so there is no later mistake that
 * could leak them into a public page. `featured` and `publicConsent` are both
 * required — an admin can only ever feature a testimonial that already has
 * consent (enforced in the admin action), but this query checks both anyway
 * rather than trusting that invariant blindly.
 */
export async function featuredTestimonials(limit = 12): Promise<Testimonial[]> {
  const rows = await prisma.feedback.findMany({
    where: { featured: true, publicConsent: true },
    orderBy: [{ featuredAt: 'desc' }, { createdAt: 'desc' }],
    take: limit,
    select: {
      id: true,
      message: true,
      user: { select: { name: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    message: row.message,
    name: publicDisplayName(row.user.name),
  }));
}
