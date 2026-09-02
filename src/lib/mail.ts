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
