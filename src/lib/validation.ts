import { z } from 'zod';

/** Shared request/form schemas. Every mutating endpoint parses its input here. */

export const emailSchema = z
  .string()
  .trim()
  .min(3, 'Enter your email address.')
  .max(254)
  .email('Enter a valid email address.')
  .transform((value) => value.toLowerCase());

// ---------------------------------------------------------------------------
// College email policy
// ---------------------------------------------------------------------------

/**
 * The only domain new student accounts may use.
 *
 * Compared for exact equality after canonicalisation — never with `includes`
 * or `endsWith`. A substring test would admit `fake-mitwpu.edu.in`, and
 * `endsWith` would admit `notmitwpu.edu.in`; both look like the real thing to a
 * careless check and neither is the university.
 */
export const STUDENT_EMAIL_DOMAIN = 'mitwpu.edu.in';

/**
 * Canonical email comparison policy.
 *
 * The address is trimmed and lowercased in full — including the local part.
 * Lowercasing the local part is technically a transformation the RFC does not
 * require, and it is done here for one specific reason: `emailSchema` has
 * always done it, so every address already in the database is stored that way
 * and `users.email` is unique on that basis. Changing it now would strand
 * existing accounts, so the existing policy is kept and made explicit rather
 * than quietly revised.
 *
 * No provider-specific handling is applied: dots are not stripped, `+tags` are
 * not removed. Two addresses that differ in those ways are different accounts.
 *
 * The domain is whatever follows the LAST `@`, because that is the only part a
 * mail server routes on.
 */
export function canonicalEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function emailDomain(value: string): string {
  const at = canonicalEmail(value).lastIndexOf('@');
  return at === -1 ? '' : canonicalEmail(value).slice(at + 1);
}

export function isStudentEmail(value: string): boolean {
  return emailDomain(value) === STUDENT_EMAIL_DOMAIN;
}

/**
 * Email for a NEW student registration.
 *
 * Deliberately separate from `emailSchema`. The shared schema is used by login
 * and password reset, and adding the domain rule there would lock out every
 * account that predates this policy — including the admin — the moment it
 * shipped. The restriction belongs to sign-up alone.
 */
export const studentEmailSchema = emailSchema.refine(isStudentEmail, {
  message: `Use your MIT-WPU email address (@${STUDENT_EMAIL_DOMAIN}).`,
});

export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters.')
  .max(128, 'Password is too long.');

/** A six-digit verification code, as typed (spaces and dashes forgiven). */
export const otpCodeSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/[\s-]/g, ''))
  .pipe(z.string().regex(/^\d{6}$/, 'Enter the 6-digit code from your email.'));

/**
 * A new student account.
 *
 * Name, college email, password. That is the whole identity requirement.
 *
 * Two things were deliberately removed rather than made optional:
 *
 * PRN, because nothing in the product uses it — it was self-declared, proved
 * nothing, and asking for a student number the application then ignores is
 * collecting personal data for no reason.
 *
 * The terms and data-use checkboxes, because their wording has not been
 * professionally reviewed. A checkbox that says "I agree to the Terms" when
 * there are no approved terms records an agreement to nothing; it would be
 * worse than not asking. The columns stay in the database, NULL, until a
 * reviewed notice exists.
 *
 * Every rule here is enforced on the server. The form mirrors them for a decent
 * experience, but a request posted straight to the API meets exactly the same
 * schema — a disabled button is not a control.
 */
export const registerSchema = z
  .object({
    name: z.string().trim().min(2, 'Enter your full name.').max(80),
    email: studentEmailSchema,
    password: passwordSchema,
    confirmPassword: z.string(),
    college: z.string().trim().max(120).optional().or(z.literal('')),
    program: z.string().trim().max(120).optional().or(z.literal('')),
    semester: z.coerce.number().int().min(1).max(12).optional(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match.',
    path: ['confirmPassword'],
  });

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password.'),
  /** Set when the user confirms "sign out my other device and continue". */
  force: z.boolean().optional().default(false),
  /**
   * "Keep me signed in". Only ever a boolean — the lifetime it maps to is a
   * server constant, never something the client can name.
   */
  rememberMe: z.boolean().optional().default(false),
});

/** Submitting a code, or asking for another one. */
export const verifyEmailSchema = z.object({
  email: emailSchema,
  code: otpCodeSchema,
});

export const resendCodeSchema = z.object({
  email: emailSchema,
});

/**
 * An existing student moving to a college address.
 *
 * Only the NEW address is constrained — the account's current one may be on any
 * domain, which is the entire reason this migration exists. There is no user
 * identifier here on purpose: the account being changed comes from the session,
 * never from the request.
 */
export const requestEmailChangeSchema = z.object({
  email: studentEmailSchema,
});

export const confirmEmailChangeSchema = z.object({
  code: otpCodeSchema,
});

export const forgotPasswordSchema = z.object({ email: emailSchema });

export const resetPasswordSchema = z
  .object({
    token: z.string().min(10),
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match.',
    path: ['confirmPassword'],
  });

export const noteEventSchema = z.object({
  type: z.enum(['open', 'heartbeat', 'close', 'page', 'suspicious']),
  viewId: z.string().optional(),
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  pageCount: z.coerce.number().int().min(1).max(10_000).optional(),
  durationMs: z.coerce.number().int().min(0).max(86_400_000).optional(),
  signal: z.string().max(64).optional(),
});

// --- Admin ----------------------------------------------------------------

export const semesterSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(400).optional().or(z.literal('')),
  position: z.coerce.number().int().min(0).max(99).optional().default(0),
  /*
   * Which catalogue this semester joins.
   *
   * A semester is the only row that carries a program, so this is the one
   * place the value is written rather than derived — everything below it
   * inherits. Optional so an older client, or a call that predates the
   * program axis, still creates a valid semester; the action falls back to
   * B.Tech, which is what the column defaults to anyway.
   */
  program: z.enum(['BTECH', 'POLYTECHNIC']).optional(),
});

export const subjectSchema = z.object({
  semesterId: z.string().min(1, 'Choose a semester.'),
  name: z.string().trim().min(2).max(120),
  code: z.string().trim().max(24).optional().or(z.literal('')),
  description: z.string().trim().max(400).optional().or(z.literal('')),
  position: z.coerce.number().int().min(0).max(99).optional().default(0),
});

export const unitSchema = z.object({
  subjectId: z.string().min(1, 'Choose a subject.'),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(400).optional().or(z.literal('')),
  position: z.coerce.number().int().min(0).max(99).optional().default(0),
});

export const topicSchema = z.object({
  unitId: z.string().min(1, 'Choose a unit.'),
  name: z.string().trim().min(1).max(120),
  position: z.coerce.number().int().min(0).max(99).optional().default(0),
});

/**
 * A new PDF going into a unit.
 *
 * Deliberately smaller than `noteMetadataSchema`: there is no title (it is taken
 * from the unit) and no topic, and the unit is required — one unit, one PDF, so
 * a PDF with nowhere to sit is not a thing the upload flow can produce.
 */
export const noteUploadSchema = z.object({
  subjectId: z.string().min(1, 'Choose a subject.'),
  unitId: z.string().min(1, 'Choose the unit this PDF belongs to.'),
  status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).default('PUBLISHED'),
  visibility: z.enum(['FREE', 'RESTRICTED']).default('RESTRICTED'),
  /** Major units in the form (rupees); stored as minor units (paise). */
  price: z.coerce.number().min(0).max(100000).optional().default(0),
});

/**
 * Everything an existing note carries. Still accepts `title`, `description` and
 * `topicId` because notes filed under the older model have them and the edit
 * screen has to be able to repair those rows.
 */
export const noteMetadataSchema = z.object({
  title: z.string().trim().min(2, 'Give the note a title.').max(160),
  description: z.string().trim().max(1000).optional().or(z.literal('')),
  subjectId: z.string().min(1, 'Choose a subject.'),
  unitId: z.string().optional().or(z.literal('')),
  topicId: z.string().optional().or(z.literal('')),
  status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).default('PUBLISHED'),
  visibility: z.enum(['FREE', 'RESTRICTED']).default('RESTRICTED'),
  /** Major units in the form (rupees); stored as minor units (paise). */
  price: z.coerce.number().min(0).max(100000).optional().default(0),
});

export const adminUserSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: emailSchema,
  password: passwordSchema,
  role: z.enum(['STUDENT', 'ADMIN']).default('STUDENT'),
  college: z.string().trim().max(120).optional().or(z.literal('')),
  program: z.string().trim().max(120).optional().or(z.literal('')),
  semester: z.coerce.number().int().min(1).max(12).optional(),
});

export const grantSchema = z.object({
  userId: z.string().min(1, 'Choose a student.'),
  scope: z.enum(['ALL', 'SEMESTER', 'SUBJECT', 'UNIT', 'NOTE']),
  targetId: z.string().optional().or(z.literal('')),
  expiresAt: z.string().optional().or(z.literal('')),
  note: z.string().trim().max(280).optional().or(z.literal('')),
});

export function firstError(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'Please check the form and try again.';
}
