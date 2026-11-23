import type { UtilityProcess } from "electron";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  createWriteStream,
  mkdirSync,
  openSync,
  type WriteStream,
} from "node:fs";
import { dirname } from "node:path";
import { finished } from "node:stream";

export type UtilityProcessStdio = "pipe" | "ignore";

/** A pipe a grandchild inherited can outlive the child; the log still closes after this. */
const UTILITY_LOG_DRAIN_MS = 2000;

/** What the supervisor writes lifecycle lines through: a stream, or a path-only log below. */
export interface UtilityLog {
  write(chunk: string | Buffer): unknown;
  end(chunk?: string): unknown;
  readonly writableEnded: boolean;
}

export function utilityProcessStdio(captureChildOutput: boolean | undefined): UtilityProcessStdio {
  return captureChildOutput === false ? "ignore" : "pipe";
}

export function openPrivateUtilityLog(logPath: string): WriteStream {
  const logDir = dirname(logPath);
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  chmodSync(logDir, 0o700);

  const fd = openSync(logPath, "a", 0o600);
  try {
    chmodSync(logPath, 0o600);
    const log = createWriteStream(logPath, { fd, autoClose: true });
    // A stream error with no listener is an uncaught exception in Electron's main
    // process. Losing a diagnostic line must never take the app down with it, so report
    // only the code: a filesystem error's message carries the log path.
    log.on("error", (err: NodeJS.ErrnoException) => {
      try { console.error(`Could not write a utility log: ${err.code ?? err.name}`); }
      catch { /* An unavailable stderr must not turn a lost log line into a crash. */ }
    });
    return log;
  } catch (err) {
    closeSync(fd);
    throw err;
  }
}

/**
 * A lifecycle-only log that holds no open handle: every line is appended by path.
 *
 * WHY. Foreman's worker appends its completion decisions to this same `foreman.log` and rotates
 * it by renaming it to `.1`. A handle the supervisor opened at spawn would follow the renamed
 * file, and after a second rotation replaced `.1` its lines would reach no path at all; rotating
 * in place instead (copy, then truncate) loses any line written between the two steps. Opening
 * by path for each line removes the shared handle, so there is nothing to coordinate: a line
 * lands in whichever file was `foreman.log` when it was opened, which is either `foreman.log`
 * or the `.1` it has just become.
 *
 * Only possible when child output is not captured, which is Foreman's configuration: the
 * supervisor then writes a handful of lines per worker life, so an open per line costs nothing.
 * Privacy matches `openPrivateUtilityLog`, and a failed append reports only its code.
 */
export function openPathUtilityLog(logPath: string): UtilityLog {
  const logDir = dirname(logPath);
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  chmodSync(logDir, 0o700);
  closeSync(openSync(logPath, "a", 0o600));
  chmodSync(logPath, 0o600);
  let ended = false;
  const append = (chunk: string | Buffer): void => {
    try {
      appendFileSync(logPath, chunk, { mode: 0o600 });
    } catch (err) {
      try { console.error(`Could not write a utility log: ${(err as NodeJS.ErrnoException).code ?? "unknown"}`); }
      catch { /* An unavailable stderr must not turn a lost log line into a crash. */ }
    }
  };
  return {
    write(chunk) {
      if (!ended) append(chunk);
      return true;
    },
    end(chunk) {
      if (ended) return;
      if (chunk) append(chunk);
      ended = true;
    },
    get writableEnded() {
      return ended;
    },
  };
}

/** The supervisor's log: a path-only log when child output is not captured, else a stream. */
export function openUtilityLog(logPath: string, captureChildOutput: boolean | undefined): UtilityLog {
  return captureChildOutput === false ? openPathUtilityLog(logPath) : openPrivateUtilityLog(logPath);
}

export function attachUtilityProcessOutput(
  child: Pick<UtilityProcess, "stdout" | "stderr">,
  log: UtilityLog,
  captureChildOutput: boolean | undefined,
): void {
  if (captureChildOutput === false) return;
  const write = (data: Buffer): void => {
    if (!log.writableEnded) log.write(data);
  };
  child.stdout?.on("data", write);
  child.stderr?.on("data", write);
}

/**
 * Electron reports a utility process's "exit" before its piped output has drained, so a
 * shutdown line can arrive afterwards. Write the closing marker only once both pipes have
 * finished, so that line lands in the log ahead of it instead of hitting an ended stream.
 */
export function endUtilityProcessLog(
  child: Pick<UtilityProcess, "stdout" | "stderr">,
  log: UtilityLog,
  message: string,
  drainMs = UTILITY_LOG_DRAIN_MS,
): void {
  // finished() also calls back for a pipe that has already ended or been destroyed.
  const pipes = [child.stdout, child.stderr].filter((pipe): pipe is NonNullable<typeof pipe> => !!pipe);
  let remaining = pipes.length;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const close = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!log.writableEnded) log.end(message);
  };
  if (remaining === 0) return close();
  timer = setTimeout(close, drainMs);
  timer.unref?.();
  for (const pipe of pipes) {
    finished(pipe, () => {
      remaining -= 1;
      if (remaining === 0) close();
    });
  }
}
