import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * This project's own directory.
 *
 * Next.js infers a "workspace root" by walking up looking for lockfiles. If
 * there is an unrelated package-lock.json in a parent directory (a home folder
 * with its own project in it, say), Next finds two lockfiles, warns, and may
 * pick the wrong root — which makes standalone output trace files from outside
 * this project.
 *
 * Deriving the root from this file's own location pins it correctly on every
 * machine: the developer's laptop, CI and the production host alike. Hardcoding
 * an absolute path would fix one machine and break the rest.
 */
const projectRoot = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  // Never look above this directory for a lockfile or for files to trace.
  outputFileTracingRoot: projectRoot,

  // The Prisma client and the pg driver are Node-only.
  serverExternalPackages: ['@prisma/client', '@prisma/adapter-pg', 'pg', 'bcryptjs'],

  experimental: {
    serverActions: {
      // Note uploads go through a route handler, not a server action, but keep a
      // sane limit for form-heavy admin actions.
      bodySizeLimit: '2mb',
    },
  },

  async headers() {
    const isProd = process.env.NODE_ENV === 'production';
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
          },
          ...(isProd
            ? [
                {
                  key: 'Strict-Transport-Security',
                  value: 'max-age=63072000; includeSubDomains; preload',
                },
              ]
            : []),
        ],
      },
      {
        // Never let a proxy or the browser cache protected note bytes.
        source: '/api/notes/:path*',
        headers: [
          { key: 'Cache-Control', value: 'no-store, no-cache, must-revalidate, private' },
          { key: 'Pragma', value: 'no-cache' },
        ],
      },
    ];
  },
};

export default nextConfig;
