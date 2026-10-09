import type { Metadata } from 'next';
import { FeedbackLetter } from '@/components/feedback/feedback-letter';
import { redirect } from 'next/navigation';
import { EMAIL_MIGRATION_PATH, needsEmailMigration, requireUser } from '@/lib/auth/guards';

export const metadata: Metadata = {
  title: 'Feedback — Cookie Notes',
};
export const dynamic = 'force-dynamic';

/**
 * A testimonial, not a bug report — the whole page is built around that. Only
 * a signed-in student can write one, so the name on it is always real and
 * never has to be typed.
 *
 * Writing one needs a verified college email, exactly like opening a note. The
 * guard would bounce an unverified student on its own, but without remembering
 * where they were headed — so the check is made here, and verifying brings them
 * straight back to this page. The submit endpoint enforces the same rule.
 */
export default async function FeedbackPage() {
  const { user } = await requireUser('/feedback', { allowUnverified: true });
  if (needsEmailMigration(user)) {
    redirect(`${EMAIL_MIGRATION_PATH}?next=${encodeURIComponent('/feedback')}`);
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-14 sm:px-6 sm:py-20">
      <FeedbackLetter name={user.name} />
    </div>
  );
}
