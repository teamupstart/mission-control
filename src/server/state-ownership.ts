import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PORT, STATE_DIR } from "./config.ts";
import {
  loadNativeStateLockBinding,
  type NativeStateLockBinding,
} from "./state-ownership-native.ts";

export const STATE_OWNERSHIP_FILE = "daemon.lock";

type StateOwner = {
  version: 1;
  pid: number;
  port: number;
  startedAt: string;
};

export type StateOwnership = {
  path: string;
  release(): void;
};

function readOwner(path: string): Partial<StateOwner> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const value = parsed as Record<string, unknown>;
    return {
      ...(typeof value.pid === "number" ? { pid: value.pid } : {}),
      ...(typeof value.port === "number" ? { port: value.port } : {}),
      ...(typeof value.startedAt === "string" ? { startedAt: value.startedAt } : {}),
    };
  } catch {
    return null;
  }
}

function contentionError(stateDir: string, lockPath: string): Error {
  const owner = readOwner(lockPath);
  const details = [
    owner?.pid === undefined ? null : `PID ${owner.pid}`,
    owner?.port === undefined ? null : `API port ${owner.port}`,
    owner?.startedAt === undefined ? null : `started ${owner.startedAt}`,
  ].filter((detail): detail is string => detail !== null);
  const ownerText = details.length > 0 ? ` Current owner: ${details.join(", ")}.` : "";
  return new Error(
    `The state home is already owned by another Mission Control daemon: ${stateDir}.` +
      ownerText +
      " Stop that daemon, or start this one with a different MISSION_HOME, then retry.",
  );
}

export function acquireStateOwnership(
  input: {
    stateDir?: string;
    port?: number;
    pid?: number;
    startedAt?: string;
  } = {},
  binding: NativeStateLockBinding = loadNativeStateLockBinding(),
): StateOwnership {
  const stateDir = input.stateDir ?? STATE_DIR;
  const lockPath = join(stateDir, STATE_OWNERSHIP_FILE);
  const owner: StateOwner = {
    version: 1,
    pid: input.pid ?? process.pid,
    port: input.port ?? PORT,
    startedAt: input.startedAt ?? new Date().toISOString(),
  };

  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  let handle: unknown;
  try {
    handle = binding.acquire(lockPath, `${JSON.stringify(owner)}\n`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ELOCKED") {
      throw contentionError(stateDir, lockPath);
    }
    throw error;
  }

  let active = true;
  return {
    path: lockPath,
    release() {
      if (!active) return;
      binding.release(handle);
      active = false;
    },
  };
}
