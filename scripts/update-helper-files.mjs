// Paths relative to the app root. Preserve this layout in the detached directory:
// the helper's static imports must survive both source-clone and app replacement.
export const UPDATE_HELPER_FILES = [
  "scripts/apply-update.mjs",
  "scripts/update-helper-runtime.mjs",
  "scripts/update-helper-files.mjs",
  "scripts/install-staged-app.mjs",
  "src/shared/binary-distribution.mjs",
  "src/shared/owned-runtime.mjs",
  "src/shared/install-receipt.mjs",
  "src/shared/harness-runtime.mjs",
  "scripts/app-bundle-swap.mjs",
  "scripts/update-lock.mjs",
  "scripts/install-migration.mjs",
  "scripts/migration-runtime.mjs",
  "scripts/install-destination.mjs",
  "src/shared/install-receipt-schema.mjs",
  "src/shared/update-source.mjs",
  "src/shared/staged-bundle.mjs",
];
