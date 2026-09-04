import { tmpdir } from "node:os";
import {
  HARNESS_MODEL_CATALOG_LIMITS,
  ModelIdSchema,
  type HarnessModelCatalogChoice,
  type HarnessModelCatalogProblem,
} from "@shared/protocol.ts";
import { modelLabel, type HarnessModelInputMode } from "@shared/model.ts";
import { agentSubprocessEnv, cleanupAgentSubprocessEnv } from "../../agent-subprocess-env.ts";
import type { ModelCatalogDiscoveryResult } from "../types.ts";
import { AppServerClient, AppServerError, type AppServerTransport } from "./app-server/client.ts";
import type {
  InitializeResponse,
  Model,
  ModelListParams,
} from "./app-server/protocol.ts";
import { CLIENT_INFO } from "./sdk.ts";
import { spawnAppServer } from "./sdk-deps.ts";

// Discover the configured Codex installation's models through one app-server request.
//
// This is the THIRD module that speaks app-server vocabulary, after the transport-shaped
// `app-server/client.ts` and the driver in `sdk.ts` that owns what each method means. It
// earns the seat by speaking exactly two methods and by reusing both of those modules
// rather than restating either: `spawnAppServer` remains the only thing that starts a
// `codex app-server`, and `AppServerClient` remains the only thing that correlates a
// request with its reply. What is here is the catalog question and nothing else.
//
// The one thing this probe must never do is cost anything. It runs the handshake, asks
// `model/list`, and exits. No thread is started and no turn is run, which is asserted in
// `test/codex-model-catalog.test.ts` rather than left as a claim about the code's shape.

/** The method name, and the only protocol vocabulary this file introduces. */
const MODEL_LIST = "model/list";

/**
 * The row fields `modelChoice` reads, named against the generated type.
 *
 * A `Pick` of keys that must exist: if any of these is renamed or removed upstream, the
 * next `node scripts/codex-app-server-bindings.mjs` makes this fail to COMPILE, which is
 * the whole reason the bindings are vendored. The response itself is still validated
 * structurally at runtime, because a row that arrived over a pipe is untrusted input no
 * matter what the pinned type says about it.
 */
type ReadModelFields = Pick<
  Model,
  "id" | "displayName" | "description" | "hidden" | "supportedReasoningEfforts" | "inputModalities"
>;

/**
 * Read one field of an untrusted row by a name the pinned type has to have.
 *
 * The key is checked at compile time and the value stays `unknown`, which is the honest
 * pair: the name is a fact about the protocol, and the contents are a fact about whatever
 * actually came down the pipe. Every runtime check below therefore remains necessary.
 */
function field(raw: Record<string, unknown>, key: keyof ReadModelFields): unknown {
  return raw[key];
}

/**
 * Measured against codex-cli 0.146.0. On the wire the request is nearly free: the
 * `initialize` handshake answered in 593ms cold and `model/list` in 2ms, returning a
 * 6035-byte payload of six visible rows with no cursor.
 *
 * End to end through this module, though, four consecutive runs took 974ms, 1936ms,
 * 2714ms and 4079ms - spawning the binary, not talking to it, is what varies, and it
 * varies by a factor of four on an unloaded machine.
 *
 * Deliberately its own constant rather than a shared one with Pi's. The two probes have
 * different shapes - Pi reads a line protocol it frames itself, this one rides a client
 * that already frames, and Pi's leaner `--no-*` launch measured 795ms - so a single
 * number would have to be the looser of the two for both, and would then stop describing
 * either.
 */
export const CODEX_MODEL_CATALOG_BOUNDS = {
  /**
   * Roughly four times the slowest run measured, which is deliberately generous.
   *
   * A probe that times out spuriously is worse than a slow one: the browser has already
   * painted the shipped rows synchronously, so a slow answer costs a spinner, while a
   * false timeout costs a degraded notice and a stale catalog for no reason. The 4079ms
   * run would have failed under a bound sized to the wire cost alone.
   */
  timeoutMs: 15_000,
  /**
   * Refused post-parse, per page.
   *
   * The shared transport owns framing and reads bytes this module never sees, so this is
   * a cap on what is ACCEPTED rather than on what is read - adding a byte counter to the
   * transport would put it in a live session's hot path to bound a probe. Forty times the
   * measured payload, so an implausible page is refused before it is mapped or cached.
   */
  responseBytes: 262_144,
  /** The protocol's own ceiling for a carried catalog. */
  rows: HARNESS_MODEL_CATALOG_LIMITS.choices,
  /** A cursor that never says "no more pages" stops here rather than paging forever. */
  pages: 8,
  labelChars: HARNESS_MODEL_CATALOG_LIMITS.labelChars,
  hintChars: HARNESS_MODEL_CATALOG_LIMITS.hintChars,
  inputModes: HARNESS_MODEL_CATALOG_LIMITS.inputModes,
} as const;

export type CodexModelCatalogBounds = {
  [K in keyof typeof CODEX_MODEL_CATALOG_BOUNDS]: number;
};

export interface CodexModelCatalogDeps {
  /** Open one connection. Replaced by a scripted transport in tests; never spawns there. */
  connect?: (executable: string) => Promise<AppServerTransport>;
  bounds?: Partial<CodexModelCatalogBounds>;
  signal?: AbortSignal;
}

/** Nothing the server volunteers is read: a probe answers no approvals and reads no turns. */
const IGNORE_SERVER_TRAFFIC = {
  request: () => {},
  notification: () => {},
};

function failure(problem: HarnessModelCatalogProblem): ModelCatalogDiscoveryResult {
  return { ok: false, problem };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const collapsed = value.trim().replace(/\s+/g, " ");
  return collapsed ? collapsed.slice(0, max) : null;
}

function inputModes(value: unknown, bounds: CodexModelCatalogBounds): HarnessModelInputMode[] {
  if (!Array.isArray(value)) return [];
  const modes: HarnessModelInputMode[] = [];
  for (const entry of value) {
    if (entry !== "text" && entry !== "image") continue;
    if (!modes.includes(entry)) modes.push(entry);
  }
  return modes.slice(0, Math.max(0, bounds.inputModes));
}

/**
 * One `Model` row as a browser-safe choice, or null when it is not one we can offer.
 *
 * `id` rather than the row's `model` field. The two carried the same string on every row
 * measured, and `id` is what the picker's value has to be: it is the catalog's own key,
 * and `model` is the wire name a future build could legitimately diverge from it. A test
 * pins this choice so a silent swap upstream shows up as a failure.
 *
 * `provider` and `contextWindow` stay null because Codex reports neither on a row, and the
 * contract reads null as "no trustworthy claim" rather than as a missing value to guess at.
 */
function modelChoice(
  value: unknown,
  bounds: CodexModelCatalogBounds,
): HarnessModelCatalogChoice | null {
  const raw = record(value);
  if (!raw) return null;
  // Hidden rows are the ones Codex keeps out of its own picker. Mirroring that keeps the
  // two lists the same list, which is the point of discovering it at all.
  if (field(raw, "hidden") === true) return null;
  const rawId = field(raw, "id");
  if (typeof rawId !== "string") return null;
  const id = rawId.trim();
  if (!ModelIdSchema.safeParse(id).success) return null;
  const efforts = field(raw, "supportedReasoningEfforts");
  return {
    id,
    label: normalizedText(field(raw, "displayName"), bounds.labelChars) ?? modelLabel(id) ?? id,
    hint: normalizedText(field(raw, "description"), bounds.hintChars),
    provider: null,
    contextWindow: null,
    reasoning: Array.isArray(efforts) ? efforts.length > 0 : null,
    inputModes: inputModes(field(raw, "inputModalities"), bounds),
  };
}

/** An opaque cursor with another page behind it, or null when the listing is done. */
function nextCursor(response: Record<string, unknown>): string | null {
  const cursor = response.nextCursor;
  return typeof cursor === "string" && cursor.trim() ? cursor : null;
}

/**
 * Why a call failed, in the vocabulary the catalog service degrades on.
 *
 * `unsupported` is reserved for a Codex that does not have this method - an older build,
 * which is an ordinary thing for an operator to be running and not a fault to report. A
 * rejection that is not a JSON-RPC error at all came from the connection ending underneath
 * the request, which is a process failure however the server felt about the method.
 */
function callFailure(error: unknown): ModelCatalogDiscoveryResult {
  if (!(error instanceof AppServerError)) return failure("process_failed");
  const unknownMethod =
    error.code === -32601 || /unknown method|unsupported|not found|unrecognized/i.test(error.message);
  return failure(unknownMethod ? "unsupported" : "rpc_failed");
}

async function readCatalog(
  client: AppServerClient,
  bounds: CodexModelCatalogBounds,
): Promise<ModelCatalogDiscoveryResult> {
  try {
    await client.request<InitializeResponse>("initialize", {
      clientInfo: CLIENT_INFO,
      // `model/list` lives behind the experimental surface, which is the same opt-in the
      // driver's own handshake takes. Notifications are not opted out of here: this
      // connection runs no turn, so there are no deltas to mute.
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
  } catch (error) {
    return callFailure(error);
  }

  const choices: HarnessModelCatalogChoice[] = [];
  const seen = new Set<string>();
  let rowsSeen = 0;
  let cursor: string | null = null;

  for (let page = 0; page < bounds.pages; page += 1) {
    // Typed against the pinned params so a renamed cursor fails the build. The RESULT is
    // deliberately read as `unknown`; see `field`.
    const params: ModelListParams = cursor === null ? {} : { cursor };
    let response: unknown;
    try {
      response = await client.request(MODEL_LIST, params);
    } catch (error) {
      return callFailure(error);
    }
    if (JSON.stringify(response ?? null).length > bounds.responseBytes) {
      return failure("output_limit");
    }
    const frame = record(response);
    const rows = frame?.data;
    if (!frame || !Array.isArray(rows)) return failure("invalid_response");
    rowsSeen += rows.length;
    // A catalog too large to carry is refused rather than silently truncated: a picker
    // showing the first N of an unknown number is worse than one saying it could not look.
    if (rowsSeen > bounds.rows) return failure("output_limit");
    for (const raw of rows) {
      const choice = modelChoice(raw, bounds);
      if (!choice || seen.has(choice.id)) continue;
      seen.add(choice.id);
      choices.push(choice);
    }
    cursor = nextCursor(frame);
    if (!cursor) break;
  }

  // Order is the server's, best-first, because the picker renders the list as written and
  // Codex already returns its default first.
  return choices.length > 0 ? { ok: true, choices } : failure("unavailable");
}

/**
 * Start a probe connection, and make closing it also dispose of its state home.
 *
 * No `loopbackAccess`, unlike a dispatched session's environment: that grant exists so a
 * running agent can call Mission Control back, and this connection runs no turn. Omitting
 * it strips the daemon's bearer token from the child's environment entirely.
 *
 * `tmpdir()` as the cwd for the reason Pi's probe uses it: a catalog is a property of the
 * installation and the account, not of whichever repository happened to ask, and a probe
 * should not read an arbitrary checkout's Codex configuration on the way past.
 */
async function spawnProbeConnection(executable: string): Promise<AppServerTransport> {
  const env = agentSubprocessEnv(process.env);
  let transport: AppServerTransport;
  try {
    transport = spawnAppServer(executable, [], tmpdir(), env);
  } catch (error) {
    cleanupAgentSubprocessEnv(env);
    throw error;
  }
  return {
    ...transport,
    async close() {
      try {
        await transport.close();
      } finally {
        cleanupAgentSubprocessEnv(env);
      }
    },
  };
}

/**
 * Discover the configured Codex installation's models through one bounded app-server
 * request. Every outcome is a stable, non-secret discovery result: raw rows, account state
 * and child output are all discarded inside this boundary.
 */
export async function discoverCodexModels(
  executable: string,
  deps: CodexModelCatalogDeps = {},
): Promise<ModelCatalogDiscoveryResult> {
  const bounds = { ...CODEX_MODEL_CATALOG_BOUNDS, ...deps.bounds };
  if (deps.signal?.aborted) return failure("process_failed");

  let transport: AppServerTransport;
  try {
    transport = await (deps.connect ?? spawnProbeConnection)(executable);
  } catch {
    return failure("process_failed");
  }

  const client = new AppServerClient(transport, IGNORE_SERVER_TRAFFIC);
  // The pump's own rejection is delivered to every waiter, so the probe reads its outcome
  // from its request rather than from here. Swallowed so a dead connection cannot surface
  // as an unhandled rejection while the request is still settling.
  const pump = client.pump().then(
    () => undefined,
    () => undefined,
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener = (): void => {};

  try {
    return await Promise.race<ModelCatalogDiscoveryResult>([
      readCatalog(client, bounds),
      // The client deliberately has no timeout of its own - a turn has no honest one - so
      // the bound belongs to the caller that knows what it is waiting for.
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(failure("timeout")), bounds.timeoutMs);
      }),
      new Promise((resolve) => {
        const signal = deps.signal;
        if (!signal) return;
        const onAbort = (): void => resolve(failure("process_failed"));
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    removeAbortListener();
    await client.close();
    await pump;
  }
}
