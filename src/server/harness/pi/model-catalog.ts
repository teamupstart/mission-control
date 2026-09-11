import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import {
  HARNESS_MODEL_CATALOG_LIMITS,
  ModelIdSchema,
  type HarnessModelCatalogProblem,
} from "@shared/protocol.ts";
import { modelLabel, type HarnessModelChoice, type HarnessModelInputMode } from "@shared/model.ts";
import type { ModelCatalogDiscoveryResult } from "../types.ts";
import {
  agentSubprocessEnv,
  cleanupAgentSubprocessEnv,
} from "../../agent-subprocess-env.ts";
import { resolveBinPath } from "../../util/exec.ts";


/** Exact isolation flags for the prompt-free, no-session Pi catalog probe. */
export const PI_MODEL_CATALOG_ARGS = [
  "--mode",
  "rpc",
  "--no-session",
  "--offline",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
  "--no-tools",
  "--no-approve",
] as const;

/**
 * Measured against Pi 0.84.2: 38 rows, 16,888 stdout bytes, 164 stderr bytes,
 * and 795ms elapsed. These ceilings leave ample headroom without making a local
 * configuration an unbounded HTTP response or child-process buffer.
 */
export const PI_MODEL_CATALOG_BOUNDS = {
  timeoutMs: 5_000,
  stdoutBytes: 1_048_576,
  stderrBytes: 65_536,
  rows: HARNESS_MODEL_CATALOG_LIMITS.choices,
  labelChars: HARNESS_MODEL_CATALOG_LIMITS.labelChars,
  providerChars: HARNESS_MODEL_CATALOG_LIMITS.providerChars,
  inputModes: HARNESS_MODEL_CATALOG_LIMITS.inputModes,
  closeGraceMs: 100,
} as const;

export interface PiCatalogExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error: boolean;
}

/** The child-process slice used by discovery, kept injectable for protocol tests. */
export interface PiCatalogChild {
  stdout: AsyncIterable<Buffer | string | Uint8Array>;
  stderr: AsyncIterable<Buffer | string | Uint8Array>;
  send(data: string): void;
  endInput(): void;
  /** Reports a process-boundary failure without claiming the child has exited. */
  error?: Promise<void>;
  exit: Promise<PiCatalogExit>;
  kill(signal: NodeJS.Signals): boolean;
}

export interface PiCatalogSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
  stdio: ["pipe", "pipe", "pipe"];
}

export interface PiModelCatalogDeps {
  spawn?: (
    executable: string,
    args: readonly string[],
    options: PiCatalogSpawnOptions,
  ) => PiCatalogChild;
  requestId?: () => string;
  bounds?: Partial<PiModelCatalogBounds>;
  signal?: AbortSignal;
}

export interface PiModelCatalogResolutionDeps {
  resolve?: (executable: string) => Promise<string | null>;
  discover?: (
    executable: string,
    deps?: PiModelCatalogDeps,
  ) => Promise<ModelCatalogDiscoveryResult>;
  signal?: AbortSignal;
}

export type PiModelCatalogBounds = {
  [K in keyof typeof PI_MODEL_CATALOG_BOUNDS]: number;
};

const EXPECTED_COMMAND = "get_available_models";

function failure(problem: HarnessModelCatalogProblem): ModelCatalogDiscoveryResult {
  return { ok: false, problem };
}

/** Resolve a configured Pi command exactly as launch does, while preserving fallback semantics. */
export async function discoverConfiguredPiModels(
  configuredExecutable: string,
  deps: PiModelCatalogResolutionDeps = {},
): Promise<ModelCatalogDiscoveryResult> {
  if (deps.signal?.aborted) return failure("process_failed");
  try {
    const executable = await (deps.resolve ?? resolveBinPath)(configuredExecutable);
    if (!executable) return failure("process_failed");
    return await (deps.discover ?? discoverPiModels)(executable, { signal: deps.signal });
  } catch {
    return failure("process_failed");
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizedLabel(
  value: unknown,
  id: string,
  bounds: PiModelCatalogBounds,
): string | null {
  const supplied = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  const candidate = supplied || modelLabel(id);
  if (!candidate) return null;
  return candidate.slice(0, bounds.labelChars);
}

function inputModes(
  value: unknown,
  bounds: PiModelCatalogBounds,
): HarnessModelInputMode[] {
  if (!Array.isArray(value)) return [];
  const modes: HarnessModelInputMode[] = [];
  for (const entry of value) {
    if (entry !== "text" && entry !== "image") continue;
    if (!modes.includes(entry)) modes.push(entry);
  }
  return modes.slice(0, Math.max(0, bounds.inputModes));
}

function modelChoice(
  value: unknown,
  bounds: PiModelCatalogBounds,
): HarnessModelChoice | null {
  const raw = record(value);
  if (!raw) return null;
  if (
    typeof raw.provider !== "string" ||
    raw.provider.length < 1 ||
    raw.provider.length > bounds.providerChars ||
    typeof raw.id !== "string"
  ) {
    return null;
  }
  // The PROVIDER half and the MODEL half have different alphabets, and the difference is
  // load-bearing rather than tidy. A provider is an identifier Pi coins (`amazon-bedrock`,
  // `openrouter`); a model id is a string the provider itself owns, and Amazon Bedrock's
  // carry a `:` version suffix - `anthropic.claude-sonnet-4-5-20250929-v1:0`. One shared
  // alphabet meant the stricter half silently dropped 41 of the 121 Bedrock rows Pi lists.
  const providerSegment = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
  const modelSegment = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;
  if (
    !providerSegment.test(raw.provider) ||
    !raw.id.split("/").every((part) => modelSegment.test(part))
  ) {
    return null;
  }
  const id = `${raw.provider}/${raw.id}`;
  if (!ModelIdSchema.safeParse(id).success) return null;
  const label = normalizedLabel(raw.name, id, bounds);
  if (!label) return null;
  const modes = inputModes(raw.input, bounds);
  const contextWindow =
    typeof raw.contextWindow === "number" &&
    Number.isSafeInteger(raw.contextWindow) &&
    raw.contextWindow > 0 &&
    raw.contextWindow <= HARNESS_MODEL_CATALOG_LIMITS.contextWindow
      ? raw.contextWindow
      : null;
  return {
    id,
    label,
    hint: null,
    provider: raw.provider,
    contextWindow,
    reasoning: typeof raw.reasoning === "boolean" ? raw.reasoning : null,
    inputModes: modes,
  };
}

function choicesFromFrame(
  frame: Record<string, unknown>,
  bounds: PiModelCatalogBounds,
): ModelCatalogDiscoveryResult {
  const data = record(frame.data);
  if (!data || !Array.isArray(data.models)) return failure("invalid_response");
  if (data.models.length > bounds.rows) return failure("output_limit");
  const choices: HarnessModelChoice[] = [];
  const seen = new Set<string>();
  for (const raw of data.models) {
    const choice = modelChoice(raw, bounds);
    if (!choice || seen.has(choice.id)) continue;
    seen.add(choice.id);
    choices.push(choice);
  }
  return choices.length > 0 ? { ok: true, choices } : failure("unavailable");
}

function bytes(chunk: Buffer | string | Uint8Array): number {
  return typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
}

function spawnPiCatalogChild(
  executable: string,
  args: readonly string[],
  options: PiCatalogSpawnOptions,
): PiCatalogChild {
  const process = nodeSpawn(executable, [...args], options);
  // EPIPE can arrive asynchronously after write/end. It must not become an
  // unhandled EventEmitter error; process exit or the probe timeout owns the result.
  process.stdin.on("error", () => {});
  let processError = false;
  const error = new Promise<void>((resolve) => {
    process.once("error", () => {
      processError = true;
      resolve();
    });
  });
  const exit = new Promise<PiCatalogExit>((resolve) => {
    // `error` is not terminal: Node also emits it when a kill fails. Only `close`
    // proves the child and its stdio are gone, so the adapter's SIGKILL timer stays armed.
    process.once("close", (code, signal) => resolve({ code, signal, error: processError }));
  });
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    send: (data) => {
      process.stdin.write(data);
    },
    endInput: () => {
      process.stdin.end();
    },
    error,
    exit,
    kill: (signal) => process.kill(signal),
  };
}

/**
 * Discover the configured Pi installation's account-aware models through one isolated
 * JSONL RPC request. Every outcome is stable and non-secret; raw frames, child errors,
 * stdout, stderr, and model objects are discarded inside this boundary.
 */
export async function discoverPiModels(
  executable: string,
  deps: PiModelCatalogDeps = {},
): Promise<ModelCatalogDiscoveryResult> {
  const spawn = deps.spawn ?? spawnPiCatalogChild;
  const requestId = (deps.requestId ?? randomUUID)();
  const bounds = { ...PI_MODEL_CATALOG_BOUNDS, ...deps.bounds };

  if (deps.signal?.aborted) return failure("process_failed");

  const env = agentSubprocessEnv(process.env, { loopbackAccess: true });
  let child: PiCatalogChild;
  try {
    child = spawn(executable, PI_MODEL_CATALOG_ARGS, {
      cwd: tmpdir(),
      env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    cleanupAgentSubprocessEnv(env);
    return failure("process_failed");
  }

  return await new Promise<ModelCatalogDiscoveryResult>((resolve) => {
    let settled = false;
    let closing = false;
    let exited = false;
    let pendingResult: ModelCatalogDiscoveryResult = failure("process_failed");
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let pending = "";
    let stdinClosed = false;
    let sawResponse = false;
    let stdoutDone = false;
    let cleanExit: PiCatalogExit | null = null;
    let cleanupSignalled = false;
    let removeAbortListener = (): void => {};
    const decoder = new StringDecoder("utf8");
    const timers = new Set<ReturnType<typeof setTimeout>>();

    const schedule = (fn: () => void, ms: number): ReturnType<typeof setTimeout> => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        fn();
      }, ms);
      timers.add(timer);
      return timer;
    };

    const clearTimers = (): void => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    };

    const closeInput = (): void => {
      if (stdinClosed) return;
      stdinClosed = true;
      try {
        child.endInput();
      } catch {
        // Cleanup is best-effort here; the process signal below is authoritative.
      }
    };

    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      removeAbortListener();
      closeInput();
      cleanupAgentSubprocessEnv(env);
      resolve(pendingResult);
    };

    const finish = (result: ModelCatalogDiscoveryResult): void => {
      if (closing || settled) return;
      closing = true;
      pendingResult = result;
      clearTimers();
      closeInput();
      if (exited) {
        settle();
        return;
      }
      const terminate = (): void => {
        if (exited) return;
        const signalChild = (signal: NodeJS.Signals): void => {
          try {
            if (child.kill(signal)) cleanupSignalled = true;
          } catch {
            // The exit/deadline arms below still bound completion.
          }
        };
        signalChild("SIGTERM");
        schedule(() => {
          if (exited) return;
          signalChild("SIGKILL");
          // If neither cleanup signal reached the child, do not cache a successful
          // response without terminal confirmation that the probe actually completed.
          if (!cleanupSignalled && pendingResult.ok) {
            pendingResult = failure("process_failed");
          }
          schedule(settle, bounds.closeGraceMs);
        }, bounds.closeGraceMs);
      };
      // A successful one-request probe has already closed stdin. Give that graceful
      // shutdown one short turn before signalling, so the normal path never receives a
      // needless SIGTERM. Failures terminate immediately and still hard-kill after grace.
      if (result.ok) schedule(terminate, bounds.closeGraceMs);
      else terminate();
    };

    const handleLine = (line: string): void => {
      if (closing || !line.trim()) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        finish(failure("invalid_response"));
        return;
      }
      const frame = record(parsed);
      if (!frame) return;
      if (frame.type === "response") sawResponse = true;
      if (frame.id !== requestId) return;
      if (frame.type !== "response" || frame.command !== EXPECTED_COMMAND) return;
      if (frame.success !== true) {
        const error = typeof frame.error === "string" ? frame.error.toLowerCase() : "";
        finish(failure(/unsupported|unknown command|not supported/.test(error) ? "unsupported" : "rpc_failed"));
        return;
      }
      finish(choicesFromFrame(frame, bounds));
    };

    const finishCleanExit = (): void => {
      if (closing || !stdoutDone || !cleanExit) return;
      finish(failure(sawResponse ? "invalid_response" : "unavailable"));
    };

    const onStdoutEnd = (): void => {
      if (stdoutDone) return;
      stdoutDone = true;
      if (!closing) {
        pending += decoder.end();
        if (pending.trim()) handleLine(pending);
      }
      if (closing) return;
      if (sawResponse) {
        finish(failure("invalid_response"));
      } else if (cleanExit) {
        finishCleanExit();
      } else {
        // EOF says no response remains, but only terminal close supplies the exit code.
        // Close stdin and wait so a later non-zero close cannot be mislabeled unavailable.
        closeInput();
      }
    };

    const onStdout = (chunk: Buffer | string | Uint8Array): void => {
      if (closing) return;
      stdoutBytes += bytes(chunk);
      if (stdoutBytes > bounds.stdoutBytes) {
        finish(failure("output_limit"));
        return;
      }
      pending += decoder.write(
        typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk),
      );
      let newline: number;
      while (!closing && (newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        handleLine(line);
      }
    };
    const onStderr = (chunk: Buffer | string | Uint8Array): void => {
      if (closing) return;
      stderrBytes += bytes(chunk);
      if (stderrBytes > bounds.stderrBytes) finish(failure("output_limit"));
    };
    const observe = (
      stream: PiCatalogChild["stdout"],
      onData: (chunk: Buffer | string | Uint8Array) => void,
      onEnd?: () => void,
    ): void => {
      void (async () => {
        try {
          for await (const chunk of stream) onData(chunk);
          onEnd?.();
        } catch {
          finish(failure("process_failed"));
        }
      })();
    };
    observe(child.stdout, onStdout, onStdoutEnd);
    observe(child.stderr, onStderr);
    child.error?.then(
      () => finish(failure("process_failed")),
      () => finish(failure("process_failed")),
    );
    const onExit = (exit: PiCatalogExit): void => {
      exited = true;
      if (closing) {
        if (
          pendingResult.ok &&
          !cleanupSignalled &&
          (exit.error || exit.code !== 0 || exit.signal !== null)
        ) {
          pendingResult = failure("process_failed");
        }
        settle();
        return;
      }
      if (exit.error || exit.code !== 0 || exit.signal !== null) {
        finish(failure("process_failed"));
        return;
      }
      // A clean process exit does not imply stdout has drained. AsyncIterable-backed
      // children can resolve exit before their last response chunk is yielded, so latch
      // the exit and decide only after EOF flushes the decoder and pending line.
      cleanExit = exit;
      finishCleanExit();
    };
    child.exit.then(onExit, () => onExit({ code: null, signal: null, error: true }));

    if (deps.signal) {
      const onAbort = (): void => finish(failure("process_failed"));
      deps.signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => deps.signal?.removeEventListener("abort", onAbort);
      if (deps.signal.aborted) onAbort();
    }

    if (!closing) schedule(() => finish(failure("timeout")), bounds.timeoutMs);
    try {
      if (closing) return;
      const request = `${JSON.stringify({ id: requestId, type: EXPECTED_COMMAND })}\n`;
      child.send(request);
    } catch {
      finish(failure("process_failed"));
    }
  });
}
