import { execFile } from "node:child_process";

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/**
 * Run a command and capture stdout. Never throws on a non-zero exit or a
 * missing binary - discovery must degrade gracefully when wezterm/tmux aren't
 * running. Callers inspect `code` / empty stdout instead.
 */
export function run(
  bin: string,
  args: string[],
  opts: { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        timeout: opts.timeoutMs ?? 4000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        cwd: opts.cwd,
        env: opts.env,
      },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === "number"
            ? ((err as { code: number }).code as number)
            : err
              ? 1
              : 0;
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
      },
    );
  });
}
