import { utilityProcess } from "electron";
import type { UtilityProcess } from "electron";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { forkAndInitializeUtilityProcess } from "./utility-process-start.ts";

export interface UtilityProcessController {
  stop(): void;
}

export interface UtilityProcessOptions {
  entry: string;
  serviceName: string;
  logPath: string;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  onSpawn?: (child: UtilityProcess) => void;
}

/**
 * Keep one Electron utility process alive until its owner stops it.
 *
 * The daemon and Foreman have different ownership rules, but once either one is ours their
 * restart, logging, and shutdown mechanics are identical. Keeping that loop here prevents a
 * packaging fix in one process from silently leaving the other with different crash behavior.
 */
export function superviseUtilityProcess(opts: UtilityProcessOptions): UtilityProcessController {
  mkdirSync(dirname(opts.logPath), { recursive: true });

  let child: UtilityProcess | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let restarts = 0;

  const scheduleRestart = (): void => {
    if (stopped) return;
    restarts += 1;
    const delay = Math.min(500 * restarts, 5000);
    restartTimer = setTimeout(spawn, delay);
  };

  const spawn = (): void => {
    restartTimer = null;
    if (stopped) return;

    const log = createWriteStream(opts.logPath, { flags: "a" });
    try {
      child = forkAndInitializeUtilityProcess(
        () =>
          utilityProcess.fork(opts.entry, [], {
            serviceName: opts.serviceName,
            stdio: "pipe",
            env: opts.env,
            cwd: opts.cwd,
          }),
        opts.onSpawn,
      );
    } catch (err) {
      child = null;
      log.end(`[mission-control] ${opts.serviceName} failed to start: ${String(err)}\n`);
      scheduleRestart();
      return;
    }

    child.stdout?.on("data", (data: Buffer) => log.write(data));
    child.stderr?.on("data", (data: Buffer) => log.write(data));
    child.once("exit", (code) => {
      child = null;
      log.end(
        stopped
          ? `[mission-control] ${opts.serviceName} stopped\n`
          : `[mission-control] ${opts.serviceName} exited with code ${code}; restarting\n`,
      );
      scheduleRestart();
    });
  };

  spawn();
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = null;
      child?.kill();
    },
  };
}
