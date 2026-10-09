import type { Metadata } from 'next';
import { FounderSection } from '@/components/about/founder-section';
import { StorySection } from '@/components/about/story-section';

export const metadata: Metadata = {
  title: 'About — Cookie Notes',
  description: 'Why Cookie Notes exists, how it began, and who is building it.',
};

const EYEBROW = 'text-sm font-medium uppercase tracking-[0.18em] text-primary';
const HEADING =
  'mt-4 text-balance text-[2.05rem] font-semibold leading-[1.1] tracking-tight sm:text-[2.75rem]';
const BODY = 'text-lg leading-relaxed text-muted-foreground sm:text-xl';

/**
 * Problem → Gap → Solution → Creator → Story. The first three share one
 * column and one type scale so they read as a single argument; only the text
 * alignment changes (left, right, left), never where the column sits.
 */
export default function AboutPage() {
  return (
    <>
      <h1 className="sr-only">About Cookie Notes</h1>

      <section
        aria-labelledby="problem-heading"
        className="mx-auto w-full max-w-[51.5rem] px-4 pb-14 pt-20 text-left sm:px-6 sm:pb-20 sm:pt-28"
      >
        <p className={EYEBROW}>Problem</p>
        <h2 id="problem-heading" className={HEADING}>
          Sometimes, the hardest part is knowing what to study.
        </h2>
        <p className={`mt-8 ${BODY}`}>
          {
            "As exams approach, students often have plenty of material but aren't sure what to study. Important topics can be scattered across different sources, making preparation harder than it needs to be."
          }
        </p>
      </section>

      <section
        aria-labelledby="gap-heading"
        className="mx-auto w-full max-w-[51.5rem] px-4 py-14 text-right sm:px-6 sm:py-20"
      >
        <p className={EYEBROW}>Gap</p>
        <h2 id="gap-heading" className={HEADING}>
          {"More study material doesn't always mean better study."}
        </h2>
        <p className={`mt-8 ${BODY}`}>
          PPTs, reference books, PDFs, and other resources are valuable for building a strong
          understanding, but can be lengthy and inconvenient to go through during exams.
        </p>
      </section>

      <section
        aria-labelledby="solution-heading"
        className="mx-auto w-full max-w-[51.5rem] px-4 py-14 text-left sm:px-6 sm:py-20"
      >
        <p className={EYEBROW}>Solution</p>
        <h2 id="solution-heading" className={HEADING}>
          <span className="block">The notes you need.</span>
          <span className="block">Everything important, in one place.</span>
        </h2>
        <p className={`mt-8 ${BODY}`}>
          Cookie Notes brings the material that matters together in one place, organized around what
          you actually need to know. It gives you a simpler way to study, revise, and prepare when
          exams approach.
        </p>
      </section>

      <FounderSection />
      <StorySection />
    </>
  );
}
