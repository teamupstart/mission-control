import { execFile } from "node:child_process";

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  /**
   * We killed the child on `timeoutMs`, so whether the command had any EFFECT is
   * unknown. Distinct from every other non-zero exit, where the command ran to
   * completion and reported its own failure - a caller writing to a remote has to be
   * able to tell "it was refused" from "we stopped listening".
   */
  timedOut?: boolean;
  /** stdout exceeded `maxBuffer`. Retrying the same command cannot produce less. */
  overflowed?: boolean;
  // Both are OPTIONAL because they narrow a failure rather than describing a result:
  // `run` always sets them, every consumer reads absent as false, and the many hand-built
  // stubs that model only stdout/stderr/code stay honest instead of asserting a `false`
  // they never reasoned about.
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
    /**
     * Bytes of stdout to buffer before the child is killed. Defaults to 8MB, which is
     * generous for the discovery commands this was written for and NOT generous for a
     * whole pull request diff - a regenerated lockfile or a vendored directory blows
     * past it, and the overflow surfaces as an ordinary non-zero exit that a caller
     * would otherwise retry forever.
     */
    maxBuffer?: number;
  } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      args,
      {
        timeout: opts.timeoutMs ?? 4000,
        maxBuffer: opts.maxBuffer ?? 8 * 1024 * 1024,
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
        // An overflow otherwise arrives as a bare non-zero exit with the truncated
        // OUTPUT in stderr's place, which reads to a caller as "the command failed and
        // said this" - so it gets retried forever instead of recognised as too big to
        // buffer. Naming it is what lets a caller stop.
        const overflowed =
          !!err &&
          ((err as { code?: unknown }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
            /maxBuffer/i.test(err.message ?? ""));
        // `killed` is set by Node when IT killed the child, which for these options can
        // only be the `timeout`. A command we stopped listening to may still have done
        // its work, so this is never "it failed", only "we do not know".
        const timedOut = !overflowed && !!err && (err as { killed?: unknown }).killed === true;
        resolve({
          stdout: stdout ?? "",
          stderr: overflowed ? (err.message ?? "maxBuffer exceeded") : (stderr ?? ""),
          code,
          timedOut,
          overflowed,
        });
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
