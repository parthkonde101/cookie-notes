import 'server-only';
import { env } from '@/lib/env';
import { RazorpayProvider } from '@/lib/commerce/razorpay';
import { PaymentsDisabledError, type PaymentProvider } from '@/lib/commerce/gateway';

export * from '@/lib/commerce/gateway';

let cached: { key: string; provider: PaymentProvider } | null = null;

/** The configured gateway, or a thrown `PaymentsDisabledError` when payments are off. */
export function getPaymentProvider(): PaymentProvider {
  if (!env.payments.enabled) throw new PaymentsDisabledError();
  const fingerprint = `${env.payments.keyId}|${env.payments.apiBase}`;
  if (cached?.key === fingerprint) return cached.provider;
  const provider = new RazorpayProvider({
    keyId: env.payments.keyId,
    keySecret: env.payments.keySecret,
    webhookSecret: env.payments.webhookSecret,
    apiBase: env.payments.apiBase,
  });
  cached = { key: fingerprint, provider };
  return provider;
}
