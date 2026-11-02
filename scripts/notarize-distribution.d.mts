import type { DistributionToolResult } from './distribution-diagnostics.mjs';
export function runNotarizationTool(command: string, args: string[]): Promise<DistributionToolResult>;
export function notarizeDistribution(appPath: string, credentials: {
  appleApiKey: string; appleApiKeyId: string; appleApiIssuer: string;
}, options?: {
  run?: typeof runNotarizationTool;
  log?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  wait?: (ms: number) => Promise<void>;
}): Promise<void>;
