/**
 * Runs once when the server starts. Used to surface configuration problems
 * loudly in the logs instead of letting them fail quietly at request time.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { productionConfigWarnings } = await import('@/lib/env');
  const problems = productionConfigWarnings();

  if (problems.length > 0) {
    console.warn('\n[cookie-notes] configuration warnings:');
    for (const problem of problems) console.warn(`  • ${problem}`);
    console.warn('');
  }
}
