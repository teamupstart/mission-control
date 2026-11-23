import type { verifyDistributionApp } from './verify-distribution.mjs';

export function qualifySignedRuntime(...args: Parameters<typeof verifyDistributionApp>): Promise<void>;
