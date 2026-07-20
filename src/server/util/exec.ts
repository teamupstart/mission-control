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
  opts: {
    timeoutMs?: number;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    /**
     * Text to write to the child's stdin.
     *
     * Exists so a JSON body can be piped rather than crammed onto a command line -
     * `gh api --input -` is the only sane way to POST a whole review with its inline
     * comments, and argv is both size-limited and the wrong place for text a model
     * wrote.
     */
    input?: string;
  } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(
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
    if (opts.input !== undefined) {
      // An unhandled `error` on stdin THROWS rather than rejecting, taking the caller's
      // process down instead of failing this one run - and a child that exits before
      // reading a large body (auth failure, bad flags) gives exactly that via EPIPE.
      // Swallowed because it isn't the diagnosis: the callback above still reports the
      // real exit code and stderr.
      child.stdin?.on("error", () => {});
      child.stdin?.end(opts.input);
    }
  });
}
