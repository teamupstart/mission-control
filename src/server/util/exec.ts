import { execFile } from "node:child_process";

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  /**
   * The child DIED rather than answering, so whether the command had any EFFECT is
   * unknown. Distinct from every other non-zero exit, where the command ran to
   * completion and reported its own failure - a caller writing to a remote has to be
   * able to tell "it was refused" from "we never found out".
   *
   * Named for the conclusion rather than the cause on purpose. Our own `timeoutMs` is
   * one way to get here; the OOM killer, a container stop and an operator's `pkill` are
   * others, and they are indistinguishable from the caller's point of view because in
   * every one of them the command may well have completed its work first.
   */
  outcomeUnknown?: boolean;
  /** stdout exceeded `maxBuffer`. Retrying the same command cannot produce less. */
  overflowed?: boolean;
  // Both are OPTIONAL because they narrow a failure rather than describing a result:
  // `run` always sets them, and the many hand-built stubs that model only
  // stdout/stderr/code stay honest instead of asserting a `false` they never reasoned
  // about. A consumer reading absent as false must therefore be one for which "assume
  // it completed" is the SAFE reading - see `postReview`'s caller, which treats unknown
  // as "may already be published" and so must never infer it from a missing field.
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
        // `killed` alone is not enough: Node sets it only when NODE killed the child,
        // so a process the OOM killer or an operator took out arrives with
        // `killed: false` and a `signal`, and would otherwise read as an ordinary
        // refusal. Every death-by-signal is the same conclusion - the command never
        // reported its own exit, so we do not know whether it did its work.
        const e = err as { killed?: unknown; signal?: unknown } | null;
        const outcomeUnknown =
          !overflowed && !!err && (e?.killed === true || typeof e?.signal === "string");
        resolve({
          stdout: stdout ?? "",
          stderr: overflowed ? (err.message ?? "maxBuffer exceeded") : (stderr ?? ""),
          code,
          outcomeUnknown,
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
