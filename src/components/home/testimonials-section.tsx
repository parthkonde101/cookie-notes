import { Marquee } from '@/components/ui/marquee';
import { TestimonialCard } from '@/components/home/testimonial-card';
import type { Testimonial } from '@/lib/testimonials';

/** Renders nothing when there is nothing to show — no empty marquee, no
 * placeholder skeleton on the public homepage. */
export function TestimonialsSection({ testimonials }: { testimonials: Testimonial[] }) {
  if (testimonials.length === 0) return null;

  return (
    <section className="border-t border-border py-14 sm:py-16">
      <div className="mx-auto w-full max-w-5xl px-4 sm:px-6">
        <h2 className="text-center text-2xl font-semibold tracking-tight sm:text-3xl">
          What students are saying
        </h2>
      </div>

      <div className="mt-8">
        <Marquee>
          {testimonials.map((testimonial) => (
            <TestimonialCard key={testimonial.id} testimonial={testimonial} />
          ))}
        </Marquee>
      </div>
    </section>
  );
}
