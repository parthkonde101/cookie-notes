import { Cookie } from 'lucide-react';

const PARAGRAPHS = [
  'In my second year of B.Tech, I started taking my notes digitally because I preferred having everything in one place. As the class CR, I began sharing them with my classmates during exams, and they soon became a primary source for preparation.',
  'Eventually, students from other classes started asking for them too. Sharing PDFs through unofficial groups became increasingly inconvenient, so I decided to build a website to organize and access the material properly.',
  'As the demand grew, I realized how much students relied on these notes during exams. What started as simply sharing my notes had become something bigger.',
];

/** Told in the creator's own voice, so it follows the creator rather than precedes them. */
export function StorySection() {
  return (
    <section aria-labelledby="story-heading" className="border-t border-border">
      <div className="mx-auto w-full max-w-3xl px-4 py-20 sm:px-6 sm:py-28">
        <h2
          id="story-heading"
          className="text-balance text-3xl font-semibold leading-[1.15] tracking-tight sm:text-4xl"
        >
          How Cookie Notes Came to Be
        </h2>

        <div className="mt-10 space-y-6 font-letter text-lg leading-relaxed text-muted-foreground sm:text-xl sm:leading-relaxed">
          {PARAGRAPHS.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </div>

        <p className="mt-12 flex items-center gap-4 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          <span
            aria-hidden
            className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md"
          >
            <Cookie className="size-5" />
          </span>
          {"That's where Cookie Notes began."}
        </p>
      </div>
    </section>
  );
}
