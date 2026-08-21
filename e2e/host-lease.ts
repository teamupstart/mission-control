import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

export const E2E_MAX_WORKERS = 4;

const DEFAULT_POLL_MS = 1_000;
const DEFAULT_WAIT_TIMEOUT_MS = 45 * 60_000;
const OWNER_FILE = "owner.json";

export interface E2eLeaseOwner {
  token: string;
  pid: number;
  acquiredAt: string;
  cwd: string;
  argv: string[];
  workers: number;
}

export interface E2eHostLease {
  owner: E2eLeaseOwner;
  release(): Promise<void>;
}

interface AcquireOptions {
  lockDir?: string;
  workers: number;
  pollMs?: number;
  waitTimeoutMs?: number;
  onWait?: (owner: E2eLeaseOwner | null) => void;
}

function userIdentity(): string {
  const value = typeof process.getuid === "function"
    ? String(process.getuid())
    : process.env.USERNAME || process.env.USER || "user";
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

export function defaultE2eLeaseDir(): string {
  return join(tmpdir(), `mission-control-e2e-${userIdentity()}.lock`);
}

export function assertE2eWorkerLimit(workers: number): void {
  if (!Number.isInteger(workers) || workers < 1) {
    throw new Error(`Playwright resolved an invalid worker count: ${workers}`);
  }
  if (workers > E2E_MAX_WORKERS) {
    throw new Error(
      `Mission Control E2E tests are limited to ${E2E_MAX_WORKERS} workers per host; `
      + `this run resolved ${workers}. Remove the --workers override or choose a value from 1 to ${E2E_MAX_WORKERS}.`,
    );
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readOwner(lockDir: string): Promise<E2eLeaseOwner | null> {
  try {
    const parsed = JSON.parse(await readFile(join(lockDir, OWNER_FILE), "utf8")) as Partial<E2eLeaseOwner>;
    if (
      typeof parsed.token !== "string"
      || !Number.isInteger(parsed.pid)
      || typeof parsed.acquiredAt !== "string"
      || typeof parsed.cwd !== "string"
      || !Array.isArray(parsed.argv)
      || !parsed.argv.every((part) => typeof part === "string")
      || !Number.isInteger(parsed.workers)
    ) {
      return null;
    }
    return parsed as E2eLeaseOwner;
  } catch {
    return null;
  }
}

async function publishCandidate(lockDir: string, owner: E2eLeaseOwner): Promise<boolean> {
  await mkdir(dirname(lockDir), { recursive: true });
  const candidate = await mkdtemp(join(dirname(lockDir), `${basename(lockDir)}.candidate-`));
  try {
    await writeFile(join(candidate, OWNER_FILE), `${JSON.stringify(owner, null, 2)}\n`, {
      flag: "wx",
    });
    await rename(candidate, lockDir);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOTEMPTY") return false;
    throw error;
  } finally {
    await rm(candidate, { recursive: true, force: true });
  }
}

async function reclaimStaleLease(lockDir: string, expected: E2eLeaseOwner | null): Promise<void> {
  const current = await readOwner(lockDir);
  if (expected && current?.token !== expected.token) return;
  if (current && processIsAlive(current.pid)) return;

  const staleDir = `${lockDir}.stale-${process.pid}-${randomUUID()}`;
  try {
    await rename(lockDir, staleDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EEXIST" || code === "ENOTEMPTY") return;
    throw error;
  }
  await rm(staleDir, { recursive: true, force: true });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function acquireE2eHostLease(options: AcquireOptions): Promise<E2eHostLease> {
  assertE2eWorkerLimit(options.workers);
  const lockDir = options.lockDir ?? defaultE2eLeaseDir();
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const owner: E2eLeaseOwner = {
    token: randomUUID(),
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
    cwd: process.cwd(),
    argv: process.argv.slice(1),
    workers: options.workers,
  };
  const deadline = Date.now() + waitTimeoutMs;
  let reportedOwnerToken: string | null | undefined;

  for (;;) {
    if (await publishCandidate(lockDir, owner)) {
      let released = false;
      return {
        owner,
        release: async () => {
          if (released) return;
          released = true;
          const current = await readOwner(lockDir);
          if (current?.token !== owner.token) return;
          const releaseDir = `${lockDir}.release-${process.pid}-${randomUUID()}`;
          try {
            await rename(lockDir, releaseDir);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
            throw error;
          }
          await rm(releaseDir, { recursive: true, force: true });
        },
      };
    }

    const current = await readOwner(lockDir);
    if (!current || !processIsAlive(current.pid)) {
      await reclaimStaleLease(lockDir, current);
      continue;
    }

    if (reportedOwnerToken !== current.token) {
      options.onWait?.(current);
      reportedOwnerToken = current.token;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for the Mission Control E2E host lease after ${waitTimeoutMs}ms. `
        + `It is held by pid ${current.pid} from ${current.cwd} since ${current.acquiredAt}.`,
      );
    }
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
}
