export interface DatabaseShellResult {
  status: number | null;
  error?: NodeJS.ErrnoException;
}

export interface DatabaseShellOptions {
  path?: string;
  sqliteBin?: string;
  spawn?: (
    command: string,
    args: string[],
    options: { stdio: "inherit" },
  ) => DatabaseShellResult;
}

export function databasePath(): string;
export function sqliteShellArgs(path: string): string[];
export function openDatabaseShell(options?: DatabaseShellOptions): number;
