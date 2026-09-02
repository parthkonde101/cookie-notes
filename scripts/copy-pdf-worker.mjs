// Copies the pdf.js worker into /public so the viewer can load it from a same-origin
// URL. The worker is library code (not user content), so it is safe to serve publicly.
import { copyFile, mkdir, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

async function main() {
  try {
    const entry = require.resolve('pdfjs-dist/package.json');
    const pkgDir = path.dirname(entry);
    const src = path.join(pkgDir, 'build', 'pdf.worker.min.mjs');
    await access(src);
    const destDir = path.join(process.cwd(), 'public', 'vendor');
    await mkdir(destDir, { recursive: true });
    await copyFile(src, path.join(destDir, 'pdf.worker.min.mjs'));
    console.log('[copy-pdf-worker] public/vendor/pdf.worker.min.mjs written');
  } catch (err) {
    console.warn('[copy-pdf-worker] skipped:', err instanceof Error ? err.message : err);
  }
}

main();
