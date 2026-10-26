// A standalone download must carry its trust root before any candidate can execute.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { binaryPublisherPolicy, BINARY_MANIFEST_NAME, MAX_BINARY_MANIFEST_BYTES } from '../src/shared/binary-publisher-policy.mjs';
import { MAX_BINARY_ASSET_BYTES } from '../src/shared/binary-distribution.mjs';

export function renderInstallBootstrap() {
  const policy = binaryPublisherPolicy();
  const values = {REPO: policy.repo, TEAM: policy.teamId, BUNDLE_ID: policy.bundleId,
    MANIFEST: BINARY_MANIFEST_NAME, MAX_MANIFEST: MAX_BINARY_MANIFEST_BYTES, MAX_ASSET: MAX_BINARY_ASSET_BYTES};
  return readFileSync(new URL('./install-bootstrap.sh', import.meta.url), 'utf8')
    .replace(/@([A-Z_]+)@/g, (_, key) => {
      if (!(key in values)) throw new Error(`Unknown bootstrap constant ${key}`);
      return String(values[key]);
    });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(new URL('./install.sh', import.meta.url), renderInstallBootstrap(), {mode: 0o755});
}
