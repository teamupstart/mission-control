import { dispatchIntentFor } from "@shared/home-dispatch.ts";
import type { CoreHost, CoreStateKey, ModAskAnswer, ModAskQuestion, ModBand, ModHost, ModPaneOpen, ModState } from "./host.ts";
import { createModCore, type ModCore } from "./core.ts";
import { DISPATCH_COMMAND, DISPATCH_TOOL, DISPATCH_TOOL_ID, MOD_VERSION, PANE_PLACEHOLDER_TEXT, PANE_REQUEST_ID } from "./constants.ts";
import { FLOW_FAILED_TEXT, reportFlowFailure } from "./flows/failure.ts";
import { FLOW_BUSY_TEXT, createFlowGate, type FlowGate } from "./flows/gate.ts";
import { START_DISPATCH_DESCRIPTION, START_DISPATCH_SCHEMA, intentNudge, runDispatchCommand, runStartDispatchTool } from "./flows/index.ts";
import { daemonBaseUrl, readDaemonToken, type DaemonEnv } from "./daemon-link.ts";

/**
 * The hooks module (spec 7.10): a thin adapter from the engine's `$` and events to the pure
 * controller in `core.ts` and the flows and views in `flows/` and `pane/`, all of which take a
 * `ModHost`. P8 owns this file. P11 adds its flows and P12 its panes with one registration line
 * each, below the marked comment. `createHost` implements only what P8 uses (`CoreHost`); a later
 * phase adds the host members its flow or pane needs (dialogs, prompt fill, model writes, wider
 * pane state) beside it, as additions, and never changes what is here.
 *
 * It is a function declaration because `claude plugin validate` reads the hooks module's source
 * and wants `register` declared at the top of the file. The engine's `Register` type comes from
 * the `claude-code` types the engine writes at load, which are not in this repository, so the
 * engine surface used here is the small structural `Engine` below.
 *
 * Everything is inert until a daemon with the `headless-mode` flag on answers: with the flag
 * off, a daemon that is not running, or a `modApi` it no longer serves, no hook draws anything.
 */
export function register(on: EngineOn, _options: unknown): void {
  let core: ModCore | null = null;
  // What the flows need to speak for this session (7.11): set at session start, cleared at its end.
  let flowSession: { sessionId: string; cwd: string; live: () => boolean } | null = null;
  let flowHost: FlowHostType | null = null;
  // One flow at a time for the session; a new session gets a new gate, so a stale flow never blocks it.
  let flowGate: FlowGate = createFlowGate();
  const view: GlanceView = { banner: undefined, band: undefined, status: undefined };

  // Each session start or end invalidates the work of the one before it: a startup still awaiting
  // the engine or the daemon checks its number again after every await and drops out when stale.
  let generation = 0;
  // Which session's host holds the pane, so a stopped session's late cleanup cannot close the
  // pane its replacement opened (the pane has one id and a late `open` or `close` acts on it).
  const pane: PaneHolder = { owner: null, closing: Promise.resolve(), writes: Promise.resolve() };
  on("session.start", async ($, e, next) => {
    generation += 1;
    // This start's own number, taken before anything awaits: a later start or end moves
    // `generation` on, and every await below checks it again.
    const mine = generation;
    core?.stop();
    core = null;
    flowSession = null;
    flowHost = null;
    wipeGlance($, view);
    // A draft left waiting for its description belongs to the session that made it: the next
    // session's text must start a new brief, not describe an orphaned draft.
    await queuedStateSet($, pane, "draftId", null);
    if (mine !== generation) return next(e);
    const host = await createHost($, view, { pane, mine, current: () => generation });
    const sessionId = await $.session.id();
    const entrypoint = await $.env.get("CLAUDE_CODE_ENTRYPOINT");
    if (mine !== generation) return next(e);
    flowHost = host;
    flowGate = createFlowGate();
    flowSession = { sessionId, cwd: e.cwd, live: () => mine === generation };
    // The command and the tool are always registered: with the flag off they answer that it is off.
    await $.command.register({ name: DISPATCH_COMMAND, description: "Dispatch a task to Mission Control, or open its pane", argumentHint: "[kind] [what to do] | inbox | check | pane" }).catch((error: unknown) => logRegistrationFailure($, "command", error));
    await $.tool.register({ name: DISPATCH_TOOL, description: START_DISPATCH_DESCRIPTION, inputSchema: START_DISPATCH_SCHEMA }).catch((error: unknown) => logRegistrationFailure($, "tool", error));
    if (mine !== generation) return next(e);
    const started = createModCore(host, {
      sessionId,
      cwd: e.cwd,
      modVersion: MOD_VERSION,
      source: "startup",
      entrypoint: entrypoint ?? null,
      interactive: e.isInteractive,
    });
    core = started;
    // Not awaited past the first attempt: a daemon that is slow to answer must not hold the prompt.
    void started.start().catch(() => {});
    return next(e);
  });

  on("session.end", async ($, e, next) => {
    generation += 1;
    core?.stop();
    core = null;
    flowSession = null;
    flowHost = null;
    wipeGlance($, view);
    await queuedStateSet($, pane, "draftId", null);
    return next(e);
  });

  on("prompt.submit", async ($, e, next) => {
    core?.promptSubmitted();
    // The intent nudge (7.20): one line of context, only in an active home session, and only
    // when the prompt names Mission Control with a run or schedule word. The tool works without it.
    const intent = core?.phase() === "active" && typeof e.text === "string" ? dispatchIntentFor(e.text) : null;
    if (!intent) return next(e);
    return next({ ...e, context: [...(Array.isArray(e.context) ? e.context : []), intentNudge(intent)] });
  });

  // The banner and the band, above the prompt (7.12, 7.21): nothing while neither is set.
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    if (e.props?.hasSurvey || (!view.banner && !view.band)) return next(e);
    const { Box, Text, Button } = $.ui.resolve(e);
    const rows: unknown[] = [];
    for (const line of view.banner ?? []) rows.push(Text({ dimColor: true, children: line }));
    const band = view.band;
    if (band) {
      rows.push(
        Box({
          children: [
            Text({ color: band.tone, children: `${band.text}  ` }),
            Button({
              key: "open-needs-you",
              label: band.button.label,
              hotkey: band.button.hotkey,
              onPress: () => core?.openNeedsYou(),
            }),
          ],
        }),
      );
    }
    return Box({ flexDirection: "column", children: rows });
  });

  // The pane (7.22). P12 replaces this body with `renderPane`; the open and close calls and the
  // id stay as they are.
  on("ui.render", { component: "Pane", requestId: "mission" }, async ($, e, next) => {
    // Nothing is drawn unless the mod is connected: flag off, daemon down or a modApi mismatch.
    if (core?.phase() !== "active") return next(e);
    const { Box, Text } = $.ui.resolve(e);
    return Box({ flexDirection: "column", children: [Text({ dimColor: true, children: PANE_PLACEHOLDER_TEXT })] });
  });

  // Flows (P11) and pane tabs (P12) register here, one line each.
  on("command.run", { command: DISPATCH_COMMAND }, async ($, e) => {
    if (!flowHost || !flowSession || core?.phase() !== "active") return { text: FLOW_UNAVAILABLE_TEXT };
    // The dialogs outlive the hook (as the S10 spike ran them), and every line the person needs
    // is a notice, so the command itself answers nothing.
    const host = flowHost;
    const session = flowSession;
    const gate = flowGate;
    const args = typeof e.args === "string" ? e.args : "";
    void gate
      .run(() => runDispatchCommand(host, session, args))
      .then((ran) => { if (ran.busy) host.notice(FLOW_BUSY_TEXT); })
      .catch((error: unknown) => reportFlowFailure(host, (text) => $.ui.log(text, { to: "debug" }), error));
    return { text: "" };
  });
  on("tool.run", { tool: DISPATCH_TOOL_ID }, async ($, e) => {
    if (!flowHost || !flowSession || core?.phase() !== "active") return { result: FLOW_UNAVAILABLE_TEXT };
    const host = flowHost;
    try {
      const ran = await flowGate.run(() => runStartDispatchTool(host, flowSession!, e as Record<string, unknown>));
      return { result: ran.busy ? FLOW_BUSY_TEXT : ran.value };
    } catch (error) {
      reportFlowFailure(host, (text) => $.ui.log(text, { to: "debug" }), error);
      return { result: FLOW_FAILED_TEXT };
    }
  });
}

/** A command or tool the engine refused to register simply stops existing; this leaves a line on the debug channel to say why. */
function logRegistrationFailure($: Engine, what: "command" | "tool", error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  $.ui.log(`mission-control: could not register the ${what === "command" ? DISPATCH_COMMAND : DISPATCH_TOOL} ${what}: ${detail}`, { to: "debug" });
}

/** What the command and the tool say when headless mode is not connected (flag off, daemon down, modApi mismatch). */
const FLOW_UNAVAILABLE_TEXT = "Mission Control headless mode is not available in this session.";
type FlowHostType = Pick<ModHost, "ask" | "notice" | "toast" | "fetch" | "fillPrompt" | "paneOpen" | "paneState">;

// The pane and the flows are exported so the built `hooks/register.js` carries them: a later
// phase's registration lines call them, and the build keeps whatever the entry point reaches.
export { renderPane, PANE_TABS } from "./pane/index.ts";
export { runDispatchCommand, runDispatchFlow, runLauncher, runStartDispatchTool } from "./flows/index.ts";

/** What the render hooks draw: written by the host's `banner` and `band`, read by `ui.render`. */
interface GlanceView {
  banner: readonly string[] | undefined;
  band: ModBand | undefined;
  /** The status entry as last set, so a new session clears it only if one was shown. */
  status: string | undefined;
}

/* ------------------------------------------------------------------ the engine surface used */

type Hook = ($: Engine, e: EngineEvent, next: (e: EngineEvent) => Promise<unknown> | unknown) => unknown;
type EngineOn = {
  (event: "session.start" | "session.end" | "prompt.submit", hook: Hook): void;
  (event: "ui.render", matcher: { component: string; requestId?: string }, hook: Hook): void;
  (event: "command.run", matcher: { command: string }, hook: Hook): void;
  (event: "tool.run", matcher: { tool: string }, hook: Hook): void;
};
// The engine's events are richer; this is the part the mod reads.
type EngineEvent = { cwd: string; isInteractive: boolean; props?: { hasSurvey?: boolean }; [field: string]: unknown };
interface Engine {
  session: { id: () => Promise<string> };
  env: { get: (name: string) => Promise<string | undefined> };
  command: { register: (spec: { name: string; description: string; argumentHint?: string }) => Promise<unknown> };
  tool: { register: (spec: { name: string; description: string; inputSchema: unknown }) => Promise<unknown> };
  prompt: { fill: (input: { text: string; mode?: "replace" }) => Promise<{ isFilled?: boolean }> };
  http: { fetch: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; text: string }> };
  fs: { read: (path: string) => Promise<string> };
  clock: { every: (ms: number, fn: () => void) => { cancel: () => void } };
  ui: {
    resolve: (e: EngineEvent) => Record<"Box" | "Text" | "Button", (props: Record<string, unknown>) => unknown>;
    open: (pane: { id: string; title?: string; focus?: true }) => Promise<{ isPlaced: boolean }>;
    close: (pane: { id: string }) => Promise<void>;
    ask: (question: string, options: { options: readonly string[]; header?: string }) => Promise<unknown>;
    toast: (text: string) => void;
    status: (text: string | undefined) => void;
    invalidate: (event: "ui.render") => void;
    log: (text: string, options?: { to?: "debug" }) => void;
  };
  state: {
    set: (ref: { plugin: "mission-control"; key: FlowStateKey }, value: unknown) => Promise<unknown>;
    get: (ref: { plugin: "mission-control"; key: FlowStateKey }) => Promise<{ value?: unknown } | undefined>;
  };
}

/** One shared pane-state write, in order after those before it; dropped if `guard` says its session is gone when its turn comes. */
function queuedStateSet($: Engine, pane: PaneHolder, key: FlowStateKey, value: unknown, guard?: () => boolean): Promise<void> {
  const run = pane.writes.then(async () => {
    if (guard && !guard()) return;
    await stateSet($, key, value).catch(() => undefined);
  });
  pane.writes = run.catch(() => undefined);
  return run.catch(() => undefined);
}

/** The pane values the mod writes: the controller's three, and the draft waiting for its description. */
type FlowStateKey = CoreStateKey | "draftId" | "selectedTaskId" | "paneView";

/**
 * `$.state` takes its plugin and key as literals written at the call (or in a const of this
 * file), so `claude plugin validate` can list them. A computed reference is refused, hence one
 * case per key. Only the keys the mod writes and reads are here; P12 adds its own with its pane.
 */
async function stateSet($: Engine, key: FlowStateKey, value: unknown): Promise<void> {
  switch (key) {
    case "registration":
      await $.state.set({ plugin: "mission-control", key: "registration" }, value);
      return;
    case "inbox":
      await $.state.set({ plugin: "mission-control", key: "inbox" }, value);
      return;
    case "paneTab":
      await $.state.set({ plugin: "mission-control", key: "paneTab" }, value);
      return;
    case "draftId":
      await $.state.set({ plugin: "mission-control", key: "draftId" }, value);
      return;
    case "selectedTaskId":
      await $.state.set({ plugin: "mission-control", key: "selectedTaskId" }, value);
      return;
    case "paneView":
      await $.state.set({ plugin: "mission-control", key: "paneView" }, value);
      return;
  }
}

async function stateGet($: Engine, key: FlowStateKey): Promise<unknown> {
  switch (key) {
    case "registration":
      return (await $.state.get({ plugin: "mission-control", key: "registration" }))?.value;
    case "inbox":
      return (await $.state.get({ plugin: "mission-control", key: "inbox" }))?.value;
    case "paneTab":
      return (await $.state.get({ plugin: "mission-control", key: "paneTab" }))?.value;
    case "draftId":
      return (await $.state.get({ plugin: "mission-control", key: "draftId" }))?.value;
    case "selectedTaskId":
      return (await $.state.get({ plugin: "mission-control", key: "selectedTaskId" }))?.value;
    case "paneView":
      return (await $.state.get({ plugin: "mission-control", key: "paneView" }))?.value;
  }
}

const isFlowStateKey = (key: string): key is FlowStateKey => key === "registration" || key === "inbox" || key === "paneTab" || key === "draftId" || key === "selectedTaskId" || key === "paneView";

/** `$.ui.ask` answers the label picked, or the text typed under Other; a dismissed dialog rejects or answers nothing. */
async function askDialog($: Engine, question: ModAskQuestion): Promise<ModAskAnswer> {
  let answer: unknown;
  try {
    answer = await $.ui.ask(question.question, { options: question.options.map((option) => option.label), header: question.header });
  } catch {
    return { kind: "dismissed" };
  }
  if (typeof answer !== "string" || answer === "") return { kind: "dismissed" };
  return question.options.some((option) => option.label === answer) ? { kind: "pick", label: answer } : { kind: "other", text: answer };
}

/** The environment the daemon link reads, each name a literal in source for `claude plugin validate`. */
async function readEnv($: Engine): Promise<DaemonEnv> {
  const [mp, fp, hp, mh, fh, hh, tok, tokFile, home] = await Promise.all([
    $.env.get("MISSION_PORT"),
    $.env.get("FLEET_PORT"),
    $.env.get("HARNESS_PORT"),
    $.env.get("MISSION_HOME"),
    $.env.get("FLEET_HOME"),
    $.env.get("HARNESS_HOME"),
    $.env.get("MISSION_API_TOKEN"),
    $.env.get("MISSION_API_TOKEN_FILE"),
    $.env.get("HOME"),
  ]);
  const out: Record<string, string> = {};
  const put = (name: string, value: string | undefined): void => {
    if (value !== undefined) out[name] = value;
  };
  put("MISSION_PORT", mp);
  put("FLEET_PORT", fp);
  put("HARNESS_PORT", hp);
  put("MISSION_HOME", mh);
  put("FLEET_HOME", fh);
  put("HARNESS_HOME", hh);
  put("MISSION_API_TOKEN", tok);
  put("MISSION_API_TOKEN_FILE", tokFile);
  put("HOME", home);
  return out;
}

/** Clears the shared glance view and the status entry, and asks for a redraw. */
function wipeGlance($: Engine, view: GlanceView): void {
  // A session that drew nothing has nothing to wipe: the inert path makes no engine call at all.
  if (view.banner === undefined && view.band === undefined && view.status === undefined) return;
  view.banner = undefined;
  view.band = undefined;
  if (view.status !== undefined) $.ui.status(undefined);
  view.status = undefined;
  $.ui.invalidate("ui.render");
}

/** Adapts the engine's `$` to the `ModHost` the controller, flows and pane views use. */
interface PaneHolder {
  owner: number | null;
  /**
   * Settles when every shared state write queued so far has finished. The pane's state is shared by
   * every session, so its writes run in order, each checking its own guard as it starts: a write an
   * old session already has in flight finishes before the replacement's write begins, and the
   * replacement's value is the one left behind.
   */
  writes: Promise<void>;
  /** Settles when every close issued so far has completed; an open waits for it. */
  closing: Promise<void>;
}

/** The session a host belongs to, and the shared holder of the pane. */
interface HostSession {
  pane: PaneHolder;
  mine: number;
  current: () => number;
}

async function createHost($: Engine, view: GlanceView, session: HostSession): Promise<CoreHost & FlowHostType> {
  const env = await readEnv($);
  const baseUrl = daemonBaseUrl(env);
  const redraw = (): void => $.ui.invalidate("ui.render");
  /**
   * The session ended while its pane open or target was pending. Take the pane back unless a
   * replacement owns it (the pane has one id, so its close would take the replacement's too).
   */
  const takeBack = (): { isPlaced: boolean } => {
    if (session.pane.owner === null || session.pane.owner === session.mine) {
      session.pane.owner = null;
      const done = $.ui.close({ id: PANE_REQUEST_ID }).catch(() => undefined);
      session.pane.closing = Promise.all([session.pane.closing, done]).then(() => undefined);
    }
    return { isPlaced: false };
  };
  return {
    notice: (text) => {
      // One quiet line only the person reads; `$.ui.log` never reaches the model.
      $.ui.log(text);
    },
    toast: (text) => $.ui.toast(text),
    ask: (question) => askDialog($, question),
    // False when the engine refuses or rejects the fill, so the flow asks in a dialog (S12).
    fillPrompt: async (text, guard) => {
      // The engine does not know which session asked: never fill another session's prompt. Answers
      // true ("handled") so the flow does not fall back to a dialog for a session that is gone.
      if (guard && !guard()) return true;
      try {
        return (await $.prompt.fill({ text, mode: "replace" }))?.isFilled !== false;
      } catch {
        return false;
      }
    },
    status: (text) => {
      view.status = text;
      $.ui.status(text);
    },
    band: (band) => {
      view.band = band;
      redraw();
    },
    banner: (lines) => {
      view.banner = lines;
      redraw();
    },
    fetch: async (path, init) => {
      const token = await readDaemonToken(env, (file) => $.fs.read(file));
      // The token read above may have outlasted the session that asked: recheck as the request leaves.
      if (init?.guard && !init.guard()) throw new Error("the session ended before the request was sent");
      const reply = await $.http.fetch(`${baseUrl}${path}`, {
        method: init?.method ?? "GET",
        headers: { "x-harness-token": token, "x-harness-surface": "mod", "content-type": "application/json" },
        ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
      return { status: reply.status, text: reply.text };
    },
    clockEvery: (ms, tick) => {
      const timer = $.clock.every(ms, () => void tick());
      return () => timer.cancel();
    },
    paneOpen: async (opts: ModPaneOpen) => {
      // A close from the session before must finish first, or it could remove this open's pane.
      await session.pane.closing;
      // A command that outlived its session neither retargets nor opens the pane.
      const stale = (): boolean => session.mine !== session.current() || (opts.guard !== undefined && !opts.guard());
      if (stale()) return { isPlaced: false };
      // Claim the pane before anything pends, so an older session's late open sees this one owns it
      // and does not close it.
      session.pane.owner = session.mine;
      // The target the command asked for is stored before the pane opens, so the pane draws it
      // (P12 reads these): a tab clears any selected task, a task id selects that task, and a bare
      // open leaves the pane as it was. The writes are queued with the other sessions' and each
      // checks this session again when its turn comes.
      const target: Array<[FlowStateKey, unknown]> = opts.taskId !== undefined
        ? [["paneTab", "tasks"], ["selectedTaskId", opts.taskId], ["paneView", "item"]]
        : opts.tab !== undefined
          ? [["paneTab", opts.tab], ["selectedTaskId", null], ["paneView", "list"]]
          : [];
      for (const [key, value] of target) {
        if (stale()) break;
        await queuedStateSet($, session.pane, key, value, () => !stale());
      }
      if (stale()) return takeBack();
      const opened = await $.ui.open({ id: PANE_REQUEST_ID, title: "Mission Control", ...(opts.focus ? { focus: true as const } : {}) });
      if (!stale()) return { isPlaced: opened.isPlaced };
      return takeBack();
    },
    paneClose: () => {
      // A replacement session owns the pane now: a stale close must not take it away.
      if (session.pane.owner !== null && session.pane.owner !== session.mine) return;
      session.pane.owner = null;
      const done = $.ui.close({ id: PANE_REQUEST_ID }).catch(() => undefined);
      session.pane.closing = Promise.all([session.pane.closing, done]).then(() => undefined);
    },
    // The pane's values are a convenience for drawing: a refused write never stops the glance
    // layer, so it is dropped.
    paneState: {
      set: async <K extends keyof ModState>(key: K, value: ModState[K]) => {
        // Queued behind every other session's writes; a stale session's write is dropped.
        if (isFlowStateKey(key)) await queuedStateSet($, session.pane, key, value, () => session.mine === session.current());
      },
      get: async <K extends keyof ModState>(key: K) =>
        (isFlowStateKey(key) ? await stateGet($, key).catch(() => undefined) : undefined) as ModState[K] | undefined,
      update: async <K extends keyof ModState>(key: K, fn: (value: ModState[K] | undefined) => ModState[K]) => {
        if (!isFlowStateKey(key)) return;
        const current = (await stateGet($, key).catch(() => undefined)) as ModState[K] | undefined;
        await queuedStateSet($, session.pane, key, fn(current), () => session.mine === session.current());
      },
    },
  };
}
