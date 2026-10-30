# Paid notes, bundles and sales — implementation guide

Cookie Notes can sell single notes and bundles through **Razorpay** (INR). This guide covers
how it works, how to set it up in **test mode**, how to review sales, and what has to happen
before anything touches production.

> **Status.** Everything described here is implemented and verified against a *local mock of
> Razorpay's API* (`scripts/lib/mock-gateway.ts`). It has **not** yet been run against
> Razorpay's real test-mode servers, and no real payment has ever been made. Step 4 below
> (a test-mode run with real test keys) is the first thing to do before trusting it.

## 1. How it works

| Concern | Behaviour |
| --- | --- |
| Price | Integer **paise**, INR only. A paid note costs ₹1.00–₹50,000.00 (DB-enforced). |
| Who decides the price | The server, from the database, at the moment of checkout. The browser sends only a product type and id. |
| Checkout | Server creates an `Order` (state `CREATED`) and a Razorpay order; the browser opens Razorpay Checkout with the **public** key id only. |
| Confirmation | After paying, the browser sends back Razorpay's `order_id`, `payment_id`, `signature`. The server verifies the HMAC signature, then **fetches the payment from Razorpay itself** and checks the amount, currency and order before granting anything. The browser's word is never enough. |
| Webhooks | `POST /api/webhooks/razorpay` — signature checked over the **raw body**, each event recorded once (by `X-Razorpay-Event-Id`), safe to replay, safe out of order. Webhooks settle payments the browser never reported (closed tab, lost connection). |
| Access | Purchases create rows in `purchase_grants`, separate from admin/promo grants in `entitlements`. A refund revokes **only** the grants that purchase created; admin and promo access is never touched. `checkNoteAccess` consults both. |
| Bundles | A bundle expands into one grant per note, from a snapshot of its contents taken at purchase. Editing a bundle later never changes what an earlier buyer received or paid. |
| Refunds | Admin-initiated, server-side, through Razorpay. An order is marked refunded only once Razorpay confirms. Partial refunds keep access; a full refund revokes it. |
| History | Orders, items, transactions, refunds and webhook events are never deleted by deleting a user or a note (customer details are snapshotted; notes with sales can only be archived). |

### Order states

`CREATED → PENDING → PAID → PARTIALLY_REFUNDED → REFUNDED`, plus `FAILED` and `CANCELLED`.
A state never moves backwards on a late or duplicated event, and money wins: a payment that
arrives for an order that was marked failed or cancelled still completes it.

### What is *not* changed

* `OPEN_ACCESS_MODE` is untouched. Paid notes ignore it (they are never opened by the open-preview
  fallback), so selling notes does not require turning it off, and turning it off does not affect
  paid notes. Free notes behave exactly as before.
* Authentication, session checks, view tokens, watermarking and content serving are unchanged;
  the PDF routes simply honour purchase grants as one more source of entitlement.

## 2. Configuration

All three must be set or **payments stay off** (prices still display; Buy explains that payments
are unavailable). They are server-only secrets — never `NEXT_PUBLIC_`, never committed.

```
RAZORPAY_KEY_ID=rzp_test_...        # public id, sent to the browser
RAZORPAY_KEY_SECRET=...             # server only
RAZORPAY_WEBHOOK_SECRET=...         # a secret YOU choose when creating the webhook
# PAYMENT_MODE=test                 # optional; must agree with the key
```

* A **live** key (`rzp_live_…`) is refused unless `NODE_ENV=production` **and**, on Vercel,
  `VERCEL_ENV=production`. A laptop can never take a real payment, and neither can a Preview
  deployment (Vercel Preview builds run with `NODE_ENV=production`, so `VERCEL_ENV` is what tells
  them apart). Set `PAYMENT_MODE=test` in Preview as well; it makes any mismatch with the key
  switch payments off.
* `ANALYTICS_TIMEZONE` (default `Asia/Kolkata`) is the clock for "today", "this month" and every
  date range on the Sales page.

## 3. Database

The change is additive: `prisma/migrations/20261001000000_commerce/migration.sql`, applied by
`npm run db:setup`. It is guarded and idempotent (safe to run twice) and adds the `isPaid` column
on notes, the commerce tables, and CHECK constraints (e.g. a paid note must be restricted and
priced). Existing notes default to not-for-sale, so the public catalogue is unchanged.

`npm run db:verify` checks the schema, including every new model.

## 4. Test-mode run with real Razorpay test keys

1. Razorpay Dashboard → switch to **Test Mode** → Account & Settings → API Keys → generate keys.
2. Put the three values in your **local** `.env` (never in the repo).
3. Expose your dev server (e.g. a tunnel) and register a webhook at
   `https://<tunnel-host>/api/webhooks/razorpay` with the secret from step 2 and these events:
   `payment.authorized`, `payment.captured`, `payment.failed`, `order.paid`,
   `refund.created`, `refund.processed`, `refund.failed`. Leave **Automatic capture** on.
4. Admin → Notes → open a note → **Access and price** → *For sale*, set a price, Save.
5. Sign in as a student, press Buy, and pay with Razorpay's published test card/UPI details.
6. Confirm: the note shows *Owned*; **My purchases** lists it; Admin → **Sales** shows the order.
7. Admin → Sales → open the order → **Refund** → confirm the student loses access.
8. Also try: closing the tab right after paying (the webhook should still grant access) and a
   failed payment (no access, order shows *Payment failed*).

Things this step must confirm, because the mock cannot: the exact JSON fields Razorpay returns for
payments/refunds/webhooks match what `src/lib/commerce/razorpay.ts` and `webhook.ts` read.

### Testing on a Vercel Preview

Use a branch-scoped set of Preview variables so nothing is shared with Production (Vercel
shares a variable across Production and Preview unless it is scoped to a branch). For the
branch under test, set its own:

| Variable | Preview value |
| --- | --- |
| `DATABASE_URL` | a non-production Neon branch (pooled endpoint) |
| `AUTH_SECRET`, `VIEW_TOKEN_SECRET` | new, different from Production and from each other (≥ 24 chars) |
| `APP_URL` | the https branch URL, no trailing slash |
| `STORAGE_DRIVER=s3`, `S3_BUCKET`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`, `S3_FORCE_PATH_STYLE` | a separate private bucket and a token scoped to it only |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | **test mode only** (`rzp_test_…`) |
| `PAYMENT_MODE` | `test` |
| `MAIL_DRIVER` | `console` (no real email), with `EMAIL_VERIFICATION_REQUIRED=false` |

The Razorpay test webhook must point at `<APP_URL>/api/webhooks/razorpay`. If Deployment
Protection is on, add a bypass for that path, or Razorpay's requests are rejected before the
app sees them. Never set `RAZORPAY_API_BASE`.

## 5. Admin

* **Notes → a note → Access and price**: Free / Restricted / For sale. Changes are audit-logged.
  Price changes affect future purchases only.
* **Bundles**: create, choose notes (only for-sale notes), set a price, subjects to promote on, an
  optional cover, active/featured. The preview is exactly what students see. A bundle can go
  live only with ≥ 2 published notes and a subject page. "Save ₹X" is shown only when the sum of
  the notes' prices really exceeds the bundle price.
* **Sales**: gross (by payment time), refunds (by refund time), net, average order, notes vs
  bundles, failed / pending / abandoned, best sellers, and a paginated transactions table with
  filters and search. Ranges: today, 7 days, 30 days, this month, custom. Pending payments are
  never counted as revenue. There is deliberately **no conversion rate**: product views and
  checkout opens are not recorded, so there is nothing real to divide by.
* **Order page**: customer, gateway payment ids, what was bought and the access it gave, refunds,
  *Check with gateway* (re-asks Razorpay), and *Refund*.

## 6. Verification

```
npm run build
npm run verify:commerce      # needs the disposable local DB (see scripts/lib/disposable-db.ts)
```

`verify:commerce` runs the real application against a mock gateway and covers money handling,
DB constraints, the access matrix (open access on/off), forged/mismatched/duplicate/late
payments, webhook idempotency and ordering, grant provenance, refunds (including lost answers),
protected PDF routes, retention, admin rules, report maths on a hand-calculated dataset, and page
access. It refuses to run against anything that does not look like a disposable database.

## 7. Production checklist (nothing here has been done)

1. Review and apply the migration to production (take a backup first).
2. Set `RAZORPAY_*` live values in the hosting environment; register the live webhook
   (separate from the test one, with its own secret).
3. Decide on `OPEN_ACCESS_MODE`. It is unaffected by this feature.
4. Deploy; run one real low-value purchase and refund yourself before announcing.
5. Put notes for sale one at a time from the admin.

**Rollback.** Remove (or blank) the `RAZORPAY_*` variables: payments switch off at once, prices
stay visible, existing purchases keep working. The migration is additive and can stay in place.
Do not drop commerce tables once real orders exist — they are the financial record.

## 8. Known limits

* One currency (INR), one item per order, no coupons/discounts/tax lines.
* Refunds are whole-order (full remaining or an explicit partial amount); there is no per-item refund.
* Razorpay's "authorised but not captured" payments stay *pending* until captured or auto-refunded.
