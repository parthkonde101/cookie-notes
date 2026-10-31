'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CheckCircle2, CircleAlert, Loader2, ShieldCheck } from 'lucide-react';
import { Button, type ButtonProps } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useOptionalAuthModal } from '@/components/auth/auth-modal';
import { formatInr } from '@/lib/commerce/money';

/**
 * Buy a note or a bundle with Razorpay Checkout.
 *
 * The browser's whole part is: ask the server to open a checkout for a product, show
 * Razorpay's own checkout window, and relay what it returns. It is never the authority:
 *
 *   - the price, the buyer and the contents come from the server, not from this component;
 *   - "paid" is shown only when the SERVER says it verified the payment with the gateway;
 *   - if the window closes, the network drops or the confirmation is slow, the purchase is
 *     recovered from server-verified state (polling here, the webhook behind it, and the
 *     "My purchases" page), never assumed.
 *
 * Nothing here handles card details: the card form is Razorpay's.
 */

type Phase = 'idle' | 'starting' | 'checkout' | 'confirming' | 'pending' | 'paid' | 'failed';

interface CheckoutResponse {
  orderId: string;
  gatewayOrderId: string;
  amountMinor: number;
  currency: string;
  keyId: string;
  title: string;
  alreadyOwned: { noteId: string; title: string }[];
  prefill: { name: string; email: string };
}

interface OrderResponse {
  paid: boolean;
  status: string;
  message: string;
}

interface RazorpaySuccess {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}

interface RazorpayInstance {
  open(): void;
  on(event: 'payment.failed', handler: (response: { error?: { description?: string } }) => void): void;
}

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayInstance;
  }
}

const SCRIPT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';
let scriptPromise: Promise<void> | null = null;

function loadCheckoutScript(): Promise<void> {
  if (typeof window !== 'undefined' && window.Razorpay) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      scriptPromise = null; // allow a retry
      reject(new Error('script'));
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}

async function postJson<T>(url: string, body: unknown): Promise<{ status: number; data: T & { error?: string } }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  return { status: response.status, data };
}

export interface BuyButtonProps extends Omit<ButtonProps, 'onClick' | 'children'> {
  productType: 'NOTE' | 'BUNDLE';
  productId: string;
  /** Used for the sign-in redirect and the "open it" link after buying. */
  returnTo: string;
  /** Shown in the button: "Buy · ₹499". */
  priceMinor: number;
  label?: string;
  signedIn: boolean;
  /** Where the purchased content is, for the confirmation. */
  openHref?: string;
  openLabel?: string;
  /** Admin preview: looks real, does nothing. */
  preview?: boolean;
}

export function BuyButton({
  productType,
  productId,
  returnTo,
  priceMinor,
  label,
  signedIn,
  openHref,
  openLabel = 'Open it',
  preview = false,
  className,
  ...buttonProps
}: BuyButtonProps) {
  const router = useRouter();
  const auth = useOptionalAuthModal();
  const [phase, setPhaseState] = useState<Phase>('idle');
  const phaseRef = useRef<Phase>('idle');
  const setPhase = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);
  const [message, setMessage] = useState<string | null>(null);
  const [title, setTitle] = useState<string>('');
  const orderRef = useRef<CheckoutResponse | null>(null);
  const failedMessageRef = useRef<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const finishPaid = useCallback(() => {
    if (!alive.current) return;
    setPhase('paid');
    setMessage(null);
    router.refresh();
  }, [router, setPhase]);

  /** Ask the server (not the browser) what became of the order, for up to ~75 seconds. */
  const settle = useCallback(
    async (orderId: string) => {
      setPhase('pending');
      for (let attempt = 0; attempt < 30 && alive.current; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, attempt < 5 ? 1500 : 3000));
        try {
          const response = await fetch(`/api/commerce/orders/${orderId}`, { cache: 'no-store' });
          if (response.ok) {
            const order = (await response.json()) as OrderResponse;
            if (order.paid) return finishPaid();
            if (order.status === 'FAILED' || order.status === 'CANCELLED') {
              if (!alive.current) return;
              setPhase('failed');
              setMessage(order.message);
              return;
            }
          }
        } catch {
          // offline for a moment: keep waiting
        }
      }
      if (alive.current) {
        setMessage(
          'Your payment is taking longer than usual to confirm. You have not lost it — if it went through, the note will appear in My purchases automatically.',
        );
      }
    },
    [finishPaid, setPhase],
  );

  const confirm = useCallback(
    async (order: CheckoutResponse, success: RazorpaySuccess) => {
      setPhase('confirming');
      setMessage(null);
      try {
        const { status, data } = await postJson<OrderResponse>(`/api/commerce/orders/${order.orderId}/confirm`, success);
        if (status === 200 && data.paid) return finishPaid();
        if (status === 200) return void settle(order.orderId); // pending: the server is still confirming
        if (status === 429 || status >= 500) return void settle(order.orderId);
        setPhase('failed');
        setMessage(data.error ?? 'We could not confirm that payment. If money left your account it will be refunded automatically.');
      } catch {
        // The request may have reached the server; ask it rather than guess.
        void settle(order.orderId);
      }
    },
    [finishPaid, settle, setPhase],
  );

  async function start() {
    if (preview || phase !== 'idle') return;
    if (!signedIn) {
      if (auth) auth.requestAuth(returnTo);
      else window.location.href = `/login?next=${encodeURIComponent(returnTo)}`;
      return;
    }

    setPhase('starting');
    setMessage(null);
    failedMessageRef.current = null;

    try {
      const [{ status, data }] = await Promise.all([
        postJson<CheckoutResponse>('/api/commerce/checkout', { productType, productId }),
        loadCheckoutScript().catch(() => null),
      ]);
      if (status === 401) {
        setPhase('idle');
        if (auth) auth.requestAuth(returnTo);
        else window.location.href = `/login?next=${encodeURIComponent(returnTo)}`;
        return;
      }
      if (status !== 200) {
        setPhase('failed');
        setMessage(data.error ?? 'We could not start the payment. Please try again.');
        return;
      }
      if (!window.Razorpay) {
        setPhase('failed');
        setMessage('The payment window could not be loaded. Check your connection and try again.');
        return;
      }

      const order = data as CheckoutResponse;
      orderRef.current = order;
      setTitle(order.title);

      const accent = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim();
      const checkout = new window.Razorpay({
        key: order.keyId,
        amount: order.amountMinor,
        currency: order.currency,
        name: 'Cookie Notes',
        // Shown where Razorpay would otherwise draw a letter. It must be a public https
        // address, so it is built from the page's own origin (public/checkout-logo.png).
        image: `${window.location.origin}/checkout-logo.png`,
        description: order.title,
        order_id: order.gatewayOrderId,
        prefill: order.prefill,
        theme: accent ? { color: `hsl(${accent})` } : undefined,
        // Students pay from their phones, so UPI goes first (on a phone, Razorpay lists the UPI
        // apps installed there). Every other method the account has enabled stays below it:
        // this only orders what Razorpay offers, it cannot add a method the account lacks.
        config: {
          display: {
            blocks: { upi: { name: 'Pay with UPI', instruments: [{ method: 'upi' }] } },
            sequence: ['block.upi'],
            preferences: { show_default_blocks: true },
          },
        },
        handler: (response: RazorpaySuccess) => void confirm(order, response),
        modal: {
          // Closing the window is not a failure and not a success. If nothing was paid the
          // order is simply abandoned; a payment that completes anyway still pays it.
          ondismiss: () => {
            if (!alive.current) return;
            if (phaseRef.current !== 'checkout') return;
            void fetch(`/api/commerce/orders/${order.orderId}/cancel`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: '{}',
            }).catch(() => undefined);
            if (failedMessageRef.current) {
              setMessage(failedMessageRef.current);
              setPhase('failed');
            } else {
              setPhase('idle');
            }
          },
        },
      });
      checkout.on('payment.failed', (response) => {
        failedMessageRef.current = response.error?.description ?? 'The payment did not go through.';
      });
      setPhase('checkout');
      checkout.open();
    } catch {
      setPhase('failed');
      setMessage('We could not reach the server. Check your connection and try again.');
    }
  }

  const busy = phase === 'starting' || phase === 'checkout' || phase === 'confirming' || phase === 'pending';
  const dialogOpen = phase === 'confirming' || phase === 'pending' || phase === 'paid' || phase === 'failed';

  return (
    <>
      <Button
        {...buttonProps}
        type="button"
        onClick={start}
        disabled={buttonProps.disabled || busy}
        aria-busy={busy}
        className={className}
      >
        {phase === 'starting' || phase === 'checkout' ? (
          <>
            <Loader2 className="animate-spin" />
            {phase === 'starting' ? 'Opening…' : 'Complete payment…'}
          </>
        ) : (
          label ?? `Buy · ${formatInr(priceMinor)}`
        )}
      </Button>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          // Only a finished state can be dismissed; never close on a payment in flight.
          if (!open && (phase === 'paid' || phase === 'failed')) setPhase('idle');
        }}
      >
        <DialogContent hideClose={phase === 'confirming' || phase === 'pending'} aria-live="polite">
          {phase === 'confirming' && (
            <StatusBody
              icon={<Loader2 className="size-6 animate-spin text-primary" />}
              title="Confirming your payment…"
              body="Please keep this page open. This usually takes a few seconds."
            />
          )}
          {phase === 'pending' && (
            <StatusBody
              icon={<Loader2 className="size-6 animate-spin text-primary" />}
              title="Still confirming…"
              body={message ?? 'Your bank is confirming the payment. You will not be charged twice, and your purchase will unlock the moment it is confirmed.'}
              footer={
                message ? (
                  <Button asChild variant="outline">
                    <Link href="/account/purchases">Go to My purchases</Link>
                  </Button>
                ) : null
              }
            />
          )}
          {phase === 'paid' && (
            <StatusBody
              icon={<CheckCircle2 className="size-6 text-success" />}
              title="Payment confirmed"
              body={
                <>
                  <span className="font-medium text-foreground">{title}</span> is yours to keep. It is on
                  your account on every device.
                </>
              }
              footer={
                <>
                  {openHref && (
                    <Button asChild>
                      <Link href={openHref}>{openLabel}</Link>
                    </Button>
                  )}
                  <Button asChild variant="outline">
                    <Link href="/account/purchases">My purchases</Link>
                  </Button>
                </>
              }
            />
          )}
          {phase === 'failed' && (
            <StatusBody
              icon={<CircleAlert className="size-6 text-destructive" />}
              title="That didn’t go through"
              body={message ?? 'The payment did not go through. You have not been charged.'}
              footer={
                <>
                  <Button
                    onClick={() => {
                      setPhase('idle');
                      setTimeout(() => void start(), 0);
                    }}
                  >
                    Try again
                  </Button>
                  <Button variant="outline" onClick={() => setPhase('idle')}>
                    Close
                  </Button>
                </>
              }
            />
          )}
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck className="size-3.5" /> Payments are processed securely by Razorpay.
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}

function StatusBody({
  icon,
  title,
  body,
  footer,
}: {
  icon: React.ReactNode;
  title: string;
  body: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <>
      <DialogHeader>
        <div className="mb-1">{icon}</div>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{body}</DialogDescription>
      </DialogHeader>
      {footer && <DialogFooter className="gap-2 sm:justify-start">{footer}</DialogFooter>}
    </>
  );
}
