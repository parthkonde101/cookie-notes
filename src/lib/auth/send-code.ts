import 'server-only';
import { env } from '@/lib/env';
import { Errors } from '@/lib/errors';
import { invalidateCode, issueCode, type CodeCooldown, type IssueOptions } from '@/lib/auth/otp';
import { sendMail, type MailMessage, type MailResult } from '@/lib/mail';

export interface SendCodeOptions extends IssueOptions {
  /** Builds the email around the plaintext code. It is the only place the code is used. */
  message: (code: string) => MailMessage;
  /** Names the flow in server logs. Never include an address or a code. */
  label: string;
  /** What the student is told if delivery fails. */
  failureMessage?: string;
  /** For tests: stands in for the mail provider. Production code never passes this. */
  send?: (message: MailMessage) => Promise<MailResult>;
}

export type SendCodeResult = { status: 'sent' } | CodeCooldown;

const DEFAULT_FAILURE = 'We could not send the verification email. Please try again shortly.';

/**
 * Issues a code and emails it, and makes sure a code that was never delivered
 * cannot be used.
 *
 * Order matters. The code is issued first (under the per-account lock) and the
 * email is sent after the lock is released. If sending then fails, that one code
 * is retired by its own id: the student is told so honestly, nothing is left that
 * could be guessed at, and a newer code issued by another request in the
 * meantime is never touched.
 *
 * The cooldown still applies after a failure — the retired code is the most
 * recent one — so repeated failures cannot be turned into a stream of sends. When
 * the cooldown applies, the caller is told whether a usable code actually exists
 * (`live`), so a retry never reads as "sent" when it was not.
 */
export async function issueAndSendCode(options: SendCodeOptions): Promise<SendCodeResult> {
  const issued = await issueCode(options);
  if (issued.status === 'cooldown') return issued;

  try {
    const result = await (options.send ?? sendMail)(options.message(issued.code));
    if (!result.delivered) {
      // The code went to the server log rather than an inbox.
      //
      // Asking for real mail and not getting it is an accident — a missing key —
      // so it fails. Explicitly choosing MAIL_DRIVER=console is a deliberate
      // development choice that prints the code to the terminal and is allowed
      // to proceed; `productionConfigWarnings` shouts at boot if it is left on
      // in production.
      console.error(`[${options.label}] code was logged, not emailed (driver=${result.driver})`);
      if (env.mail.driver === 'resend') throw new Error('mail not delivered');
    }
  } catch (error) {
    // Retire exactly this code. Logged without the provider's message, which can
    // echo the recipient, and never with the code.
    await invalidateCode(issued.tokenId).catch(() => undefined);
    console.error(
      `[${options.label}] verification email failed; code withdrawn (${error instanceof Error ? error.name : 'unknown'})`,
    );
    throw Errors.internal(options.failureMessage ?? DEFAULT_FAILURE);
  }

  return { status: 'sent' };
}
