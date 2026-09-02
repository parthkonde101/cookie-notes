# Cookie Notes

*Baked for exams.*

A college-notes library that reads like a product, not a portal.

The catalogue is **public**: anyone can browse semesters, subjects, units and note
titles without an account. Reading a note is what requires one — notes live in
private storage and open only inside the app's own reader, watermarked with the
reader's identity. Admins build the academic structure, upload notes, grant and
revoke access per student, and watch real usage analytics.

Built to be free to run today and to accept payments later without a rewrite.

---

## Contents

- [Stack](#stack)
- [Quick start](#quick-start)
- [How the product is laid out](#how-the-product-is-laid-out)
- [Environment variables](#environment-variables)
- [Open preview, and how to turn it off](#open-preview-and-how-to-turn-it-off)
- [How authorisation works](#how-authorisation-works)
- [Creating the first admin](#creating-the-first-admin)
- [Building your catalogue](#building-your-catalogue)
- [Granting access to friends](#granting-access-to-friends)
- [One account, one active session](#one-account-one-active-session)
- [Content protection — what is and is not guaranteed](#content-protection--what-is-and-is-not-guaranteed)
- [Analytics](#analytics)
- [Project layout](#project-layout)
- [Scripts](#scripts)
- [Verification](#verification)
- [Deployment](#deployment)
- [Adding payments](#adding-payments)
- [Before you go live](#before-you-go-live)

---

## Stack

| Layer     | Choice                                                                |
| --------- | --------------------------------------------------------------------- |
| Framework | Next.js 15 (App Router) + React 19 + TypeScript                       |
| Styling   | Tailwind CSS, shadcn-style primitives (Radix), cookie-brown dark theme|
| Database  | PostgreSQL 14+ via Prisma 7 with the `pg` driver adapter               |
| Auth      | Custom database-backed sessions, bcrypt password hashing              |
| Storage   | Pluggable private storage: local directory or any S3-compatible bucket |
| Charts    | Recharts                                                              |

Prisma runs with its **driver adapter**, so there is no Rust query-engine binary
to ship. Installs are small and deploys work unchanged on Vercel, Railway,
Render or a plain VPS.

---

## Quick start

Requirements: Node 20+ and a PostgreSQL 14+ database.

```bash
npm install

cp .env.example .env
# set DATABASE_URL, AUTH_SECRET and VIEW_TOKEN_SECRET
#   openssl rand -base64 32     # run twice, once per secret

npm run db:setup        # applies prisma/migrations without Prisma's engine binary
npm run db:verify       # optional: confirms the database matches the schema
npm run create:admin    # your admin account

npm run dev             # http://localhost:3000
```

The catalogue is empty on a fresh install — that is deliberate. Sign in, go to
**Admin → Notes**, and build your own structure. `npm run db:seed` creates no
content; it just reports the database status and tells you what to do next.

### Troubleshooting `npm install`

`prisma generate` (run by `postinstall`) downloads Prisma's schema-engine binary
from `binaries.prisma.sh` the first time. On a normal connection this just works.
If your network blocks that host you will see:

```
Error: Failed to fetch the engine file at https://binaries.prisma.sh/... - 403 Forbidden
```

The generated client itself is plain TypeScript and needs no binary at runtime —
only the CLI insists on fetching one. `prisma generate` never actually invokes the
schema engine for this project's generator, so pointing it at any existing file
satisfies the check and lets generation finish:

```bash
touch /tmp/no-engine && chmod +x /tmp/no-engine
export PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1
export PRISMA_SCHEMA_ENGINE_BINARY=/tmp/no-engine

npm install
npm run build
```

Both variables are listed, commented out, at the bottom of `.env.example`.

`src/generated/prisma` is git-ignored, so a fresh clone genuinely needs
`prisma generate` to run once before the app will build — `npm install
--ignore-scripts` alone is not enough. The commands that *do* need the real engine
are the ones that reshape the schema (`prisma migrate`, `prisma db push`,
`prisma studio`); `npm run db:setup`, `npm run db:verify` and `npm run reset:catalog`
talk to Postgres directly and never need it.

Re-run `npx prisma generate` after any change to `prisma/schema.prisma`.

### `db:setup` vs `db:migrate`

`npm run db:setup` applies the SQL in `prisma/migrations/` directly through the
`pg` driver and records it in Prisma's own `_prisma_migrations` table. It needs
nothing but a database connection.

`npm run db:migrate` (`prisma migrate dev`) is the normal Prisma workflow — use
it when you change `prisma/schema.prisma` and want a new migration generated.
Both write to the same table, so they stay in step.

---

## How the product is laid out

### Students and visitors

```
/                      the catalogue — semesters and their subjects   (public)
/subject/<slug>        one subject: units, topics, note cards         (public)
/notes/<id>            the protected reader                           (sign-in)
/account               name, email, college, programme, semester     (sign-in)
```

That is the whole student-facing surface. There is no dashboard, no separate
subjects page, no search page and no "my notes" — the catalogue is the product,
and it looks the same before and after signing in.

**Everyone sees the same catalogue.** It is not filtered by what an account owns.
What changes is the action on each note card:

| State                                 | Card shows    |
| ------------------------------------- | ------------- |
| Signed out                            | `Open`        |
| Signed in, entitled                   | `Open`        |
| Signed in, note marked FREE           | `Open`        |
| Signed in, open access on             | `Open`        |
| Signed in, not entitled (open access off) | *Unavailable* |

Nothing on a card mentions price, purchase, plans or *why* a note is or is not
open. A note the account cannot read is simply inert and labelled *Unavailable*;
everything else offers `Open`. Prices are still stored per note and still edited
in the admin — they are just not part of the student's view.

Clicking a note while signed out opens a sign-in / create-account modal in place —
no redirect to a separate page, and no copy explaining why it appeared — and drops
the visitor straight into the note once they are through.

### Admin

```
/admin              overview: KPIs, growth charts, most active students
/admin/users        accounts — and access, per user
/admin/users/<id>   profile, ACCESS (grant / view / revoke), sessions, activity
/admin/notes        the whole academic tree + uploads, in one screen
/admin/notes/<id>   one note: metadata, price, file replacement, usage
/admin/analytics    audience, growth, content and engagement
/admin/sessions     live and historical sessions, with remote termination
/admin/audit        append-only record of privileged actions
```

There is no standalone Access section and no Catalog section: access lives inside
Users, and content management lives inside Notes. Nothing is duplicated.

---

## Environment variables

Everything lives in `.env` (git-ignored). `.env.example` is the reference copy.

### Required

| Variable            | What it is                                                              |
| ------------------- | ----------------------------------------------------------------------- |
| `DATABASE_URL`      | PostgreSQL connection string.                                           |
| `AUTH_SECRET`       | Random 32-byte secret. `openssl rand -base64 32`                        |
| `VIEW_TOKEN_SECRET` | A **different** random secret; signs short-lived note-view tokens.       |
| `APP_URL`           | Public origin, e.g. `https://notes.yourdomain.com`.                     |

### Catalogue and pricing

| Variable                | Default | Meaning                                                       |
| ----------------------- | ------- | ------------------------------------------------------------- |
| `OPEN_ACCESS_MODE`      | `true`  | Open preview — see the next section.                          |
| `PRICE_CURRENCY_SYMBOL` | `₹`     | Symbol shown beside note prices. Display only.                |

### Storage

| Variable               | Default              | Notes                                                 |
| ---------------------- | -------------------- | ----------------------------------------------------- |
| `STORAGE_DRIVER`       | `local`              | `local` or `s3`.                                       |
| `STORAGE_LOCAL_DIR`    | `./.private-storage` | Outside `public/`, so Next never serves it statically. |
| `S3_BUCKET`            | —                    | Required when `STORAGE_DRIVER=s3`.                     |
| `S3_REGION`            | `auto`               | `auto` for Cloudflare R2.                              |
| `S3_ENDPOINT`          | —                    | e.g. `https://<account>.r2.cloudflarestorage.com`.     |
| `S3_ACCESS_KEY_ID`     | —                    |                                                       |
| `S3_SECRET_ACCESS_KEY` | —                    |                                                       |
| `S3_FORCE_PATH_STYLE`  | `true`               | `true` for R2/MinIO/Supabase, `false` for AWS S3.      |

### Behaviour

| Variable                 | Default | Meaning                                         |
| ------------------------ | ------- | ----------------------------------------------- |
| `SESSION_ABSOLUTE_HOURS` | `168`   | Hard session lifetime.                          |
| `SESSION_IDLE_MINUTES`   | `30`    | Inactivity before a session is considered dead. |
| `LIVE_WINDOW_MINUTES`    | `5`     | Recency that counts as "studying right now".    |
| `MAX_UPLOAD_MB`          | `50`    | Per-file upload limit.                          |
| `LOGIN_MAX_ATTEMPTS`     | `8`     | Failures before the account locks.              |
| `LOGIN_WINDOW_MINUTES`   | `15`    | Rate-limit window.                              |
| `LOCKOUT_MINUTES`        | `15`    | Lock duration.                                  |

### Email (password reset)

| Variable         | Default   | Meaning                                                                    |
| ---------------- | --------- | -------------------------------------------------------------------------- |
| `MAIL_DRIVER`    | `console` | `console` prints reset links to the server log. `resend` sends real email.  |
| `MAIL_FROM`      | —         | e.g. `Cookie Notes <no-reply@yourdomain.com>`                               |
| `RESEND_API_KEY` | —         | Required when `MAIL_DRIVER=resend`.                                         |

---

## Open preview, and how to turn it off

`OPEN_ACCESS_MODE=true` (the default) lets **any signed-in, active student open
any published note**, whether or not an entitlement covers it. It is how you run
free while you build an audience.

It is an *addition* to the authorisation chain, not a hole in it. With preview on,
all of this still holds:

- anonymous requests to a note are refused;
- the session must be live and the account active;
- the note must be `PUBLISHED` — drafts stay invisible;
- the content endpoint still demands a valid, short-lived, session-bound view token;
- every grant you make is still recorded, and still reported as the reason someone
  has access.

The check runs *after* entitlements (`src/lib/access/entitlements.ts`), so a real
grant is always attributed to the grant. Flip the flag to `false` and the platform
becomes strictly entitlement-gated — nothing else changes, no code edits, no
migration:

```bash
OPEN_ACCESS_MODE=false npm run build && OPEN_ACCESS_MODE=false npm run start
```

That is also the mode to run the verification suite in if you want the full
entitlement matrix asserted; see [Verification](#verification).

---

## How authorisation works

```
User ──< Entitlement >── Semester / Subject / Unit / Note
                              │
                              └── Note ── file in private storage
```

An entitlement says "this user may read everything under this target". Scopes are
`ALL`, `SEMESTER`, `SUBJECT`, `UNIT` and `NOTE`, so you can grant broadly or
precisely. Each row carries a source (`ADMIN_GRANT`, `PURCHASE`, `PROMO`,
`SIGNUP_BONUS`), an optional expiry, and an optional `orderId` for the future
payment flow.

`checkNoteAccess(userId, role, noteId)` is the one decision function. It runs
before metadata is shown, before a view token is issued, and **again** before any
bytes are streamed — which is why revoking access blocks the very next read, even
for a note already open on screen.

Serving a note takes four independent checks on every request:

1. a valid, live session cookie;
2. a short-lived HMAC view token whose signature, expiry, **user** and **session**
   all match;
3. a fresh entitlement lookup (plus the preview flag);
4. the note still exists and is published.

A student who guesses a note id and calls the API directly gets a 404 —
deliberately the same response as for a note that does not exist, so the endpoint
cannot be used to enumerate ids.

---

## Creating the first admin

No credentials exist anywhere in this repository.

```bash
npm run create:admin
```

It prompts for the email, name and password without echoing the password. Rules:
at least 10 characters, mixed case, a digit, a symbol, and nothing derived from
the email.

Non-interactively:

```bash
ADMIN_EMAIL=you@yourdomain.com ADMIN_PASSWORD='…' ADMIN_NAME='Your Name' npm run create:admin
```

Remove `ADMIN_PASSWORD` from the environment afterwards. Running it for an
existing email promotes that account to admin and resets its password — that is
the recovery path if you lock yourself out. Every admin created this way is
recorded in the audit log.

---

## Building your catalogue

Everything happens in **Admin → Notes**, on one screen.

1. **Semester** — the top level, e.g. "Semester 6".
2. **Subject** — e.g. "Machine Learning", code `CS601`.
3. **Unit** — e.g. "Unit 2 — Supervised Learning".
4. **Topic** *(optional)* — e.g. "Decision Trees".
5. **Upload note** — drop a PDF, set the title, description, placement, status,
   visibility and price.

Each level has its own inline "+" so you can add a unit or upload a note straight
into the row you are looking at, with the placement pre-filled. Nothing is created
until you ask for it, and the empty state walks you through the first semester.

Note options:

- **Status** — `Published` appears in the public catalogue; `Draft` is invisible
  to everyone but admins; `Archived` is retired.
- **Visibility** — `Restricted` needs a grant; `Free` opens for any signed-in
  student regardless of grants.
- **Price** — in whole currency units. `0` hides the price. Nothing charges
  against it yet; it exists so the paid model is visible while you are still free.

**Replacing a file:** open the note and use "Replace the file". The old version is
kept in version history and the new one is live immediately.

---

## Granting access to friends

This is the manual path that stands in for checkout today, and it is meant to
stay after payments arrive.

**Admin → Users → (pick a student) → Access**

Choose a scope — a whole semester, one subject, one unit, or a single note —
optionally set an expiry and an internal note ("paid via UPI", "trial"), and
grant. The table below shows every grant with what it covers, where it sits, who
granted it, when, when it expires, and whether it came from a manual grant or a
purchase. Revoke removes it immediately.

While `OPEN_ACCESS_MODE=true` your friends can read everything anyway — but the
grants you make are real, are recorded, and are exactly what keeps working the
moment you turn preview off.

---

## One account, one active session

An account may hold exactly one live session at a time.

- On sign-in, if a live session exists elsewhere, the login is refused with a 409
  and the UI shows which device holds it and when it was last active.
- The student can choose "sign out that device and continue"; the previous session
  is marked `SUPERSEDED` and its next request is rejected with an explanation.
- Admins can end any session from **Admin → Sessions** or a user's page.

"Live" means: status `ACTIVE`, inside the absolute lifetime, **and** activity
within `SESSION_IDLE_MINUTES`. A forgotten tab therefore never locks a student out
of their own account.

Each session records login time, last activity, logout time, IP, user agent, and
parsed browser / OS / device. A one-minute heartbeat keeps `lastActivityAt` fresh
and tells the client promptly when its session has been ended elsewhere.

---

## Content protection — what is and is not guaranteed

**What this genuinely does:**

- PDFs live in private storage. There is no public URL, ever — not even a signed
  read URL. Bytes are streamed only by an endpoint that re-checks the session and
  the entitlement.
- The reader rasterises pages with pdf.js onto a `<canvas>` instead of handing the
  file to the browser's PDF plugin. That removes the built-in download and print
  buttons and leaves no text layer to select or copy.
- The watermark — the reader's email, a session reference and the date — is drawn
  **into the page pixels**, tiled diagonally and repeated. It cannot be deleted
  with developer tools and it is present in any screenshot or screen recording.
- View authorisation is short-lived (three minutes) and bound to one user and one
  session, so a copied URL is useless almost immediately and useless entirely on
  another account.
- Responses are `no-store`, so nothing lands in the browser or proxy cache.
- Right-click, text selection and drag are disabled in the reader; `Ctrl/Cmd+P`
  and `Ctrl/Cmd+S` are intercepted; the content blurs when the window loses focus.
- Print attempts, screenshot key presses and focus loss are logged as
  `SUSPICIOUS_ACTIVITY` events against the user and note.

**What it cannot do — please read this before promising anything to customers:**

- **Screenshots and screen recordings cannot be prevented.** The operating system
  owns the screen. macOS ⌘⇧4, Windows Snipping Tool, a phone camera pointed at the
  monitor — none of these can be blocked by a website. We log the keyboard
  shortcuts we can observe, but a determined user will not be stopped.
- Disabling right-click and text selection is a speed bump, not a control. Anyone
  who opens developer tools can bypass both.
- A capable user can extract the rendered page images from the browser. What they
  get is watermarked with their own identity, which is the actual deterrent.

The realistic security model is **traceability, not prevention**: make casual
copying inconvenient, and make any leaked copy point back to the account it came
from.

---

## Analytics

Every meaningful action writes one row to `activity_events` through a single
helper (`recordEvent`). Recorded: registration, successful/failed/blocked logins,
logout, session creation/termination/expiry, password reset requested and
completed, catalogue viewed, subject opened, note opened/closed/paged, suspicious
activity, account created/disabled/enabled, note uploaded/updated/replaced/
deleted, access granted/revoked, user modified, catalogue modified.

Reading sessions get their own `note_views` rows with start, end, duration, last
page and deepest page. This is recorded for product analytics but is **not** shown
back to students — there are no progress bars, percentages or streaks in the
student UI.

`audit_logs` is separate and covers privileged actions only: who did what, to
whom, from which IP, with the relevant metadata.

Every figure on every admin dashboard comes from these tables. **There are no
seeded, sampled or placeholder numbers anywhere.** When a chart has nothing to
show it says so instead of drawing a plausible-looking line.

---

## Project layout

```
prisma/
  schema.prisma            the data model
  migrations/              plain SQL, applied by db:setup or prisma migrate
  seed.ts                  reports status; creates no content by design
scripts/
  apply-migrations.ts      engine-free migration runner  (db:setup)
  create-admin.ts          first-admin bootstrap          (create:admin)
  verify-schema.ts         database vs schema check       (db:verify)
  verify-flows.ts          end-to-end HTTP verification   (verify:flows)
  reset-catalog.ts         empties the catalogue only     (reset:catalog)
src/
  app/
    (public)/              the product: catalogue, subject pages, account
    (auth)/                login, register, forgot/reset password
    (reader)/notes/[id]/   the full-screen protected reader
    admin/                 admin panel
      _actions/            server actions (users, catalog, notes, access)
    api/                   auth, heartbeat, note view-token/content/events,
                           admin upload + presign, live stats
  components/
    catalog/note-card.tsx  the catalogue card and its three access states
                           (open / sign-in / unavailable — no pricing shown)
    auth/auth-modal.tsx    sign-in / register modal with return-to-note
    layout/site-header.tsx the single public header
    admin/                 admin shell, content manager, forms
    notes/note-viewer.tsx  pdf.js reader + watermarking + protections
    ui/                    shadcn-style primitives
  lib/
    catalog.ts             public catalogue queries
    access/entitlements.ts the authorisation engine + open-access mode
    auth/                  password hashing, sessions, guards, rate limiting
    storage/               private storage drivers (local, S3-compatible)
    analytics/             event recorder + dashboard queries
    admin/                 admin content tree, entitlement labels
  middleware.ts            edge-level redirect for the protected prefixes
```

---

## Scripts

| Command                | What it does                                    |
| ---------------------- | ----------------------------------------------- |
| `npm run dev`          | Development server                              |
| `npm run build`        | Production build (runs `prisma generate` first) |
| `npm run start`        | Production server                               |
| `npm run typecheck`    | `tsc --noEmit`                                   |
| `npm run lint`         | ESLint                                           |
| `npm run db:setup`     | Apply migrations without Prisma's engine binary |
| `npm run db:migrate`   | `prisma migrate dev` — after changing the schema |
| `npm run db:deploy`    | `prisma migrate deploy`                          |
| `npm run db:verify`    | Check the live database against the schema       |
| `npm run db:seed`      | Report database status (creates nothing)         |
| `npm run db:studio`    | Prisma Studio                                    |
| `npm run create:admin` | Create or promote an admin                       |
| `npm run reset:catalog`| Empty the catalogue — keeps users, grants, orders, analytics and audit |
| `npm run verify:flows` | End-to-end verification against a running server |

### Emptying the catalogue

```bash
npm run reset:catalog            # prints what it will do, then asks you to type RESET
npm run reset:catalog -- --yes   # no prompt, for scripts
npm run reset:catalog -- --keep-files   # drop the rows, leave the PDFs on disk
```

It deletes every semester, subject, unit, topic and note, plus the stored PDF for
each note and each retained version. It **keeps** users, sessions, entitlements,
orders, analytics events, audit logs, settings, the schema and the migrations.

One cascade is unavoidable: `entitlements.noteId` is a foreign key with
`ON DELETE CASCADE`, so a grant written against one specific note goes with that
note — there is nothing left for it to point at. Grants scoped to ALL, SEMESTER,
SUBJECT or UNIT survive. The script counts them for you before it commits, and
writes a `CONFIG_CHANGED` row to the audit log so an empty catalogue is never a
mystery six months later.

---

## Verification

```bash
npm run build && npm run start     # terminal 1
npm run verify:flows               # terminal 2
```

79 assertions against a live server with real cookies, a real database and real
files in storage: the public catalogue, registration, duplicate email, password
policy, the one-session rule, admin route protection, upload validation,
unauthorised access, view-token theft between accounts, draft invisibility,
suspension, analytics recording, the live user count, and audit logging. It cleans
up after itself.

The suite detects which access mode the server is in and asserts accordingly. To
exercise the strict entitlement matrix — including "revoking access blocks the
very next request" — run both sides in strict mode:

```bash
OPEN_ACCESS_MODE=false npm run build
OPEN_ACCESS_MODE=false npm run start          # terminal 1
OPEN_ACCESS_MODE=false npm run verify:flows   # terminal 2
```

Note that repeatedly signing in as the same account during testing will trip the
login rate limiter (8 attempts / 15 minutes). That is the limiter working; wait it
out or clear the `rate_limits` table.

---

## Deployment

The cheapest reliable setup, and the one this is built for:

| Piece    | Service            | Cost to start                |
| -------- | ------------------ | ---------------------------- |
| App      | Vercel             | free tier                    |
| Database | Neon (or Supabase) | free tier                    |
| Storage  | Cloudflare R2      | free tier, no egress fees    |

### 1. Database

Create a Neon project and copy the pooled connection string.

### 2. Storage

Create a **private** R2 bucket (no public access, no custom domain) and an API
token with object read/write on it. Note the account-scoped endpoint,
`https://<account-id>.r2.cloudflarestorage.com`.

Local disk storage will not work on Vercel: the filesystem is read-only and
ephemeral, so uploads vanish on the next deploy. Use S3-compatible storage there.
A VPS or Railway volume can keep `STORAGE_DRIVER=local`.

### 3. Environment variables

Add everything from [Environment variables](#environment-variables) to the Vercel
project. Generate fresh secrets — do not reuse your development ones:

```bash
openssl rand -base64 32   # AUTH_SECRET
openssl rand -base64 32   # VIEW_TOKEN_SECRET
```

Set `APP_URL` to your real https origin, `STORAGE_DRIVER=s3`, and the S3 settings
(`S3_FORCE_PATH_STYLE=true` for R2).

### 4. Deploy and migrate

Push to GitHub and import the repo into Vercel. Build command is `npm run build`.
After the first deploy, apply the schema once from your machine with the
production `DATABASE_URL`:

```bash
DATABASE_URL='postgres://…neon…' npm run db:setup
DATABASE_URL='postgres://…neon…' npm run db:verify
DATABASE_URL='postgres://…neon…' npm run create:admin
```

### 5. Test production

- Open `/` signed out — the catalogue should load with no login wall.
- Sign in as the admin; build a semester, a subject and a unit; upload a PDF.
- Open `/` again — the subject appears; open the note and confirm the watermark
  shows your email.
- Register a student in a private window; confirm they see the same catalogue.
- Grant them a subject in **Admin → Users**; the card looks the same either way —
  confirm the grant itself in **Admin → Users → that student → Access**.
- Sign in as that student on a second device; confirm the session-conflict dialog.
- Check **Admin → Audit log** for the upload, the grant and the revoke.

The app logs configuration warnings at boot — check the deploy logs for lines
starting with `[cookie-notes]`.

---

## Adding payments

The data model is already shaped for it. `Order` exists, `Entitlement.orderId`
points at it, and `Note.priceMinor` already drives what the catalogue displays.

```
Student → Payment → Order → Entitlement → Access
```

To add Razorpay:

1. Give the *Unavailable* state on the note card an action again (or add a
   dedicated checkout entry point) that creates an `Order` row
   (`status: CREATED`, `amountMinor: note.priceMinor`, `provider: 'razorpay'`,
   `providerOrderId`). Note that the student surface currently shows no pricing
   at all — bringing prices back is a deliberate UI decision, not a code change:
   `note.priceMinor` and `formatPrice()` are still there.
2. In the payment webhook, verify the signature, set the order to `PAID`, and call
   the existing `grantEntitlement()` with `source: 'PURCHASE'`, the `orderId`, and
   an `expiresAt` if the plan is time-limited.
3. Set `OPEN_ACCESS_MODE=false`.

Nothing in the reader, the catalogue or the access checks changes — they already
read entitlements, already honour expiry dates, and already render the
purchase-required state. Coupons, subscription plans and semester bundles all sit
on the same table.

---

## Before you go live

- [ ] Fresh `AUTH_SECRET` and `VIEW_TOKEN_SECRET`, different from each other.
- [ ] `STORAGE_DRIVER=s3` with a **private** bucket, unless you have a persistent disk.
- [ ] `APP_URL` set to the real https origin (session cookies are `secure` in production).
- [ ] Decide on `OPEN_ACCESS_MODE`. `true` is right while you are free; set it to
      `false` the day you start charging.
- [ ] `MAIL_DRIVER=resend` with a verified domain, if students will reset their own passwords.
- [ ] `.env` is not committed (it is git-ignored — keep it that way).
- [ ] Admin account created via `npm run create:admin`.
- [ ] A backup schedule on the database.
- [ ] Read [Content protection](#content-protection--what-is-and-is-not-guaranteed)
      before making any promise to a paying customer about screenshots.

### Known gaps, stated plainly

- **No payment processing.** The data model is ready and prices are stored and
  editable in the admin, but nothing charges against them and the student surface
  deliberately shows no pricing at all. A note an account cannot read is simply
  labelled *Unavailable* and does nothing when clicked.
- **Email verification is not implemented.** Anyone can register with any address.
  Fine while access is granted manually; add verification before public paid
  sign-ups.
- **Password reset needs a mail provider.** With `MAIL_DRIVER=console` the link is
  printed to the server log, not sent.
- **No student-facing search.** V2 focuses on browsing the hierarchy. The admin
  Notes screen has a filter; a student search can be added later against the same
  data.
- **Rate limiting** is fixed-window and database-backed. It stops casual abuse and
  credential stuffing; it is not a WAF. Put Cloudflare in front for real traffic.
- **No background job runner.** Expired sessions are cleaned up lazily on access
  rather than by a scheduled sweep.
