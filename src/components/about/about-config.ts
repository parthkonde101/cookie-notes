/**
 * The two things on the About page that are facts about a person rather than
 * copy: how to reach them, and what they look like.
 *
 * Nothing here is invented. A value that hasn't been supplied is `null`, and
 * the page renders a clearly-marked placeholder in its place — so a missing
 * link can never turn into a plausible-looking wrong one. Every link is
 * currently set.
 */

export interface ContactLink {
  /** Used for the accessible name and tooltip: "Instagram", "LinkedIn", "Email". */
  label: string;
  /** Full URL, or `mailto:` for email. `null` until supplied. */
  href: string | null;
}

export const CONTACT_LINKS: {
  instagram: ContactLink;
  linkedin: ContactLink;
  email: ContactLink;
} = {
  instagram: { label: 'Instagram', href: 'https://www.instagram.com/parth_konde/' },
  linkedin: { label: 'LinkedIn', href: 'https://www.linkedin.com/in/parth-konde-b914072a2' },
  email: { label: 'Email', href: 'mailto:parthkonde101@gmail.com' },
};

/** `null` renders a monogram panel instead of a photo. */
export const FOUNDER_PHOTO: { src: string; alt: string } | null = {
  src: '/parth-konde.jpg',
  alt: 'Parth Konde smiling, with a ginger cat perched on his shoulder',
};
