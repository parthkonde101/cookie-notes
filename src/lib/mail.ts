import 'server-only';
import { env } from '@/lib/env';

/**
 * Minimal mail abstraction.
 *
 * The MVP ships with the "console" driver: reset links are printed to the server
 * log, which is enough while the platform is free and invite-driven. Switching to
 * real delivery is one environment variable plus an API key.
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** Resend accepts at most 100 messages in one batch call. */
export const MAIL_BATCH_LIMIT = 100;

export interface BatchResult {
  sent: string[];
  failed: { to: string; error: string }[];
}

export async function sendMail(message: MailMessage): Promise<void> {
  if (env.mail.driver === 'resend' && env.mail.resendApiKey) {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.mail.resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.mail.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Email delivery failed (${response.status}): ${body.slice(0, 200)}`);
    }
    return;
  }

  console.info(
    [
      '',
      '──────────────── Cookie Notes mail (console driver) ────────────────',
      `To:      ${message.to}`,
      `Subject: ${message.subject}`,
      '',
      message.text,
      '────────────────────────────────────────────────────────────────────',
      '',
    ].join('\n'),
  );
}

/**
 * Sends many one-to-one emails, reporting per-recipient success.
 *
 * Every message goes to exactly one address — recipients are never placed in a
 * shared To or Cc, so no student ever learns who else is on the list.
 *
 * Failure is per recipient, not per call: a batch that Resend rejects wholesale
 * marks only its own recipients failed and the remaining batches still go out.
 * The caller decides what to do with `failed`; for note-ready mail that means
 * logging it and leaving the note published.
 *
 * `idempotencyKey` is passed to Resend so that a retried batch — a redeployed
 * request, a double submit — is collapsed by the provider rather than delivered
 * twice. The database guard in `notifications.ts` is the primary defence; this
 * is the belt to its braces.
 */
export async function sendMailBatch(
  messages: MailMessage[],
  options: { idempotencyKey?: string } = {},
): Promise<BatchResult> {
  const result: BatchResult = { sent: [], failed: [] };
  if (messages.length === 0) return result;

  if (!(env.mail.driver === 'resend' && env.mail.resendApiKey)) {
    for (const message of messages) {
      await sendMail(message);
      result.sent.push(message.to);
    }
    return result;
  }

  for (let index = 0; index < messages.length; index += MAIL_BATCH_LIMIT) {
    const chunk = messages.slice(index, index + MAIL_BATCH_LIMIT);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${env.mail.resendApiKey}`,
      'Content-Type': 'application/json',
    };
    if (options.idempotencyKey) {
      // One key per chunk: two chunks of the same send are different requests
      // and must not be collapsed into each other.
      headers['Idempotency-Key'] = `${options.idempotencyKey}:${index / MAIL_BATCH_LIMIT}`;
    }

    try {
      const response = await fetch('https://api.resend.com/emails/batch', {
        method: 'POST',
        headers,
        body: JSON.stringify(
          chunk.map((message) => ({
            from: env.mail.from,
            to: [message.to],
            subject: message.subject,
            text: message.text,
            html: message.html,
          })),
        ),
      });

      if (!response.ok) {
        const body = (await response.text()).slice(0, 200);
        const error = `Email delivery failed (${response.status}): ${body}`;
        for (const message of chunk) result.failed.push({ to: message.to, error });
        continue;
      }
      for (const message of chunk) result.sent.push(message.to);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Email delivery failed.';
      for (const message of chunk) result.failed.push({ to: message.to, error: reason });
    }
  }

  return result;
}

export function passwordResetEmail(name: string, url: string): MailMessage['text'] {
  return [
    `Hi ${name},`,
    '',
    'We received a request to reset your Cookie Notes password.',
    'Open the link below to choose a new one. It expires in 60 minutes and can only be used once.',
    '',
    url,
    '',
    'If you did not ask for this, you can ignore this email — your password stays unchanged.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// "Your notes are ready"
// ---------------------------------------------------------------------------

export interface NoteReadyEmailInput {
  /** The recipient's display name. */
  name: string;
  subjectName: string;
  unitName: string;
  /** 1-based position of the unit within its subject, for "Unit 4". */
  unitIndex: number;
  /** Application URL for the subject page — never a storage URL. */
  url: string;
}

/**
 * The note-ready announcement.
 *
 * The link is always an ordinary Cookie Notes route. Nothing about private
 * storage — no bucket, no key, no presigned URL — appears anywhere in the
 * message: opening the notes still goes through the app's own authorisation and
 * the protected reader, exactly as if the student had navigated there.
 *
 * Written as a table-based layout with inline styles because that is what mail
 * clients render reliably; the palette is the Cookie Notes brown so the email
 * looks like the product it came from. A plain-text part is always included, for
 * clients that refuse HTML and for spam scoring.
 */
export function noteReadyEmail(input: NoteReadyEmailInput): MailMessage {
  const { name, subjectName, unitName, unitIndex, url } = input;
  const unitLabel = `Unit ${unitIndex}`;
  const subject = `🍪 Your notes are ready — ${subjectName} · ${unitLabel}`;

  const text = [
    `Hi ${name},`,
    '',
    `Fresh out of the oven: ${unitLabel} of ${subjectName} is now available on Cookie Notes.`,
    '',
    unitName,
    '',
    'Open your notes:',
    url,
    '',
    '—',
    'Cookie Notes · Baked for exams.',
    'You are receiving this because you asked to be notified when these notes were ready.',
  ].join('\n');

  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#faf7f2;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf7f2;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e5ded4;border-radius:12px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">

        <tr><td style="padding:24px 28px 0 28px;">
          <span style="font-size:16px;font-weight:600;color:#8a5524;letter-spacing:-0.01em;">🍪 Cookie Notes</span>
        </td></tr>

        <tr><td style="padding:20px 28px 0 28px;">
          <p style="margin:0 0 4px 0;font-size:12px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#8a5524;">${escapeHtml(unitLabel)}</p>
          <h1 style="margin:0;font-size:22px;line-height:1.3;font-weight:600;color:#1c1714;">${escapeHtml(unitName)}</h1>
          <p style="margin:6px 0 0 0;font-size:14px;color:#6b6157;">${escapeHtml(subjectName)}</p>
        </td></tr>

        <tr><td style="padding:20px 28px 0 28px;">
          <p style="margin:0;font-size:15px;line-height:1.6;color:#3c342d;">
            Hi ${escapeHtml(name)}, these notes are out of the oven and ready to read.
          </p>
        </td></tr>

        <tr><td style="padding:24px 28px 0 28px;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:8px;background:#8a5524;">
            <a href="${escapeAttribute(url)}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">Open notes</a>
          </td></tr></table>
        </td></tr>

        <tr><td style="padding:24px 28px 28px 28px;">
          <hr style="border:none;border-top:1px solid #e5ded4;margin:0 0 14px 0;">
          <p style="margin:0;font-size:12px;line-height:1.6;color:#8b8179;">
            Cookie Notes · Baked for exams.<br>
            You are receiving this because you asked to be notified when these notes were ready.
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { to: '', subject, text, html };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Same as above; kept separate so the intent at each call site is obvious. */
function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/'/g, '&#39;');
}
