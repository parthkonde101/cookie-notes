import { z } from 'zod';

/** Shared request/form schemas. Every mutating endpoint parses its input here. */

export const emailSchema = z
  .string()
  .trim()
  .min(3, 'Enter your email address.')
  .max(254)
  .email('Enter a valid email address.')
  .transform((value) => value.toLowerCase());

export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters.')
  .max(128, 'Password is too long.');

export const registerSchema = z
  .object({
    name: z.string().trim().min(2, 'Enter your full name.').max(80),
    email: emailSchema,
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
