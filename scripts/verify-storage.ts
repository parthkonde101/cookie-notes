/**
 * Verifies the S3/R2 storage driver's presigned upload contract.
 *
 *   npm run verify:storage
 *
 * This is a *structural* check — it signs URLs with throwaway credentials
 * against a fake endpoint and never touches the network, so it is safe to run
 * anywhere, including CI, with no real bucket or secrets.
 *
 * It exists because of a specific production failure. From v3.729 the AWS SDK
 * calculates an integrity checksum for PutObject by default. When the body is
 * present that is correct and useful. When the URL is *presigned* there is no
 * body yet, so the SDK hashes nothing and pins `x-amz-checksum-crc32=AAAAAA==`
 * — the CRC32 of an empty payload — into the signed URL. The browser then PUTs
 * a real PDF, the stored checksum cannot match, and Cloudflare R2 rejects the
 * upload. In the browser that surfaces only as a failed cross-origin request,
 * which is close to undiagnosable from the UI.
 *
 * The driver opts out with requestChecksumCalculation: 'WHEN_REQUIRED'. These
 * assertions fail if that ever regresses — including via an SDK upgrade, which
 * is how it arrived in the first place.
 */
import 'dotenv/config';

// The storage modules are marked `server-only`, which throws outside a React
// Server Component. Neutralise the marker before importing them.
const serverOnly = require.resolve('server-only');
require.cache[serverOnly] = {
  id: serverOnly,
  filename: serverOnly,
  loaded: true,
  exports: {},
} as NodeJS.Module;

// Configure the driver before `env` is first read — its getters are lazy.
process.env.STORAGE_DRIVER = 's3';
process.env.S3_BUCKET = 'cookie-notes';
process.env.S3_REGION = 'auto';
process.env.S3_ENDPOINT = 'https://verifyaccount.r2.cloudflarestorage.com';
process.env.S3_ACCESS_KEY_ID = 'verify-access-key-id';
process.env.S3_SECRET_ACCESS_KEY = 'verify-secret-not-a-real-credential';
process.env.S3_FORCE_PATH_STYLE = 'true';

let passed = 0;
const failures: string[] = [];

function check(label: string, ok: boolean, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failures.push(label);
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  const { S3StorageDriver } = await import('../src/lib/storage/s3');
  const driver = new S3StorageDriver();

  console.log('\nStorage — presigned upload contract\n' + '─'.repeat(52));

  const signed = await driver.presignUpload('notes/2026/09/example.pdf', 'application/pdf', 300);
  const url = new URL(signed);
  const params = url.searchParams;

  console.log('\n\x1b[1mURL shape\x1b[0m');
  check('presigns against the configured endpoint', url.host === 'verifyaccount.r2.cloudflarestorage.com', url.host);
  check(
    'uses path-style addressing (bucket in the path)',
    url.pathname === '/cookie-notes/notes/2026/09/example.pdf',
    url.pathname,
  );
  check('is https', url.protocol === 'https:', url.protocol);

  console.log('\n\x1b[1mSignature\x1b[0m');
  check('uses SigV4', params.get('X-Amz-Algorithm') === 'AWS4-HMAC-SHA256');
  check('scopes the credential to region "auto" (R2 requires it)', /\/auto\/s3\/aws4_request$/.test(params.get('X-Amz-Credential') ?? ''));
  check('is short-lived', params.get('X-Amz-Expires') === '300', `${params.get('X-Amz-Expires')}s`);
  check('signs an unsigned payload (the body arrives later)', params.get('X-Amz-Content-Sha256') === 'UNSIGNED-PAYLOAD');

  console.log('\n\x1b[1mChecksum behaviour — the regression this file guards\x1b[0m');
  const checksumParams = [...params.keys()].filter((key) => /checksum/i.test(key));
  check(
    'no checksum parameters are pinned into the URL',
    checksumParams.length === 0,
    checksumParams.join(', '),
  );
  check(
    'no empty-body CRC32 is pinned (AAAAAA== would reject every real upload)',
    params.get('x-amz-checksum-crc32') === null,
    String(params.get('x-amz-checksum-crc32')),
  );
  check(
    'the browser is not asked to reproduce SDK checksum headers',
    !(params.get('X-Amz-SignedHeaders') ?? '').includes('checksum'),
    params.get('X-Amz-SignedHeaders') ?? '',
  );

  console.log('\n\x1b[1mSafety\x1b[0m');
  check(
    'the signature is present',
    Boolean(params.get('X-Amz-Signature')),
  );
  check(
    'the secret access key never appears in the URL',
    !signed.includes(process.env.S3_SECRET_ACCESS_KEY!),
  );

  check(
    'the URL is write-only for one object (no read verb in the query)',
    !/GetObject/i.test(signed),
  );

  // SigV4 presigning is deterministic for a given key, clock second and expiry,
  // so identical input must not be expected to differ. What must hold is that
  // the signature is bound to the object key: a URL minted for one note can
  // never be replayed against another.
  const other = await driver.presignUpload('notes/2026/09/different.pdf', 'application/pdf', 300);
  check(
    'the signature is bound to the object key',
    new URL(other).searchParams.get('X-Amz-Signature') !== params.get('X-Amz-Signature'),
  );

  console.log('\n' + '─'.repeat(52));
  if (failures.length === 0) {
    console.log(`\x1b[32m${passed} checks passed.\x1b[0m\n`);
  } else {
    console.log(`\x1b[31m${failures.length} failed\x1b[0m of ${passed + failures.length}:`);
    for (const failure of failures) console.log(`  • ${failure}`);
    console.log(
      '\nIf the checksum checks failed, the AWS SDK is pinning an integrity checksum into\n' +
        'presigned URLs again. Confirm requestChecksumCalculation is still set to\n' +
        "'WHEN_REQUIRED' in src/lib/storage/s3.ts.\n",
    );
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('\nverify:storage failed to run:', error instanceof Error ? error.message : error);
  process.exit(1);
});
