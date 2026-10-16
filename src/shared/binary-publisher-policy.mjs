import { BINARY_BUNDLE_ID, BINARY_REPO } from './binary-distribution.mjs';

// Approval is a source-controlled trust decision, never a claim in a downloaded
// manifest or a value supplied by a release job. Approved by the operator in Mission Control.
export const APPROVED_DEVELOPER_TEAM_ID = 'S2FPCQK39Z';
export const BINARY_MANIFEST_NAME = 'mission-control-manifest.json';
export const MAX_BINARY_MANIFEST_BYTES = 16 * 1024;
export const MINIMUM_DISTRIBUTION_MACOS = '12.0';

export function binaryPublisherPolicy() {
  if (!/^[A-Z0-9]{10}$/.test(APPROVED_DEVELOPER_TEAM_ID ?? '')) {
    throw new Error('Distribution is blocked: no approved Developer ID team is pinned in binary-publisher-policy.mjs');
  }
  return {repo: BINARY_REPO, bundleId: BINARY_BUNDLE_ID, teamId: APPROVED_DEVELOPER_TEAM_ID, notarized: true};
}

// C1 intentionally keeps releaseTag null for alpha. Its publication namespace is C4.
export function binaryReleaseTag(identity) {
  return identity.channel === 'stable' ? identity.releaseTag : `alpha-${identity.commit}`;
}
