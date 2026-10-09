import Image from 'next/image';
import { Instagram, Linkedin, Mail } from 'lucide-react';
import { CONTACT_LINKS, FOUNDER_PHOTO, type ContactLink } from '@/components/about/about-config';

const NAME = 'Parth Konde';
const ROLE = 'Founder & Creator, Cookie Notes';
const STATEMENT =
  'Building Cookie Notes is my attempt to turn something that started with sharing notes among classmates into a platform that makes exam preparation simpler, more focused, and less overwhelming.';

const ICON_BASE =
  'flex size-11 shrink-0 items-center justify-center rounded-full border transition-colors';

function Portrait() {
  return (
    <div className="relative aspect-[4/5] w-full max-w-[18rem] shrink-0 overflow-hidden rounded-2xl border border-border bg-card shadow-sm sm:w-72 sm:max-w-none">
      {FOUNDER_PHOTO ? (
        <Image
          src={FOUNDER_PHOTO.src}
          alt={FOUNDER_PHOTO.alt}
          fill
          sizes="(min-width: 1024px) 288px, 70vw"
          className="object-cover"
        />
      ) : (
        <>
          <div aria-hidden className="hero-glow absolute inset-0" />
          <div
            role="img"
            aria-label={`Portrait placeholder for ${NAME}`}
            className="relative flex h-full items-center justify-center"
          >
            <span className="font-letter text-7xl font-medium tracking-tight text-primary/80">
              PK
            </span>
          </div>
        </>
      )}
      <div
        aria-hidden
        className="absolute inset-0 rounded-2xl ring-1 ring-inset ring-foreground/5"
      />
    </div>
  );
}

/**
 * One icon, one destination. Icon-only on purpose, so each needs a real
 * accessible name — and a link that hasn't been supplied yet renders as a
 * dashed, plainly-labelled placeholder rather than as a plausible-looking guess.
 */
function SocialIcon({
  icon: Icon,
  link,
  external,
}: {
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  link: ContactLink;
  external: boolean;
}) {
  if (link.href) {
    const name = `${NAME} on ${link.label}`;
    const label = link.label === 'Email' ? `Email ${NAME}` : name;
    return (
      <a
        href={link.href}
        aria-label={external ? `${label} (opens in a new tab)` : label}
        title={label}
        {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
        className={`${ICON_BASE} border-border bg-card text-muted-foreground hover:border-primary/50 hover:bg-secondary hover:text-primary`}
      >
        <Icon aria-hidden className="size-[18px]" />
      </a>
    );
  }

  return (
    <span
      role="img"
      data-placeholder
      aria-label={`${link.label} link not set yet (placeholder)`}
      title={`${link.label} — placeholder, link not set yet`}
      className={`${ICON_BASE} border-dashed border-border bg-card/40 text-muted-foreground/60`}
    >
      <Icon aria-hidden className="size-[18px]" />
    </span>
  );
}

export function FounderSection() {
  const anyPlaceholder = Object.values(CONTACT_LINKS).some((link) => !link.href);

  return (
    <section aria-labelledby="creator-heading" className="border-t border-border">
      <div className="mx-auto w-full max-w-5xl px-4 py-20 sm:px-6 sm:py-28">
        <h2
          id="creator-heading"
          className="text-balance text-center text-3xl font-semibold leading-[1.15] tracking-tight sm:text-4xl"
        >
          The Mind Behind Cookie Notes
        </h2>

        {/* One centred group — photo, icons, then the person — that stacks on a
            phone and sits side by side from `lg`, instead of spreading to the
            edges of the page. */}
        <div className="mt-12 flex flex-col items-center gap-8 lg:flex-row lg:justify-center lg:gap-10">
          <Portrait />

          <ul aria-label={`Contact ${NAME}`} className="flex gap-3 lg:flex-col">
            <li>
              <SocialIcon icon={Instagram} link={CONTACT_LINKS.instagram} external />
            </li>
            <li>
              <SocialIcon icon={Linkedin} link={CONTACT_LINKS.linkedin} external />
            </li>
            <li>
              <SocialIcon icon={Mail} link={CONTACT_LINKS.email} external={false} />
            </li>
          </ul>

          <div className="min-w-0 max-w-md text-center lg:text-left">
            <p className="text-2xl font-semibold tracking-tight sm:text-3xl">{NAME}</p>
            <p className="mt-1.5 text-sm font-medium uppercase tracking-[0.14em] text-primary">
              {ROLE}
            </p>

            <blockquote className="mt-7 lg:border-l-2 lg:border-primary/60 lg:pl-6">
              <p className="text-balance font-letter text-xl leading-relaxed text-foreground sm:text-2xl sm:leading-relaxed">
                {STATEMENT}
              </p>
            </blockquote>
          </div>
        </div>

        {anyPlaceholder && (
          <p className="mt-8 text-center text-xs text-muted-foreground">
            Placeholder icons — links not set yet.
          </p>
        )}
      </div>
    </section>
  );
}
