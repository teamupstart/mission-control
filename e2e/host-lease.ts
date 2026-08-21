import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const E2E_MAX_WORKERS = 4;

const DEFAULT_POLL_MS = 1_000;
const DEFAULT_WAIT_TIMEOUT_MS = 45 * 60_000;
const LEASE_HOST = "127.0.0.1";
const LEASE_PORT_BASE = 21_800;
const LEASE_PORT_SPAN = 1_000;
const LEASE_PROTOCOL = "mission-control-e2e-lease-v1:";
const PROBE_TIMEOUT_MS = 1_000;
const OWNER_METADATA_GRACE_MS = 2_000;

export interface E2eLeaseOwner {
  token: string;
  pid: number;
  acquiredAt: string;
  cwd: string;
  argv: string[];
  workers: number;
  port: number;
}

export interface E2eHostLease {
  owner: E2eLeaseOwner;
  release(): Promise<void>;
}

interface AcquireOptions {
  workers: number;
  port?: number;
  metadataPath?: string;
  pollMs?: number;
  waitTimeoutMs?: number;
  metadataGraceMs?: number;
  onWait?: (owner: E2eLeaseOwner | null) => void;
  // Used by the handoff regression test to hold metadata cleanup open.
  beforeReleaseMetadataRemoval?: () => Promise<void>;
}

function userIdentity(): string {
  const value = typeof process.getuid === "function"
    ? String(process.getuid())
    : process.env.USERNAME || process.env.USER || "user";
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function identityNumber(value: string): number {
  let result = 0;
  for (const character of value) result = ((result * 31) + character.charCodeAt(0)) >>> 0;
  return result;
}

export function defaultE2eLeasePort(): number {
  return LEASE_PORT_BASE + (identityNumber(userIdentity()) % LEASE_PORT_SPAN);
}

export function defaultE2eLeaseMetadataPath(): string {
  return join(tmpdir(), `mission-control-e2e-${userIdentity()}.json`);
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

async function readOwner(metadataPath: string): Promise<E2eLeaseOwner | null> {
  try {
    const parsed = JSON.parse(await readFile(metadataPath, "utf8")) as Partial<E2eLeaseOwner>;
    if (
      typeof parsed.token !== "string"
      || !Number.isInteger(parsed.pid)
      || typeof parsed.acquiredAt !== "string"
      || typeof parsed.cwd !== "string"
      || !Array.isArray(parsed.argv)
      || !parsed.argv.every((part) => typeof part === "string")
      || !Number.isInteger(parsed.workers)
      || !Number.isInteger(parsed.port)
    ) {
      return null;
    }
    return parsed as E2eLeaseOwner;
  } catch {
    return null;
  }
}

async function publishOwner(metadataPath: string, owner: E2eLeaseOwner): Promise<void> {
  await mkdir(dirname(metadataPath), { recursive: true });
  const candidate = `${metadataPath}.candidate-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(candidate, `${JSON.stringify(owner, null, 2)}\n`, { flag: "wx" });
    await rename(candidate, metadataPath);
  } finally {
    await rm(candidate, { force: true });
  }
}

async function tryListen(port: number, token: string): Promise<Server | null> {
  const server = createServer((socket) => socket.end(`${LEASE_PROTOCOL}${token}\n`));
  return await new Promise((resolve, reject) => {
    server.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") resolve(null);
      else reject(error);
    });
    server.listen({ host: LEASE_HOST, port, exclusive: true }, () => resolve(server));
  });
}

type LeaseProbe =
  | { kind: "free" }
  | { kind: "incompatible" }
  | { kind: "lease"; token: string };

async function probeLeaseHolder(port: number): Promise<LeaseProbe> {
  return await new Promise((resolve) => {
    const socket = connect({ host: LEASE_HOST, port });
    let response = "";
    let settled = false;
    const finish = (result: LeaseProbe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(result);
    };
    const parseResponse = (): LeaseProbe => {
      const line = response.trim();
      return line.startsWith(LEASE_PROTOCOL) && line.length > LEASE_PROTOCOL.length
        ? { kind: "lease", token: line.slice(LEASE_PROTOCOL.length) }
        : { kind: "incompatible" };
    };
    const timeout = setTimeout(() => finish({ kind: "incompatible" }), PROBE_TIMEOUT_MS);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      response += chunk;
      if (response.length > 256) finish({ kind: "incompatible" });
      else if (response.includes("\n")) finish(parseResponse());
    });
    socket.once("end", () => finish(parseResponse()));
    socket.once("error", (error) => {
      finish((error as NodeJS.ErrnoException).code === "ECONNREFUSED"
        ? { kind: "free" }
        : { kind: "incompatible" });
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function acquireE2eHostLease(options: AcquireOptions): Promise<E2eHostLease> {
  assertE2eWorkerLimit(options.workers);
  const requestedPort = options.port ?? defaultE2eLeasePort();
  const metadataPath = options.metadataPath ?? defaultE2eLeaseMetadataPath();
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const metadataGraceMs = options.metadataGraceMs ?? OWNER_METADATA_GRACE_MS;
  const deadline = Date.now() + waitTimeoutMs;
  let reportedOwnerToken: string | null | undefined;
  let unverifiedSince: number | null = null;

  for (;;) {
    const token = randomUUID();
    const server = await tryListen(requestedPort, token);
    if (server) {
      const address = server.address();
      if (!address || typeof address === "string") {
        await closeServer(server);
        throw new Error("Could not read the Mission Control E2E host lease port.");
      }
      const owner: E2eLeaseOwner = {
        token,
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
        cwd: process.cwd(),
        argv: process.argv.slice(1),
        workers: options.workers,
        port: address.port,
      };
      try {
        await publishOwner(metadataPath, owner);
      } catch (error) {
        await closeServer(server);
        throw error;
      }

      let released = false;
      return {
        owner,
        release: async () => {
          if (released) return;
          released = true;
          try {
            const current = await readOwner(metadataPath);
            if (current?.token === owner.token) {
              await options.beforeReleaseMetadataRemoval?.();
              await rm(metadataPath, { force: true });
            }
          } finally {
            // Keep the kernel lease until this owner's metadata is gone. A successor
            // therefore cannot publish its token before the old cleanup completes.
            await closeServer(server);
          }
        },
      };
    }

    let probe = await probeLeaseHolder(requestedPort);
    if (probe.kind === "free") continue;
    if (probe.kind === "incompatible") {
      await sleep(100);
      probe = await probeLeaseHolder(requestedPort);
      if (probe.kind === "free") continue;
      if (probe.kind === "incompatible") {
        throw new Error(
          `Port ${requestedPort} is in use by a process that is not a compatible `
          + "Mission Control E2E host lease.",
        );
      }
    }

    const observed = await readOwner(metadataPath);
    const current = observed?.token === probe.token ? observed : null;
    if (current) {
      unverifiedSince = null;
    } else if (unverifiedSince === null) {
      unverifiedSince = Date.now();
    } else if (Date.now() - unverifiedSince >= metadataGraceMs) {
      throw new Error(
        `Port ${requestedPort} speaks the Mission Control E2E lease protocol but did not `
        + `publish matching owner metadata within ${metadataGraceMs}ms.`,
      );
    }
    const currentToken = current?.token ?? null;
    if (reportedOwnerToken !== currentToken) {
      options.onWait?.(current);
      reportedOwnerToken = currentToken;
    }
    if (Date.now() >= deadline) {
      const holder = current
        ? ` It is held by pid ${current.pid} from ${current.cwd} since ${current.acquiredAt}.`
        : ` Port ${requestedPort} is in use, but no Mission Control E2E owner metadata is available.`;
      throw new Error(
        `Timed out waiting for the Mission Control E2E host lease after ${waitTimeoutMs}ms.${holder}`,
      );
    }
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
}
