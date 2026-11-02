export type DistributionToolResult = {
  status: number | null;
  signal?: string | null;
  error?: {code?: string | number} | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
};
export class DistributionStageError extends Error {
  stage: string;
  constructor(stage: string, cause: unknown);
}
export function redactDistributionText(value: unknown, env?: NodeJS.ProcessEnv): string;
export function distributionFailure(error: unknown, env?: NodeJS.ProcessEnv): string;
export function distributionDiagnostic(detail: Record<string, unknown>, env?: NodeJS.ProcessEnv): string;
export function distributionToolError(command: string, result: DistributionToolResult): Error;
export function preserveFailureExit(): void;
export function distributionStages(log?: (line: string) => void): {
  enter(stage: string): void;
  run<T>(stage: string, operation: () => T | Promise<T>): Promise<T>;
};
