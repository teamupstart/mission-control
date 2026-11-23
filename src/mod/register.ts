import type { CoreHost, CoreStateKey, ModBand, ModPaneOpen, ModPaneTab } from "./host.ts";
import { createModCore, type ModCore } from "./core.ts";
import { MOD_VERSION, PANE_REQUEST_ID } from "./constants.ts";
import { daemonBaseUrl, readDaemonToken, type DaemonEnv } from "./daemon-link.ts";
import { createPaneController, renderPane, type PaneController, type PaneNode, type PaneView } from "./pane/index.ts";

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
  const view: GlanceView = { banner: undefined, band: undefined, status: undefined, pane: null };

  // Each session start or end invalidates the work of the one before it: a startup still awaiting
  // the engine or the daemon checks its number again after every await and drops out when stale.
  let generation = 0;
  // Which session's host holds the pane, so a stopped session's late cleanup cannot close the
  // pane its replacement opened (the pane has one id and a late `open` or `close` acts on it).
  const pane: PaneHolder = { owner: null, closing: Promise.resolve() };
  on("session.start", async ($, e, next) => {
    generation += 1;
    core?.stop();
    core = null;
    view.pane = null;
    wipeGlance($, view);
    const mine = generation;
    const host = await createHost($, view, { pane, mine, current: () => generation });
    const sessionId = await $.session.id();
    const entrypoint = await $.env.get("CLAUDE_CODE_ENTRYPOINT");
    if (mine !== generation) return next(e);
    const started = createModCore(host, {
      sessionId,
      cwd: e.cwd,
      modVersion: MOD_VERSION,
      // The engine's `session.start` input carries only `cwd`, `surface` and `isInteractive`: the
      // resume, clear, compact and fork `source` exists only on the classic command-hook event.
      // A /clear raises `session.end` with no `session.start` after it, and a reload re-runs this
      // hook in the same session, so "startup" is the one honest value here. The daemon uses the
      // field for the banner (the mod builds the same lines itself) and for its own record.
      source: "startup",
      entrypoint: entrypoint ?? null,
      interactive: e.isInteractive,
    });
    core = started;
    // The pane's own state (open item, typed text, receipt) lives and dies with the session.
    view.pane = createPaneController({
      host,
      sessionId,
      cwd: e.cwd,
      getInbox: () => (mine === generation ? (started.inbox() ?? null) : null),
      refresh: () => started.tick(),
      redraw: () => $.ui.invalidate("ui.render"),
    });
    // Not awaited past the first attempt: a daemon that is slow to answer must not hold the prompt.
    // Every expected failure is a value inside the controller, so a throw here is a defect: leave a
    // trace in the person's own log instead of looking like "flag off".
    void started.start().catch((error: unknown) => $.ui.log(describeFailure("startup", error)));
    return next(e);
  });

  on("session.end", async ($, e, next) => {
    generation += 1;
    core?.stop();
    core = null;
    view.pane = null;
    wipeGlance($, view);
    return next(e);
  });

  on("prompt.submit", async ($, e, next) => {
    core?.promptSubmitted();
    return next(e);
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
              onPress: () => void core?.openNeedsYou().catch((error: unknown) => $.ui.log(describeFailure("the 1 button", error))),
            }),
          ],
        }),
      );
    }
    return Box({ flexDirection: "column", children: rows });
  });

  // The pane (7.22): two tabs, Needs you then Tasks. The open and close calls and the id are P8's.
  on("ui.render", { component: "Pane", requestId: PANE_REQUEST_ID }, async ($, e, next) => {
    // Nothing is drawn unless the mod is connected: flag off, daemon down or a modApi mismatch.
    const ctl = view.pane;
    if (core?.phase() !== "active" || !ctl) return next(e);
    const ui = $.ui.resolve(e);
    const props = e.props ?? {};
    const drawn = renderPane(ctl.host, {
      placement: props.placement ?? "dock",
      bodyColumns: props.bodyColumns ?? 60,
      tab: ctl.view().tab,
      ctl,
    });
    return ui.Box({ flexDirection: "column", children: drawNodes(ui, drawn) });
  });

  // Flows (P11) and pane tabs (P12) register here, one line each.
}

// The pane and the flows are exported so the built `hooks/register.js` carries them: a later
// phase's registration lines call them, and the build keeps whatever the entry point reaches.
export { renderPane, PANE_TABS, createPaneController } from "./pane/index.ts";
export { runDispatchCommand, runDispatchFlow, runStartDispatchTool } from "./flows/index.ts";

/** What the render hooks draw: written by the host's `banner` and `band`, read by `ui.render`. */
interface GlanceView {
  banner: readonly string[] | undefined;
  band: ModBand | undefined;
  /** The status entry as last set, so a new session clears it only if one was shown. */
  status: string | undefined;
  /** The session's pane controller; `null` between sessions. */
  pane: PaneController | null;
}

/* ------------------------------------------------------------------ the engine surface used */

type Hook = ($: Engine, e: EngineEvent, next: (e: EngineEvent) => Promise<unknown> | unknown) => unknown;
type EngineOn = {
  (event: "session.start" | "session.end" | "prompt.submit", hook: Hook): void;
  (event: "ui.render", matcher: { component: string; requestId?: string }, hook: Hook): void;
};
// The engine's events are richer; this is the part the mod reads.
type EngineEvent = { cwd: string; isInteractive: boolean; props?: { hasSurvey?: boolean; placement?: "dock" | "inline" | "widget"; bodyColumns?: number }; [field: string]: unknown };
interface Engine {
  session: { id: () => Promise<string> };
  env: { get: (name: string) => Promise<string | undefined> };
  http: { fetch: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; text: string }> };
  fs: { read: (path: string) => Promise<string> };
  clock: { every: (ms: number, fn: () => void) => { cancel: () => void } };
  ui: {
    resolve: (e: EngineEvent) => Record<"Box" | "Text" | "Button" | "Input", (props: Record<string, unknown>) => unknown>;
    open: (pane: { id: string; title?: string; focus?: true }) => Promise<{ isPlaced: boolean }>;
    close: (pane: { id: string }) => Promise<void>;
    toast: (text: string) => void;
    status: (text: string | undefined) => void;
    invalidate: (event: "ui.render") => void;
    log: (text: string) => void;
  };
  state: { set: (ref: { plugin: "mission-control"; key: CoreStateKey }, value: unknown) => Promise<unknown> };
}

/**
 * `$.state` takes its plugin and key as literals written at the call (or in a const of this
 * file), so `claude plugin validate` can list them. A computed reference is refused, hence one
 * case per key. Only the keys the controller writes are here; P12 adds its own with its pane.
 */
async function stateSet($: Engine, key: CoreStateKey, value: unknown): Promise<void> {
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
  }
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

/** One line for the person's log when the controller throws, which only a defect does. */
function describeFailure(where: string, error: unknown): string {
  return "mission-control: " + where + " failed: " + (error instanceof Error ? error.message : String(error));
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
  /** Settles when every close issued so far has completed; an open waits for it. */
  closing: Promise<void>;
}

/** The session a host belongs to, and the shared holder of the pane. */
interface HostSession {
  pane: PaneHolder;
  mine: number;
  current: () => number;
}

async function createHost($: Engine, view: GlanceView, session: HostSession): Promise<CoreHost> {
  const env = await readEnv($);
  const baseUrl = daemonBaseUrl(env);
  const redraw = (): void => $.ui.invalidate("ui.render");
  return {
    notice: (text) => {
      // One quiet line only the person reads; `$.ui.log` never reaches the model.
      $.ui.log(text);
    },
    toast: (text) => $.ui.toast(text),
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
      // This session ended while it waited: opening now would leave a pane nobody owns.
      if (session.mine !== session.current()) return { isPlaced: false };
      const opened = await $.ui.open({ id: PANE_REQUEST_ID, title: "Mission Control", ...(opts.focus ? { focus: true as const } : {}) });
      // Only the current session takes the pane; a stopped one's late open leaves it unowned.
      if (session.mine === session.current()) session.pane.owner = session.mine;
      return { isPlaced: opened.isPlaced };
    },
    paneClose: () => {
      // A replacement session owns the pane now: a stale close must not take it away.
      if (session.pane.owner !== null && session.pane.owner !== session.mine) return;
      session.pane.owner = null;
      // A refused close leaves a line in the person's log: the pane may still be on screen.
      const done = $.ui.close({ id: PANE_REQUEST_ID }).catch((error: unknown) => $.ui.log(describeFailure("closing the pane", error)));
      session.pane.closing = Promise.all([session.pane.closing, done]).then(() => undefined);
    },
    // The pane's values are a convenience for drawing: a refused write never stops the glance
    // layer, so it is dropped.
    paneState: {
      set: async (key, value) => {
        // A stopped session's late write must not overwrite the replacement's value.
        if (session.mine !== session.current()) return;
        // The band's `1` button asks for Needs you through this write; the pane follows it.
        if (key === "paneTab") view.pane?.selectTab(value as ModPaneTab, { persist: false });
        await stateSet($, key, value).catch(() => undefined);
      },
    },
  };
}

/** The engine elements for a pane view: the tab buttons share one row, the rest draw in order. */
function drawNodes(ui: ReturnType<Engine["ui"]["resolve"]>, drawn: PaneView): unknown[] {
  const out: unknown[] = [];
  let tabs: unknown[] = [];
  const flush = (): void => {
    if (tabs.length > 0) out.push(ui.Box({ flexDirection: "row", gap: 2, children: tabs }));
    tabs = [];
  };
  const button = (node: Extract<PaneNode, { kind: "button" }>): unknown =>
    ui.Button({
      key: `${node.button.group ?? "action"}-${node.button.label}`,
      label: node.button.label,
      ...(node.button.hotkey ? { hotkey: node.button.hotkey } : {}),
      ...(node.button.autoFocus ? { autoFocus: true } : {}),
      onPress: () => node.button.press(),
    });
  for (const node of drawn.nodes ?? []) {
    if (node.kind === "button" && node.button.group === "tab") {
      tabs.push(button(node));
      continue;
    }
    flush();
    if (node.kind === "button") out.push(button(node));
    else if (node.kind === "input") {
      out.push(
        ui.Input({
          key: node.input.key,
          placeholder: node.input.placeholder,
          value: node.input.value,
          submitLabel: node.input.submitLabel,
          onInput: (value: string) => node.input.onInput(value),
          onSubmit: (value: string) => node.input.onSubmit(value),
        }),
      );
    } else {
      const { text, dim, bold, tone } = node.line;
      out.push(
        ui.Text({
          children: text,
          ...(dim ? { dimColor: true } : {}),
          ...(bold ? { bold: true } : {}),
          ...(tone ? { color: tone === "ok" ? "success" : "error" } : {}),
        }),
      );
    }
  }
  flush();
  return out;
}
