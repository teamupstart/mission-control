import type { UtilityProcess } from "electron";
import {
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

type UtilityLog = Pick<WriteStream, "write" | "end" | "writableEnded">;

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
    // process. Losing a diagnostic line must never take the app down with it.
    log.on("error", () => {});
    return log;
  } catch (err) {
    closeSync(fd);
    throw err;
  }
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
