import type { Metadata, Viewport } from 'next';
import { Lora } from 'next/font/google';
import { Toaster } from 'sonner';
import './globals.css';

// Used only by the feedback letter (`src/components/feedback/feedback-letter.tsx`)
// — everything else stays on the system sans stack. Self-hosted by Next at
// build time via `next/font`, so there is no runtime request to Google Fonts.
const letterFont = Lora({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  style: ['normal', 'italic'],
  variable: '--font-letter',
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'Cookie Notes — baked for exams',
    template: '%s · Cookie Notes',
  },
  description: 'Cookie Notes. Baked for exams.',
  robots: { index: false, follow: false },
  icons: { icon: '/favicon.svg' },
};

export const viewport: Viewport = {
  themeColor: '#0f0d0a',
  width: 'device-width',
  // The page is laid out for the device width and stays at that scale: no zoom
  // in when a field is focused, and no zoom out to fit something that overflows.
  initialScale: 1,
  minimumScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`dark ${letterFont.variable}`} suppressHydrationWarning>
      <body className="min-h-dvh bg-background">
        {children}
        <Toaster
          theme="dark"
          position="top-center"
          toastOptions={{
            classNames: {
              toast: 'border border-border bg-card text-card-foreground',
            },
          }}
        />
        <div className="print-notice hidden">
          Cookie Notes content is not available for printing.
        </div>
      </body>
    </html>
  );
}
