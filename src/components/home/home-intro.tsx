import { CinematicStory } from '@/components/home/cinematic/cinematic-story';
import { TestimonialsSection } from '@/components/home/testimonials-section';
import { featuredTestimonials } from '@/lib/testimonials';

/**
 * What a signed-out visitor sees at `/`, and what `/home` shows to everyone. A
 * signed-in visitor at `/` never sees this — the root page sends them straight
 * to the catalogue instead.
 *
 * The story comes first and carries the whole introduction — what the problem
 * is, what Cookie Notes is, and the way into the catalogue. What students say
 * about it follows.
 *
 * A composed list of sections, not one long body — so a future section is a
 * new file plus one new line here, never a diff to the story or Testimonials.
 * (`HeroSection` and `FeaturePointsSection` are no longer used on this page;
 * they are left in place.)
 */
export async function HomeIntro() {
  // The story does not depend on the database, so a slow or failing lookup
  // must not take the whole page down with it: show the story and leave the
  // testimonials out until the next visit.
  const testimonials = await featuredTestimonials().catch((error: unknown) => {
    console.error('[home] featured testimonials unavailable', error);
    return [];
  });

  return (
    <>
      <CinematicStory />
      <TestimonialsSection testimonials={testimonials} />
    </>
  );
}
