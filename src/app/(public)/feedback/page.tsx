import type { Metadata } from 'next';
import { FeedbackLetter } from '@/components/feedback/feedback-letter';
import { requireUser } from '@/lib/auth/guards';

export const metadata: Metadata = {
  title: 'Feedback — Cookie Notes',
};
export const dynamic = 'force-dynamic';

/**
 * A testimonial, not a bug report — the whole page is built around that. Only
 * a signed-in student can write one, so the name on it is always real and
 * never has to be typed.
 */
export default async function FeedbackPage() {
  const { user } = await requireUser('/feedback');

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-14 sm:px-6 sm:py-20">
      <FeedbackLetter name={user.name} />
    </div>
  );
}
