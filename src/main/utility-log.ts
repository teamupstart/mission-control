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

export type UtilityProcessStdio = "pipe" | "ignore";

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
    return createWriteStream(logPath, { fd, autoClose: true });
  } catch (err) {
    closeSync(fd);
    throw err;
  }
}

export function attachUtilityProcessOutput(
  child: Pick<UtilityProcess, "stdout" | "stderr">,
  log: Pick<WriteStream, "write">,
  captureChildOutput: boolean | undefined,
): void {
  if (captureChildOutput === false) return;
  child.stdout?.on("data", (data: Buffer) => log.write(data));
  child.stderr?.on("data", (data: Buffer) => log.write(data));
}
