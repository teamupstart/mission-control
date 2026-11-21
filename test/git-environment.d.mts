export function disableAutoMaintenance(env?: NodeJS.ProcessEnv): void;

export function developerDirectory(
  env?: NodeJS.ProcessEnv,
  exists?: (path: string) => boolean,
  readlink?: (path: string) => string,
): string | null;

export function bypassXcrunGitShim(env?: NodeJS.ProcessEnv): void;
