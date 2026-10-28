// Used only by the dry-run harness. There is no production fault-injection flag.
import { resolve } from 'node:path';

if (process.argv[1] === resolve('scripts/package-distribution.mjs')) {
  const {fixture, installDistributionFixture, restoreDistributionFixture} = await import('../helpers/distribution-packaging.ts');
  const cleanups: Array<() => unknown> = [];
  installDistributionFixture();
  const f = fixture({after: (fn: () => unknown) => { cleanups.push(fn); }} as any, process.env.MISSION_DISTRIBUTION_FIXTURE_STAGE);
  Object.assign(process.env, f.env);
  // Resolve the production entry point before changing to the disposable checkout.
  process.argv[1] = resolve('scripts/package-distribution.mjs');
  process.chdir(f.root);
  const {TmpDir} = await import('temp-file');
  await new TmpDir().getTempFile({suffix: 'exit-hook-regression'});
  process.on('exit', () => {
    restoreDistributionFixture();
    for (const cleanup of cleanups) cleanup();
  });
}
