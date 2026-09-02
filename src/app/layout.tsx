import type { Metadata, Viewport } from 'next';
import { Toaster } from 'sonner';
import './globals.css';

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
  initialScale: 1,
  maximumScale: 5,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
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
