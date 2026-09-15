import type { MigrationPlan } from '../../scripts/install-migration.mjs';
import type { InstallReceipt } from '../../src/shared/install-receipt-schema.mjs';
export function migrationPlanFixture(receipt: InstallReceipt): MigrationPlan {
  return {
    protocol: 1, nonce: '1'.repeat(64), source: receipt.appPath,
    target: '/Users/Fixture/Applications/Mission Control.app', stateDirectory: '/state',
    stagedBundle: '/tmp/mission-source/release/mac-arm64/Mission Control.app', stagedRevision: 'staged-1',
    sourceIdentity: {commit: 'a'.repeat(40), version: '1.2.3', revision: 'source-1', protocol: 1, automatic: true},
    targetIdentity: {commit: 'b'.repeat(40), version: '1.2.4', revision: 'staged-1', protocol: 1, automatic: true},
    oldReceipt: receipt,
    intendedReceipt: {...receipt, appPath: '/Users/Fixture/Applications/Mission Control.app', installScope: 'user', installedCommit: 'b'.repeat(40)},
  };
}
