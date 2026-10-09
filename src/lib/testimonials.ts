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
 * could leak them into a public page. A testimonial is returned only when all
 * three hold: it has been REVIEWED by an admin, the student consented to public
 * display, and it has been explicitly featured. The admin actions already keep
 * those in step — featuring requires review and consent, archiving un-features —
 * but this query checks all three itself rather than trusting that invariant: a
 * row that is featured but still pending, or archived, is never shown.
 */
export async function featuredTestimonials(limit = 12): Promise<Testimonial[]> {
  const rows = await prisma.feedback.findMany({
    where: { status: 'REVIEWED', featured: true, publicConsent: true },
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
