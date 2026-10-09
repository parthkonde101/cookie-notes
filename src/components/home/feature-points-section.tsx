import { BookOpenCheck, ScanEye, ShieldCheck } from 'lucide-react';

const POINTS = [
  {
    icon: BookOpenCheck,
    title: 'Every subject, one shelf',
    description: 'Semester by semester, B.Tech and Polytechnic notes in one place.',
  },
  {
    icon: ScanEye,
    title: 'Read in the app',
    description: 'Notes open in a protected reader — no download, no copy-paste.',
  },
  {
    icon: ShieldCheck,
    title: 'MIT-WPU only',
    description: 'Verified with your college email, so the shelf stays for us.',
  },
];

export function FeaturePointsSection() {
  return (
    <section className="mx-auto w-full max-w-5xl px-4 py-14 sm:px-6 sm:py-16">
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
        {POINTS.map(({ icon: Icon, title, description }) => (
          <div
            key={title}
            className="rounded-lg border border-border bg-card p-5 text-center sm:text-left"
          >
            <span className="mx-auto flex size-9 items-center justify-center rounded-md bg-primary/12 text-primary ring-1 ring-inset ring-primary/25 sm:mx-0">
              <Icon className="size-4" />
            </span>
            <h3 className="mt-3 text-sm font-semibold tracking-tight">{title}</h3>
            <p className="mt-1.5 text-sm text-muted-foreground">{description}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
