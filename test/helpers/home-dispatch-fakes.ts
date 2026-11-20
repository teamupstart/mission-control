// Shared fakes for headless mode (FR-05), landed by P2 so every later phase builds and tests in
// parallel against stubs:
//
//   createFakeDaemon   serves a schema-valid canned reply for every `/dispatch/*` route, plus
//                      `/api/health`, over a real loopback socket (for `mctl`) or in process
//                      (for the mod), and records every request.
//   createFakeModHost  a `ModHost` that records every dialog, notice, toast, status, band, pane
//                      open and view, press and model-bound write.
//   createFakeClaude   a scriptable `claude` executable (re-exported from its own file).
//
// Nothing here spends model tokens or touches the operator's state.
//
// ADDING A FIXTURE. A phase that fills a route overrides only the responses it fills, in its own
// file `test/helpers/home-dispatch-fakes-<area>.ts` exporting `routes: FakeRouteOverrides`. It
// registers that file with one import and one entry in `AREA_FIXTURES` below. Whichever phase
// merges second rebases onto the first; the merge is mechanical.
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ZodType } from "zod";
import {
  HOME_DISPATCH_ROUTES,
  HomeDispatchAnswerRequestSchema,
  HomeDispatchConfigSchema,
  HomeDispatchConfirmResultSchema,
  HomeDispatchDraftConfirmSchema,
  HomeDispatchDraftCreateSchema,
  HomeDispatchDraftSummarySchema,
  HomeDispatchDraftUpdateSchema,
  HomeDispatchInboxSchema,
  HomeDispatchOptionsRequestSchema,
  HomeDispatchOptionsResponseSchema,
  HomeDispatchReceiptSchema,
  HomeDispatchResidentActionRequestSchema,
  HomeDispatchResidentActionResultSchema,
  HomeDispatchResidentsSchema,
  HomeDispatchSendRequestSchema,
  HomeDispatchSendResultSchema,
  HomeDispatchTranscriptSchema,
  CodexReadinessSchema,
  HomeSessionRegistrationAnswerSchema,
  HomeSessionRegistrationSchema,
  type CodexReadiness,
  type HomeDispatchConfig,
  type HomeDispatchConfirmResult,
  type HomeDispatchDraftSummary,
  type HomeDispatchInbox,
  type HomeDispatchOptionsResponse,
  type HomeDispatchReceipt,
  type HomeDispatchResidents,
  type HomeDispatchTranscript,
  type HomeSessionRegistrationAnswer,
} from "../../src/shared/home-dispatch.ts";
import { advertisedDaemonCapabilities } from "../../src/shared/daemon-protocol.ts";
import type {
  ModAskAnswer,
  ModAskQuestion,
  ModBand,
  ModFetchInit,
  ModFetchResult,
  ModHost,
  ModModelWrite,
  ModPaneOpen,
  ModState,
} from "../../src/mod/host.ts";
import { renderPane, type PaneProps, type PaneView } from "../../src/mod/pane/index.ts";

export { createFakeClaude } from "./home-dispatch-fake-claude.ts";
export type { FakeClaude, FakeClaudeInvocation, FakeClaudeState } from "./home-dispatch-fake-claude.ts";

/* ------------------------------------------------------------------ canned replies */

/** A repository root the canned replies agree on, so a test can assert against it. */
export const FAKE_REPO_ROOT = "/fake/repo";
export const FAKE_SESSION_ID = "session-fake-1";
export const FAKE_TASK_ID = "mc-91c2";
export const FAKE_REVIEW_ID = "review-1";
export const FAKE_TOKEN = "fake-token";

export const CANNED_REGISTRATION: HomeSessionRegistrationAnswer = {
  sessionId: FAKE_SESSION_ID,
  repoRoot: FAKE_REPO_ROOT,
  created: true,
  offerLauncher: true,
  counts: { running: 1, waiting: 1 },
  daemonVersion: "2.2.0",
  minModApi: 1,
  dashboardUrl: "http://127.0.0.1:7317/",
};

export const CANNED_INBOX: HomeDispatchInbox = {
  items: [
    {
      taskId: FAKE_TASK_ID,
      title: "logging cleanup",
      kind: "ship",
      state: "waiting",
      origin: "home-session",
      changedAt: 1_700_000_000_000,
      canMessage: true,
      agent: "claude",
      runtime: "sdk",
      pending: {
        reviewId: FAKE_REVIEW_ID,
        kind: "question",
        question: "Keep or delete the old logger?",
        options: ["Keep", "Delete"],
        allowsText: true,
        dashboardOnly: false,
      },
    },
    {
      taskId: "mc-b201",
      title: "flaky test",
      kind: "bugfix",
      state: "running",
      origin: "mctl",
      changedAt: 1_700_000_001_000,
      elapsedMs: 61_000,
      costUsd: 0.42,
      subagents: { running: 0, finished: 0 },
      canMessage: true,
      agent: "claude",
      runtime: "sdk",
    },
  ],
  needsYou: [FAKE_TASK_ID],
  counts: { waiting: 1, blocked: 0, ready: 0, running: 1, queued: 0, shelved: 0, failed: 0 },
  slots: { used: 1, ceiling: 4 },
  dashboardOnly: 0,
};

export const CANNED_CONFIG: HomeDispatchConfig = { launcher: { prompt: true } };

export const CANNED_RECEIPT: HomeDispatchReceipt = {
  reviewId: FAKE_REVIEW_ID,
  taskId: FAKE_TASK_ID,
  sent: "Keep",
  at: 1_700_000_002_000,
};

export const CANNED_OPTIONS: HomeDispatchOptionsResponse = {
  questions: [
    {
      id: "kind",
      header: "Kind",
      question: "What kind of task is this?",
      options: [
        { value: "ship", label: "Ship", description: "Change code and open a pull request" },
        { value: "scout", label: "Scout" },
      ],
    },
  ],
};

export const CANNED_DRAFT: HomeDispatchDraftSummary = {
  draftId: "draft-1",
  repoRoot: FAKE_REPO_ROOT,
  kind: "ship",
  kindLabel: "Ship",
  afterWork: "default-review",
  afterWorkApplies: true,
  words: "clean up logging",
  context: null,
  needs: [],
  brief: "clean up logging",
  text: "Ship: clean up logging, after work default-review, in /fake/repo.",
};

export const CANNED_CONFIRM: HomeDispatchConfirmResult = { choice: "start", taskId: FAKE_TASK_ID, started: true };

export const CANNED_RESIDENTS: HomeDispatchResidents = {
  residents: [
    {
      runId: "run-1",
      taskId: "mc-r001",
      name: "Agent Shepherd",
      builtIn: true,
      repos: 1,
      loopState: "waiting",
      needsYou: false,
      iteration: 3,
      nextWakeAt: null,
      pauseReason: null,
      wakeReason: null,
      runRequestedAt: null,
      contextPercent: 12,
      costUsd: 1.5,
    },
  ],
};

export const CANNED_TRANSCRIPT: HomeDispatchTranscript = {
  sessionId: "session-worker-1",
  messages: [{ id: "m1", role: "assistant", text: "Looking at the logger.", tools: [], ts: 1_700_000_000_500 }],
  next: 1,
  canMessage: true,
  state: "running",
  elapsedMs: 61_000,
  costUsd: 0.42,
  subagents: [],
};

export const CANNED_READINESS: CodexReadiness = {
  checkedAt: null,
  stale: false,
  accountChangeVisible: false,
  accountVerified: false,
  observed: { codexPath: null, binarySize: null, binaryMtime: null, authMtime: null, codexVersion: null, account: null },
  required: false,
  canStart: true,
  reviewPath: null,
  reviewsReady: false,
  workflows: [],
  reviewerSet: [],
  checks: [],
};

/* ------------------------------------------------------------------ route table */

type DispatchRoute = (typeof HOME_DISPATCH_ROUTES)[number];
/** `"GET /dispatch/inbox"`: a method and a path exactly as `HOME_DISPATCH_ROUTES` spells it. */
export type FakeRouteKey = DispatchRoute extends infer R
  ? R extends { method: infer M extends string; path: infer P extends string } ? `${M} ${P}` : never
  : never;
/** Any route the fake serves, `/dispatch/*` or not (for example `GET /api/health`). */
export type FakeAnyRouteKey = FakeRouteKey | `${"GET" | "POST" | "PUT" | "DELETE"} /api/${string}`;

export interface FakeRequest {
  method: string;
  /** The concrete path without its query string. */
  path: string;
  /** The route pattern it matched. */
  pattern: string;
  params: Record<string, string>;
  query: Record<string, string>;
  /** The parsed JSON body, or undefined when there was none. */
  body: unknown;
  headers: Record<string, string | undefined>;
}

export interface FakeReply {
  status?: number;
  body?: unknown;
  /** A raw text body (for example a server-sent-events frame); used instead of `body`. */
  raw?: string;
  contentType?: string;
}

export type FakeRoute = (request: FakeRequest) => FakeReply | Promise<FakeReply>;
export type FakeRouteOverrides = Partial<Record<FakeAnyRouteKey, FakeRoute>>;

const json = (body: unknown): FakeRoute => () => ({ body });

/** One canned, schema-valid reply for every `/dispatch/*` route. */
export const CANNED_ROUTES: Record<FakeRouteKey, FakeRoute> = {
  "POST /dispatch/sessions": json(CANNED_REGISTRATION),
  "GET /dispatch/inbox": json(CANNED_INBOX),
  "POST /dispatch/answers": json(CANNED_RECEIPT),
  "GET /dispatch/config": json(CANNED_CONFIG),
  "POST /dispatch/dispatch-options": json(CANNED_OPTIONS),
  "POST /dispatch/drafts": json(CANNED_DRAFT),
  "POST /dispatch/drafts/:id": json(CANNED_DRAFT),
  "POST /dispatch/drafts/:id/confirm": json(CANNED_CONFIRM),
  "GET /dispatch/readiness": json(CANNED_READINESS),
  "GET /dispatch/residents": json(CANNED_RESIDENTS),
  "POST /dispatch/residents/:runId/:action": json({}),
  "GET /dispatch/tasks/:taskId/transcript": json(CANNED_TRANSCRIPT),
  // The stream carries the existing `transcriptStreamHandler`'s frames. P2 serves only its idle
  // ping; the phase that reads the stream (P9, P10) overrides it with real frames.
  "GET /dispatch/tasks/:taskId/transcript/stream": () => ({ raw: "event: ping\ndata: \n\n", contentType: "text/event-stream" }),
  "POST /dispatch/tasks/:taskId/send": json({ ok: true, at: 1_700_000_003_000 }),
};

/** The response each route's canned reply must satisfy; the stream has none. */
export const ROUTE_RESPONSE_SCHEMAS: Record<FakeRouteKey, ZodType | null> = {
  "POST /dispatch/sessions": HomeSessionRegistrationAnswerSchema,
  "GET /dispatch/inbox": HomeDispatchInboxSchema,
  "POST /dispatch/answers": HomeDispatchReceiptSchema,
  "GET /dispatch/config": HomeDispatchConfigSchema,
  "POST /dispatch/dispatch-options": HomeDispatchOptionsResponseSchema,
  "POST /dispatch/drafts": HomeDispatchDraftSummarySchema,
  "POST /dispatch/drafts/:id": HomeDispatchDraftSummarySchema,
  "POST /dispatch/drafts/:id/confirm": HomeDispatchConfirmResultSchema,
  "GET /dispatch/readiness": CodexReadinessSchema,
  "GET /dispatch/residents": HomeDispatchResidentsSchema,
  "POST /dispatch/residents/:runId/:action": HomeDispatchResidentActionResultSchema,
  "GET /dispatch/tasks/:taskId/transcript": HomeDispatchTranscriptSchema,
  "GET /dispatch/tasks/:taskId/transcript/stream": null,
  "POST /dispatch/tasks/:taskId/send": HomeDispatchSendResultSchema,
};

/** The request body each POST route accepts. The fake answers 400 to one that does not parse. */
export const ROUTE_REQUEST_SCHEMAS: Partial<Record<FakeRouteKey, ZodType>> = {
  "POST /dispatch/sessions": HomeSessionRegistrationSchema,
  "POST /dispatch/answers": HomeDispatchAnswerRequestSchema,
  "POST /dispatch/dispatch-options": HomeDispatchOptionsRequestSchema,
  "POST /dispatch/drafts": HomeDispatchDraftCreateSchema,
  "POST /dispatch/drafts/:id": HomeDispatchDraftUpdateSchema,
  "POST /dispatch/drafts/:id/confirm": HomeDispatchDraftConfirmSchema,
  "POST /dispatch/residents/:runId/:action": HomeDispatchResidentActionRequestSchema,
  "POST /dispatch/tasks/:taskId/send": HomeDispatchSendRequestSchema,
};

/**
 * Per-phase fixture files, one entry each. Add `import { routes as inbox } from
 * "./home-dispatch-fakes-inbox.ts";` above and `inbox` here. Later entries win.
 */
export const AREA_FIXTURES: readonly FakeRouteOverrides[] = [];

/* ------------------------------------------------------------------ the fake daemon */

export interface FakeDaemonOptions {
  /** Whether the `headless-mode` flag is on. Default true. `setFlag` changes it later. */
  flag?: boolean;
  /** When set, `/dispatch/*` needs this `x-harness-token`. Default `FAKE_TOKEN`; `null` skips the check. */
  token?: string | null;
  /** Replies for this test only; they win over the area fixtures and the canned replies. */
  routes?: FakeRouteOverrides;
}

export interface FakeDaemonResponse {
  status: number;
  text: string;
  contentType: string;
}

export interface FakeDaemonRequestRecord extends FakeRequest {
  at: number;
}

export interface FakeDaemon {
  /** Answers one request in process, as the daemon would over HTTP. */
  handle: (method: string, pathAndQuery: string, body?: unknown, headers?: Record<string, string>) => Promise<FakeDaemonResponse>;
  /** Starts a loopback HTTP server and returns the port to set as `MISSION_PORT`. */
  listen: () => Promise<{ port: number; url: string }>;
  close: () => Promise<void>;
  setFlag: (enabled: boolean) => void;
  /** While down, `handle` rejects and the socket is closed, like a daemon that is not running. */
  setDown: (down: boolean) => void;
  /** Replaces one route's reply for the rest of the test. */
  override: (key: FakeAnyRouteKey, route: FakeRoute) => void;
  requests: FakeDaemonRequestRecord[];
}

const HEALTH: FakeRoute = (request) => ({
  body: {
    ok: true,
    service: "mission-control",
    version: CANNED_REGISTRATION.daemonVersion,
    pid: 0,
    capabilities: advertisedDaemonCapabilities({ headlessMode: request.headers["x-fake-flag"] === "on" }),
  },
});

function compile(pattern: string): { regex: RegExp; names: string[] } {
  const names: string[] = [];
  const source = pattern.replace(/:([A-Za-z]+)/g, (_m, name: string) => {
    names.push(name);
    return "([^/]+)";
  });
  return { regex: new RegExp(`^${source}$`), names };
}

export function createFakeDaemon(options: FakeDaemonOptions = {}): FakeDaemon {
  let flag = options.flag ?? true;
  let down = false;
  const token = options.token === undefined ? FAKE_TOKEN : options.token;
  const requests: FakeDaemonRequestRecord[] = [];

  const table = new Map<string, FakeRoute>(Object.entries(CANNED_ROUTES));
  table.set("GET /api/health", HEALTH);
  for (const fixture of [...AREA_FIXTURES, options.routes ?? {}]) {
    for (const [key, route] of Object.entries(fixture)) if (route) table.set(key, route);
  }
  const compiled = () => [...table.keys()].map((key) => ({ key, ...compile(key.slice(key.indexOf(" ") + 1)) }));

  async function handle(method: string, pathAndQuery: string, body?: unknown, headers: Record<string, string> = {}): Promise<FakeDaemonResponse> {
    if (down) throw new Error("fake daemon is down");
    const url = new URL(pathAndQuery, "http://127.0.0.1");
    const path = url.pathname;
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    const reply = (status: number, value: unknown): FakeDaemonResponse => ({
      status, text: JSON.stringify(value), contentType: "application/json",
    });

    for (const candidate of compiled()) {
      if (!candidate.key.startsWith(`${method} `)) continue;
      const match = candidate.regex.exec(path);
      if (!match) continue;
      const params = Object.fromEntries(candidate.names.map((name, i) => [name, decodeURIComponent(match[i + 1]!)]));
      const request: FakeRequest = {
        method, path, pattern: candidate.key.slice(candidate.key.indexOf(" ") + 1), params,
        query: Object.fromEntries(url.searchParams), body,
        headers: { ...lower, "x-fake-flag": flag ? "on" : "off" },
      };
      requests.push({ ...request, at: Date.now() });
      if (path.startsWith("/dispatch/")) {
        if (!flag) return reply(404, { error: "This feature is disabled.", feature: "headless-mode" });
        if (token !== null && lower["x-harness-token"] !== token) return reply(401, { error: "unauthorized" });
        const schema = ROUTE_REQUEST_SCHEMAS[candidate.key as FakeRouteKey];
        if (schema) {
          const parsed = schema.safeParse(body);
          if (!parsed.success) return reply(400, { error: parsed.error.message });
        }
      }
      const out = await table.get(candidate.key)!(request);
      if (out.raw !== undefined) return { status: out.status ?? 200, text: out.raw, contentType: out.contentType ?? "text/plain" };
      return reply(out.status ?? 200, out.body ?? {});
    }
    requests.push({ method, path, pattern: "", params: {}, query: Object.fromEntries(url.searchParams), body, headers: lower, at: Date.now() });
    return reply(404, { error: "not found" });
  }

  let server: Server | null = null;
  return {
    handle,
    requests,
    setFlag: (enabled) => { flag = enabled; },
    setDown: (value) => { down = value; },
    override: (key, route) => { table.set(key, route); },
    listen: async () => {
      if (server) throw new Error("fake daemon is already listening");
      server = createServer((req, res) => {
        if (down) { req.socket.destroy(); return; }
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: unknown;
          try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
          const headers = flatten(req.headers);
          handle(req.method ?? "GET", req.url ?? "/", body, headers).then(
            (out) => { res.writeHead(out.status, { "content-type": out.contentType }); res.end(out.text); },
            () => req.socket.destroy(),
          );
        });
      });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;
      return { port, url: `http://127.0.0.1:${port}` };
    },
    close: async () => {
      const current = server;
      server = null;
      if (current) await new Promise<void>((resolve) => { current.closeAllConnections(); current.close(() => resolve()); });
    },
  };
}

function flatten(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) if (typeof value === "string") out[name] = value;
  return out;
}

/* ------------------------------------------------------------------ the fake ModHost */

export type FakeHostCall =
  | { type: "ask"; question: ModAskQuestion }
  | { type: "notice"; text: string }
  | { type: "toast"; text: string }
  | { type: "status"; text: string | undefined }
  | { type: "band"; band: ModBand | undefined }
  | { type: "fillPrompt"; text: string }
  | { type: "fetch"; path: string; init: ModFetchInit | undefined }
  | { type: "modelWrite"; write: ModModelWrite }
  | { type: "paneOpen"; opts: ModPaneOpen }
  | { type: "paneClose" }
  | { type: "view"; props: PaneProps; view: PaneView }
  | { type: "press"; label: string }
  | { type: "link"; url: string };

export interface FakeModHostOptions {
  /** Answers served to `ask`, in order. A function answers every dialog. After the list, dialogs are dismissed. */
  answers?: readonly ModAskAnswer[] | ((question: ModAskQuestion) => ModAskAnswer);
  env?: Record<string, string>;
  /** Routes `fetch` to this daemon in process. Without one, `fetch` rejects. */
  daemon?: FakeDaemon;
  initialState?: Partial<ModState>;
  /** The `x-harness-token` the host sends. Default `FAKE_TOKEN`; set it to match, or mismatch, a daemon built with another token. */
  token?: string;
  /** What `paneOpen` reports as `isPlaced`. Default true. */
  placed?: boolean;
}

export interface FakeModHost {
  host: ModHost;
  /** Every call in order. */
  calls: FakeHostCall[];
  dialogs: ModAskQuestion[];
  notices: string[];
  toasts: string[];
  statuses: (string | undefined)[];
  bands: (ModBand | undefined)[];
  prompts: string[];
  fetches: { path: string; init: ModFetchInit | undefined }[];
  modelWrites: ModModelWrite[];
  paneOpens: ModPaneOpen[];
  paneCloses: number;
  links: string[];
  /** Every view drawn, with the placement and size it was drawn for. */
  views: { props: PaneProps; view: PaneView }[];
  state: Partial<ModState>;
  /** Draws the pane through `renderPane` and records the view. */
  drawPane: (props: PaneProps) => PaneView;
  /** Presses the button with this label in the last view drawn, and records the press. */
  press: (label: string) => Promise<void>;
  /** Runs every active `clockEvery` callback once. */
  tick: () => Promise<void>;
  activeClocks: () => number;
}

export function createFakeModHost(options: FakeModHostOptions = {}): FakeModHost {
  const calls: FakeHostCall[] = [];
  const record = <T extends FakeHostCall>(call: T): T => { calls.push(call); return call; };
  const out: FakeModHost = {
    calls, dialogs: [], notices: [], toasts: [], statuses: [], bands: [], prompts: [], fetches: [],
    modelWrites: [], paneOpens: [], paneCloses: 0, links: [], views: [],
    state: { ...options.initialState },
    host: undefined as unknown as ModHost,
    drawPane: undefined as unknown as FakeModHost["drawPane"],
    press: undefined as unknown as FakeModHost["press"],
    tick: undefined as unknown as FakeModHost["tick"],
    activeClocks: undefined as unknown as FakeModHost["activeClocks"],
  };
  const queue = Array.isArray(options.answers) ? [...options.answers] : [];
  const clocks = new Set<() => void | Promise<void>>();

  const host: ModHost = {
    ask: async (question) => {
      record({ type: "ask", question });
      out.dialogs.push(question);
      if (typeof options.answers === "function") return options.answers(question);
      return queue.shift() ?? { kind: "dismissed" };
    },
    notice: (text) => { record({ type: "notice", text }); out.notices.push(text); },
    toast: (text) => { record({ type: "toast", text }); out.toasts.push(text); },
    status: (text) => { record({ type: "status", text }); out.statuses.push(text); },
    band: (band) => { record({ type: "band", band }); out.bands.push(band); },
    fillPrompt: (text) => { record({ type: "fillPrompt", text }); out.prompts.push(text); },
    fetch: async (path, init): Promise<ModFetchResult> => {
      record({ type: "fetch", path, init });
      out.fetches.push({ path, init });
      if (!options.daemon) throw new Error("fake host has no daemon");
      const reply = await options.daemon.handle(init?.method ?? "GET", path, init?.body, {
        "x-harness-token": options.token ?? FAKE_TOKEN,
        "x-harness-surface": "mod",
      });
      return { status: reply.status, text: reply.text };
    },
    env: (name) => options.env?.[name],
    modelWrite: (write) => { record({ type: "modelWrite", write }); out.modelWrites.push(write); },
    clockEvery: (_ms, tick) => {
      // A fresh entry per call, so registering the same callback twice gives two independent clocks.
      const entry = () => tick();
      clocks.add(entry);
      return () => { clocks.delete(entry); };
    },
    paneOpen: async (opts) => {
      record({ type: "paneOpen", opts });
      out.paneOpens.push(opts);
      return { isPlaced: options.placed ?? true };
    },
    paneClose: () => { record({ type: "paneClose" }); out.paneCloses += 1; },
    paneState: {
      get: async (key) => out.state[key],
      set: async (key, value) => { out.state[key] = value; },
      update: async (key, fn) => { out.state[key] = fn(out.state[key]); },
    },
    link: (url) => { record({ type: "link", url }); out.links.push(url); },
  };
  out.host = host;
  out.drawPane = (props) => {
    const view = renderPane(host, props);
    record({ type: "view", props, view });
    out.views.push({ props, view });
    return view;
  };
  out.press = async (label) => {
    const last = out.views.at(-1);
    const button = last?.view.buttons.find((b) => b.label === label);
    if (!button) throw new Error(`no button "${label}" in the last view drawn`);
    record({ type: "press", label });
    await button.press();
  };
  out.tick = async () => { for (const tick of clocks) await tick(); };
  out.activeClocks = () => clocks.size;
  return out;
}
