import { spawn, type SpawnOptions } from "node:child_process";
import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";

import { binEnv, resolveBin } from "./bin.ts";
import type { TerminalExec } from "./exec.ts";
import type { BinSpec, TerminalResult } from "./types.ts";

/**
 * The oldest stable Herdr this client speaks, as a floor and never as an equality.
 *
 * Herdr bumps its protocol generation on its own release cadence - 0.8.2 served 20, 0.9.0
 * serves 22 - while every method and consumed field this client uses stayed put. Pinning the
 * generation exactly made each of those releases a hard outage for an operator who had done
 * nothing but update Herdr, and the refusal then told them to update it again.
 *
 * A floor is safe here because the generation is not what actually guards the wire. Every
 * response this client consumes is validated by a narrow Zod schema that ignores additive
 * fields and rejects a missing or retyped one, so a future generation that removes something
 * fails at that field with its own operation-specific message rather than sending a request
 * blind. Raise the floor only when Herdr drops a method or field named in this file.
 */
export const HERDR_MIN_PROTOCOL = 20;
export const HERDR_MIN_VERSION = "0.8.2";

const READ_TIMEOUT_MS = 1_000;
const ACTION_TIMEOUT_MS = 10_000;
const READY_POLL_MS = 100;
const MAX_REQUESTS = 512;
const MAX_PARALLEL_SOCKETS = 8;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_BATCH_BYTES = 8 * 1024 * 1024;

const Id = z.string().min(1);
const NullableText = z.string().nullable().optional();

const WorkspaceSchema = z.object({
  workspace_id: Id,
  label: z.string(),
});

const TabSchema = z.object({
  tab_id: Id,
  workspace_id: Id,
  number: z.number().int().nonnegative(),
  label: z.string(),
});

export const HerdrPaneSchema = z.object({
  pane_id: Id,
  workspace_id: Id,
  tab_id: Id,
  cwd: NullableText,
  foreground_cwd: NullableText,
});

const SnapshotSchema = z.object({
  type: z.literal("session_snapshot"),
  snapshot: z.object({
    version: z.string(),
    protocol: z.number().int().nonnegative(),
    workspaces: z.array(WorkspaceSchema),
    tabs: z.array(TabSchema),
    panes: z.array(HerdrPaneSchema),
  }),
});

const ProcessInfoSchema = z.object({
  type: z.literal("pane_process_info"),
  process_info: z.object({
    pane_id: Id,
    shell_pid: z.number().int().nonnegative().nullable().optional(),
    tty: z.string().nullable().optional(),
    foreground_processes: z.array(z.object({
      pid: z.number().int().nonnegative(),
      name: z.string(),
      cwd: NullableText,
    })).optional(),
  }),
});

const PaneReadSchema = z.object({
  type: z.literal("pane_read"),
  read: z.object({ pane_id: Id, text: z.string() }),
});

const WorkspaceCreatedSchema = z.object({
  type: z.literal("workspace_created"),
  workspace: WorkspaceSchema,
  tab: TabSchema,
  root_pane: HerdrPaneSchema,
}).superRefine((created, context) => {
  if (created.tab.workspace_id !== created.workspace.workspace_id) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["tab", "workspace_id"],
      message: "workspace mismatch",
    });
  }
  if (created.root_pane.workspace_id !== created.workspace.workspace_id) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["root_pane", "workspace_id"],
      message: "workspace mismatch",
    });
  }
  if (created.root_pane.tab_id !== created.tab.tab_id) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["root_pane", "tab_id"],
      message: "tab mismatch",
    });
  }
});

const WorkspaceInfoSchema = z.object({
  type: z.literal("workspace_info"),
  workspace: WorkspaceSchema,
});

const PaneCreatedSchema = z.object({
  type: z.literal("pane_created"),
  pane: HerdrPaneSchema,
});

const OkSchema = z.object({ type: z.literal("ok") });
const AgentFocusedSchema = z.union([
  OkSchema,
  z.object({ type: z.literal("agent_info"), agent: z.object({ pane_id: Id }) }),
]);

const StatusSchema = z.object({
  status: z.string(),
  running: z.boolean(),
  version: z.string().nullable(),
  protocol: z.number().int().nonnegative().nullable(),
  compatible: z.boolean().nullable(),
  socket: z.string().min(1),
  restart_needed: z.boolean(),
});

const EnvelopeSchema = z.union([
  z.object({ id: Id, error: z.object({ code: z.string(), message: z.string() }) }),
  z.object({ id: Id, result: z.record(z.unknown()) }),
]);

export type HerdrPane = z.infer<typeof HerdrPaneSchema>;
export type HerdrSnapshot = z.infer<typeof SnapshotSchema>["snapshot"];
export type HerdrProcessInfo = z.infer<typeof ProcessInfoSchema>["process_info"];
export type HerdrWorkspaceCreated = z.infer<typeof WorkspaceCreatedSchema>;

export type HerdrResult<T> =
  | { ok: true; value: T; outcomeUnknown: false }
  | { ok: false; error: string; outcomeUnknown: boolean; code?: string };

interface Request<T> {
  method: string;
  params: Record<string, unknown>;
  schema: z.ZodType<T>;
  mutation: boolean;
  operation: string;
}

interface Pending<T> extends Request<T> {
  id: string;
  written: boolean;
}

interface SocketLike {
  once(event: "connect" | "error", listener: (...args: any[]) => void): this;
  on(event: "data" | "end" | "close" | "error", listener: (...args: any[]) => void): this;
  removeAllListeners(): this;
  write(data: string): boolean;
  end(): this;
  destroy(): this;
}

export interface HerdrClientDeps {
  connect: (socketPath: string) => SocketLike;
  spawnDetached: (bin: string, args: readonly string[], options: SpawnOptions) => {
    on?(event: "error", listener: (error: Error) => void): void;
    unref(): void;
  };
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  nextId: () => string;
  readTimeoutMs: number;
  actionTimeoutMs: number;
  readyPollMs: number;
}

const defaultDeps: HerdrClientDeps = {
  connect: (socketPath) => createConnection(socketPath) as Socket,
  spawnDetached: (executable, args, options) => spawn(executable, [...args], options),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
  nextId: (() => {
    let next = 0;
    return () => `mission-control-${++next}`;
  })(),
  readTimeoutMs: READ_TIMEOUT_MS,
  actionTimeoutMs: ACTION_TIMEOUT_MS,
  readyPollMs: READY_POLL_MS,
};

function failure<T>(error: string, outcomeUnknown = false, code?: string): HerdrResult<T> {
  return code ? { ok: false, error, outcomeUnknown, code } : { ok: false, error, outcomeUnknown };
}

export function asTerminal(result: HerdrResult<unknown>): TerminalResult {
  return result.ok
    ? { ok: true, outcomeUnknown: false }
    : { ok: false, error: result.error, outcomeUnknown: result.outcomeUnknown };
}

function versionAtLeast(version: string, floor: string): boolean {
  const parse = (value: string): number[] | null => {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const actual = parse(version);
  const minimum = parse(floor);
  if (!actual || !minimum) return false;
  for (let i = 0; i < 3; i += 1) {
    if (actual[i]! !== minimum[i]!) return actual[i]! > minimum[i]!;
  }
  return true;
}

class SocketBatch {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private bytes = 0;
  private closed = false;
  private destroyed = false;
  private totalRequests = 0;
  private active: {
    pending: Map<string, Pending<unknown>>;
    results: Map<string, HerdrResult<unknown>>;
    order: string[];
    resolve: (results: HerdrResult<unknown>[]) => void;
  } | null = null;
  private deadline: ReturnType<typeof setTimeout> | null = null;

  private constructor(
    private readonly socket: SocketLike,
    private readonly deps: HerdrClientDeps,
    private readonly timeoutMs: number,
  ) {
    socket.on("data", (chunk: Buffer | string) => this.onData(chunk));
    socket.on("end", () => this.onDisconnect("Herdr socket ended"));
    socket.on("close", () => this.onDisconnect("Herdr socket closed"));
    socket.on("error", (error: Error) => this.onDisconnect(`Herdr socket failed: ${error.message}`));
    this.deadline = setTimeout(() => this.failActive("Herdr socket operation timed out"), timeoutMs);
  }

  static open(
    socketPath: string,
    deps: HerdrClientDeps,
    timeoutMs: number,
  ): Promise<HerdrResult<SocketBatch>> {
    return new Promise((resolve) => {
      const socket = deps.connect(socketPath);
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.removeAllListeners();
        socket.destroy();
        resolve(failure("Herdr socket connection timed out"));
      }, timeoutMs);
      const finish = (result: HerdrResult<SocketBatch>): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      socket.once("connect", () => {
        // The pre-connect error listener owns connection failures only. Leaving it installed
        // would let a later protocol error tear down the batch's handlers before the batch
        // can classify any written mutation as outcome-unknown.
        socket.removeAllListeners();
        finish({
          ok: true,
          value: new SocketBatch(socket, deps, timeoutMs),
          outcomeUnknown: false,
        });
      });
      socket.once("error", (error: Error) => {
        socket.removeAllListeners();
        socket.destroy();
        finish(failure(`Herdr socket could not connect: ${error.message}`));
      });
    });
  }

  async send<T>(requests: readonly Request<T>[]): Promise<HerdrResult<T>[]> {
    if (this.closed) return requests.map(() => failure("Herdr socket batch is closed"));
    if (this.active) return requests.map(() => failure("Herdr socket batch already has a request wave"));
    if (requests.length === 0) return [];
    if (this.totalRequests + requests.length > MAX_REQUESTS) {
      this.close();
      return requests.map(() => failure("Herdr socket request limit exceeded"));
    }
    this.totalRequests += requests.length;

    return new Promise((resolve) => {
      const pending = new Map<string, Pending<unknown>>();
      const order: string[] = [];
      for (const request of requests) {
        const id = this.deps.nextId();
        if (pending.has(id)) {
          this.active = { pending, results: new Map(), order, resolve: resolve as never };
          this.failActive("Herdr generated a duplicate request id");
          return;
        }
        pending.set(id, { ...request, id, written: false });
        order.push(id);
      }
      this.active = { pending, results: new Map(), order, resolve: resolve as never };
      for (const id of order) {
        const request = pending.get(id)!;
        const line = `${JSON.stringify({ id, method: request.method, params: request.params })}\n`;
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
          this.failActive(`Herdr ${request.operation} request is too large`);
          return;
        }
        try {
          this.socket.write(line);
          request.written = true;
        } catch (error) {
          this.failActive(`Herdr ${request.operation} could not be written: ${String(error)}`);
          return;
        }
      }
    });
  }

  private onData(chunk: Buffer | string): void {
    if (this.closed || !this.active) return;
    const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    this.bytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
    if (this.bytes > MAX_BATCH_BYTES) {
      this.failActive("Herdr socket response limit exceeded");
      return;
    }
    this.buffer += text;
    if (Buffer.byteLength(this.buffer) > MAX_LINE_BYTES && !this.buffer.includes("\n")) {
      this.failActive("Herdr socket response line is too large");
      return;
    }

    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (this.closed || !this.active) return;
      if (!line) {
        this.failActive("Herdr socket returned an empty response line");
        return;
      }
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
        this.failActive("Herdr socket response line is too large");
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.failActive("Herdr socket returned malformed JSON");
        return;
      }
      const envelope = EnvelopeSchema.safeParse(parsed);
      if (!envelope.success) {
        this.failActive("Herdr socket returned an invalid response envelope");
        return;
      }
      const id = envelope.data.id;
      const request = this.active.pending.get(id);
      if (!request || this.active.results.has(id)) {
        this.failActive(`Herdr socket returned an unknown or duplicate response id ${id}`);
        return;
      }
      if ("error" in envelope.data) {
        this.active.results.set(id, failure(
          `Herdr ${request.operation} was refused: ${envelope.data.error.message}`,
          false,
          envelope.data.error.code,
        ));
        continue;
      }
      const value = request.schema.safeParse(envelope.data.result);
      if (!value.success) {
        this.failActive(`Herdr ${request.operation} returned an invalid response`);
        return;
      }
      this.active.results.set(id, { ok: true, value: value.data, outcomeUnknown: false });
    }
    if (this.active && this.active.results.size === this.active.pending.size) {
      const active = this.active;
      this.active = null;
      active.resolve(active.order.map((id) => active.results.get(id)!));
    }
  }

  private onDisconnect(reason: string): void {
    if (this.closed) return;
    this.buffer += this.decoder.end();
    if (this.buffer.length > 0) this.failActive("Herdr socket ended with a truncated response");
    else this.failActive(reason);
  }

  private failActive(reason: string): void {
    if (this.closed) return;
    const active = this.active;
    this.active = null;
    this.closed = true;
    this.cleanup();
    if (!active) return;
    active.resolve(active.order.map((id) => {
      const request = active.pending.get(id)!;
      return failure(
        `${reason} during ${request.operation}`,
        request.mutation && request.written,
      );
    }));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cleanup(true);
  }

  private cleanup(graceful = false): void {
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = null;
    this.socket.removeAllListeners();
    if (this.destroyed) return;
    this.destroyed = true;
    if (graceful) this.socket.end();
    this.socket.destroy();
  }
}

/**
 * What `herdr status server --json` says about the default server right now.
 *
 * Exported because it is not only the client's own gate. The Setup row for Herdr reports
 * this state to the operator - "installed, server stopped" is a different repair from "not
 * installed" - and it must read the same three answers the transport does rather than
 * inventing a fourth.
 */
export type HerdrProbe =
  | { state: "ready"; socket: string; version: string }
  | { state: "stopped"; socket: string }
  | { state: "failed"; error: string; retryable: boolean };

export interface HerdrClient {
  probe(): Promise<HerdrProbe>;
  ensureReady(): Promise<HerdrResult<string>>;
  snapshotWithProcesses(): Promise<HerdrResult<{
    snapshot: HerdrSnapshot;
    processes: Map<string, HerdrProcessInfo | null>;
  }>>;
  read(paneId: string): Promise<HerdrResult<string>>;
  sendText(paneId: string, text: string): Promise<TerminalResult>;
  sendKeys(paneId: string, keys: readonly string[]): Promise<TerminalResult>;
  sendInput(paneId: string, text: string, keys?: readonly string[]): Promise<TerminalResult>;
  focusAgent(paneId: string): Promise<TerminalResult>;
  createWorkspace(spec: { label: string; cwd: string; focus: boolean }): Promise<HerdrResult<HerdrWorkspaceCreated>>;
  splitPane(spec: { paneId: string; cwd: string }): Promise<HerdrResult<HerdrPane>>;
  renameWorkspace(workspaceId: string, label: string): Promise<TerminalResult>;
  closeWorkspace(workspaceId: string): Promise<TerminalResult>;
}

export function createHerdrClient(
  exec: TerminalExec,
  binSpec: BinSpec,
  overrides: Partial<HerdrClientDeps> = {},
): HerdrClient {
  const deps = { ...defaultDeps, ...overrides };
  const bin = () => resolveBin(binSpec);
  const env = () => binEnv(binSpec);

  const probe = async (timeoutMs = deps.readTimeoutMs): Promise<HerdrProbe> => {
    const result = await exec(bin(), ["status", "server", "--json"], {
      timeoutMs,
      env: env(),
    });
    if (result.code !== 0) {
      const why = result.outcomeUnknown ? "did not finish" : "failed";
      return {
        state: "failed",
        error: `Herdr server status ${why}: ${result.stderr.trim() || "no status was returned"}`,
        retryable: true,
      };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(result.stdout);
    } catch {
      return { state: "failed", error: "Herdr server status returned malformed JSON", retryable: false };
    }
    const parsed = StatusSchema.safeParse(raw);
    if (!parsed.success) {
      return { state: "failed", error: "Herdr server status returned an invalid response", retryable: false };
    }
    const status = parsed.data;
    if (!status.running) return { state: "stopped", socket: status.socket };
    // One reading of "the server reported no version", used by the gate and by the sentence
    // that explains it. They disagreed once: the gate rejected any falsy version while the
    // message only tested for null, so an empty string was refused and then printed into the
    // slot where a version number goes.
    const version = status.version || null;
    const protocol = status.protocol;
    if (
      protocol === null ||
      protocol < HERDR_MIN_PROTOCOL ||
      version === null ||
      !versionAtLeast(version, HERDR_MIN_VERSION)
    ) {
      // A reported version stands in apposition to "server" and reads as one phrase. A
      // missing one cannot: "Herdr server no version on no protocol is incompatible" is not
      // a sentence, and this refusal exists to be read. Say what was missing after the verb
      // instead, and leave the ordinary case exactly as it reads.
      const reported = version !== null && protocol !== null
        ? `${version} on protocol ${protocol} is incompatible`
        : `is incompatible and reported ${version ? `version ${version}` : "no version"}`
          + ` on ${protocol === null ? "no protocol" : `protocol ${protocol}`}`;
      return {
        state: "failed",
        error: `Herdr server ${reported}. Mission Control requires Herdr ${HERDR_MIN_VERSION} or newer on protocol ${HERDR_MIN_PROTOCOL} or newer; update Herdr.`,
        retryable: false,
      };
    }
    // Herdr's own verdict, which is about the running server against the installed CLI and
    // not about us. It is a separate sentence because it has a separate repair: the operator
    // has the supported Herdr already, and updating it again changes nothing.
    if (status.compatible !== true || status.restart_needed) {
      return {
        state: "failed",
        error: `Herdr reports its running server is out of date with the installed ${version} CLI; restart the Herdr server.`,
        retryable: false,
      };
    }
    return { state: "ready", socket: status.socket, version };
  };

  const ensureReady = async (): Promise<HerdrResult<string>> => {
    const deadline = deps.now() + deps.actionTimeoutMs;
    const remaining = (): number => deadline - deps.now();
    const probeBeforeDeadline = async (): Promise<HerdrProbe | null> => {
      const budget = remaining();
      return budget > 0 ? probe(Math.min(deps.readTimeoutMs, budget)) : null;
    };
    const pollBeforeDeadline = async (): Promise<HerdrProbe | null> => {
      const budget = remaining();
      if (budget <= 0) return null;
      await deps.sleep(Math.min(deps.readyPollMs, budget));
      return probeBeforeDeadline();
    };
    let lastError = "Herdr server did not become ready";
    const notReady = (): HerdrResult<string> =>
      failure(`${lastError}. Start Herdr or restart its server, then try again.`);

    let initial = await probeBeforeDeadline();
    while (initial?.state === "failed" && initial.retryable) {
      lastError = initial.error;
      initial = await pollBeforeDeadline();
    }
    if (!initial) return notReady();
    if (initial.state === "ready") return { ok: true, value: initial.socket, outcomeUnknown: false };
    if (initial.state === "failed") {
      if (!initial.retryable) return failure(initial.error);
      lastError = initial.error;
      return notReady();
    }
    try {
      const executable = bin();
      const child = deps.spawnDetached(executable, ["server"], {
        detached: true,
        stdio: "ignore",
        env: env(),
      });
      // Spawn failures may arrive asynchronously. The readiness loop below owns the
      // actionable error and also covers a concurrent creator winning the socket race.
      child.on?.("error", () => {});
      child.unref();
    } catch {
      // A concurrent creator may have won the socket race. The readiness loop is authoritative.
    }
    while (true) {
      const current = await pollBeforeDeadline();
      if (!current) break;
      if (current.state === "ready") return { ok: true, value: current.socket, outcomeUnknown: false };
      if (current.state === "failed") lastError = current.error;
    }
    return notReady();
  };

  const socketFor = async (autoStart: boolean): Promise<HerdrResult<string>> =>
    autoStart ? ensureReady() : probe().then((value): HerdrResult<string> => {
      if (value.state === "ready") return { ok: true, value: value.socket, outcomeUnknown: false };
      if (value.state === "stopped") return failure("Herdr server is not running");
      return failure(value.error);
    });

  const withKnownSocket = async <T>(
    socketPath: string,
    timeoutMs: number,
    work: (batch: SocketBatch) => Promise<HerdrResult<T>>,
  ): Promise<HerdrResult<T>> => {
    const opened = await SocketBatch.open(socketPath, deps, timeoutMs);
    if (!opened.ok) return opened;
    try {
      return await work(opened.value);
    } finally {
      opened.value.close();
    }
  };

  const withSocket = async <T>(
    timeoutMs: number,
    work: (batch: SocketBatch) => Promise<HerdrResult<T>>,
    autoStart = false,
  ): Promise<HerdrResult<T>> => {
    const status = await socketFor(autoStart);
    return status.ok ? withKnownSocket(status.value, timeoutMs, work) : status;
  };

  const sendOne = async <T>(batch: SocketBatch, request: Request<T>): Promise<HerdrResult<T>> => {
    const [result] = await batch.send([request]);
    return result ?? failure(`Herdr ${request.operation} did not settle`);
  };

  const oneAt = async <T>(
    socketPath: string,
    request: Request<T>,
    timeoutMs = request.mutation ? deps.actionTimeoutMs : deps.readTimeoutMs,
  ): Promise<HerdrResult<T>> => withKnownSocket(socketPath, timeoutMs, (batch) => sendOne(batch, request));

  const one = async <T>(
    request: Request<T>,
    timeoutMs = request.mutation ? deps.actionTimeoutMs : deps.readTimeoutMs,
    autoStart = false,
  ): Promise<HerdrResult<T>> => withSocket(timeoutMs, (batch) => sendOne(batch, request), autoStart);

  const mutate = async <T>(request: Request<T>, autoStart = false): Promise<TerminalResult> =>
    asTerminal(await one(request, deps.actionTimeoutMs, autoStart));

  return {
    probe,
    ensureReady,
    snapshotWithProcesses: async () => {
      const status = await socketFor(false);
      if (!status.ok) return status;

      // Stable 0.8.2 serves one request per connection: it closes after the first response,
      // including when more JSONL lines are already buffered. Snapshot and process details
      // therefore share one validated socket endpoint, not one connection. The pool below
      // keeps the total request count and concurrent file descriptors bounded.
      const snapshotResult = await oneAt(status.value, {
        method: "session.snapshot",
        params: {},
        schema: SnapshotSchema,
        mutation: false,
        operation: "session snapshot",
      });
      if (!snapshotResult.ok) return snapshotResult;
      if (snapshotResult.value.snapshot.protocol < HERDR_MIN_PROTOCOL) {
        return failure(`Herdr session snapshot used unsupported protocol ${snapshotResult.value.snapshot.protocol}`);
      }
      const panes = snapshotResult.value.snapshot.panes;
      if (panes.length + 1 > MAX_REQUESTS) {
        return failure("Herdr session snapshot exceeded the bounded pane request limit");
      }
      const results: HerdrResult<z.infer<typeof ProcessInfoSchema>>[] = Array.from({ length: panes.length });
      let next = 0;
      const workers = Array.from(
        { length: Math.min(MAX_PARALLEL_SOCKETS, panes.length) },
        async () => {
          while (next < panes.length) {
            const index = next;
            next += 1;
            const pane = panes[index]!;
            results[index] = await oneAt(status.value, {
              method: "pane.process_info",
              params: { pane_id: pane.pane_id },
              schema: ProcessInfoSchema,
              mutation: false,
              operation: `pane process info for ${pane.pane_id}`,
            });
          }
        },
      );
      await Promise.all(workers);
      const processes = new Map<string, HerdrProcessInfo | null>();
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index]!;
        const expected = panes[index]!.pane_id;
        if (!result.ok) {
          if (result.code === "pane_not_found") {
            processes.set(expected, null);
            continue;
          }
          return result;
        }
        if (result.value.process_info.pane_id !== expected || processes.has(expected)) {
          return failure("Herdr pane process identities did not match the snapshot");
        }
        processes.set(expected, result.value.process_info);
      }
      return {
        ok: true,
        value: { snapshot: snapshotResult.value.snapshot, processes },
        outcomeUnknown: false,
      };
    },
    read: async (paneId) => {
      const result = await one({
        method: "pane.read",
        params: { pane_id: paneId, source: "visible", format: "text", strip_ansi: true },
        schema: PaneReadSchema,
        mutation: false,
        operation: `pane read for ${paneId}`,
      });
      if (!result.ok) return result;
      if (result.value.read.pane_id !== paneId) return failure("Herdr pane read returned a mismatched pane id");
      return { ok: true, value: result.value.read.text, outcomeUnknown: false };
    },
    sendText: (paneId, text) => mutate({
      method: "pane.send_text", params: { pane_id: paneId, text }, schema: OkSchema,
      mutation: true, operation: `text write to ${paneId}`,
    }),
    sendKeys: (paneId, keys) => mutate({
      method: "pane.send_keys", params: { pane_id: paneId, keys }, schema: OkSchema,
      mutation: true, operation: `key write to ${paneId}`,
    }),
    sendInput: (paneId, text, keys = []) => mutate({
      method: "pane.send_input", params: { pane_id: paneId, text, keys }, schema: OkSchema,
      mutation: true, operation: `bracket-aware paste to ${paneId}`,
    }),
    focusAgent: (paneId) => mutate({
      method: "agent.focus",
      params: { target: paneId },
      schema: AgentFocusedSchema.refine(
        (focused) => focused.type !== "agent_info" || focused.agent.pane_id === paneId,
        { message: "focused pane id did not match the request" },
      ),
      mutation: true,
      operation: `agent focus for ${paneId}`,
    }),
    createWorkspace: (spec) => one({
      method: "workspace.create",
      params: { label: spec.label, cwd: spec.cwd, focus: spec.focus },
      schema: WorkspaceCreatedSchema.refine(
        ({ workspace, root_pane: rootPane }) =>
          workspace.label === spec.label && rootPane.cwd === spec.cwd,
        { message: "created workspace label or cwd did not match the request" },
      ),
      mutation: true,
      operation: `workspace create for ${spec.label}`,
    }, deps.actionTimeoutMs, true),
    splitPane: async (spec) => {
      const result = await one({
        method: "pane.split",
        params: {
          target_pane_id: spec.paneId,
          direction: "right",
          ratio: 0.333,
          cwd: spec.cwd,
          focus: false,
        },
        schema: PaneCreatedSchema,
        mutation: true,
        operation: `pane split beside ${spec.paneId}`,
      });
      return result.ok
        ? { ok: true, value: result.value.pane, outcomeUnknown: false }
        : result;
    },
    renameWorkspace: (workspaceId, label) => mutate({
      method: "workspace.rename",
      params: { workspace_id: workspaceId, label },
      schema: WorkspaceInfoSchema.refine(
        ({ workspace }) => workspace.workspace_id === workspaceId && workspace.label === label,
        { message: "renamed workspace identity did not match the request" },
      ),
      mutation: true,
      operation: `workspace rename for ${workspaceId}`,
    }),
    closeWorkspace: (workspaceId) => mutate({
      method: "workspace.close", params: { workspace_id: workspaceId }, schema: OkSchema,
      mutation: true, operation: `workspace close for ${workspaceId}`,
    }),
  };
}
