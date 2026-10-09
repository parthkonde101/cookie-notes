import { Quote } from 'lucide-react';
import type { Testimonial } from '@/lib/testimonials';

/** Fixed width regardless of message length — the line-clamp is what keeps a
 * long testimonial from stretching the card past its neighbours. */
export function TestimonialCard({ testimonial }: { testimonial: Testimonial }) {
  return (
    <figure className="flex w-72 shrink-0 flex-col rounded-lg border border-border bg-card p-5 sm:w-80">
      <Quote aria-hidden className="size-5 shrink-0 text-primary/50" />
      <blockquote className="mt-3 line-clamp-5 flex-1 text-sm leading-relaxed text-foreground/90">
        {testimonial.message}
      </blockquote>
      <figcaption className="mt-4 text-sm font-medium text-muted-foreground">
        {testimonial.name}
      </figcaption>
    </figure>
  );
}
