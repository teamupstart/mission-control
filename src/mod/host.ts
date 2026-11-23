import type { MissionControlModState } from "claude-code";

/**
 * Everything the mod's pure flows and pane views may do (spec 7.10). `register.ts` adapts the
 * engine's `$` to this interface; tests pass the fake in `test/helpers/home-dispatch-fakes.ts`.
 * Flows and views import nothing from the engine. Owner after P2: P8; a later phase adds, and
 * never changes, a member.
 */

export type ModState = MissionControlModState;

/** One dispatch dialog (7.5): the daemon's page, shown word for word. */
export interface ModAskQuestion {
  header: string;
  question: string;
  options: readonly { label: string; description?: string }[];
}

export type ModAskAnswer =
  | { kind: "pick"; label: string }
  /** Text typed under Other. */
  | { kind: "other"; text: string }
  | { kind: "dismissed" };

/** The band above the prompt (7.12). The count's colour is a text style, never a background. */
export interface ModBand {
  text: string;
  tone: "warning" | "error";
  button: { label: string; hotkey: string };
}

export interface ModFetchInit {
  method?: "GET" | "POST";
  /**
   * Checked by the host after any wait it makes (reading the token file) and immediately before
   * the request leaves. When it answers false the request is not sent and the call rejects, so a
   * flow whose session ended while the host waited cannot file or change a task.
   */
  guard?: () => boolean;
  /** A JSON-serialisable body; the host sends it as JSON. */
  body?: unknown;
}

/**
 * A daemon reply. `path` is the route (`/dispatch/inbox?repo=...`), and the host adds the base
 * URL, the `x-harness-token` header and the surface header `mod`. A transport failure rejects.
 */
export interface ModFetchResult {
  status: number;
  text: string;
}

/** The only writes that reach the model's context (F18); everything else is for the person. */
export interface ModModelWrite {
  source: "tool-result" | "tool-description" | "prompt-nudge";
  text: string;
}

export type ModPaneTab = ModState["paneTab"];
export type ModPanePlacement = "dock" | "inline" | "widget";

export interface ModPaneOpen {
  /**
   * Whether the session that asked is still current. The host checks it before it writes the
   * pane's target and again as it opens, and takes back an open that finished after the session
   * ended, so a stale command cannot open or retarget a replacement session's pane.
   */
  guard?: () => boolean;
  tab?: ModPaneTab;
  /** Open on this task's item view when the inbox lists it. */
  taskId?: string;
  focus?: boolean;
}

/** The pane's atoms: read, replace and update a `$.state` value. */
export interface ModPaneState {
  get: <K extends keyof ModState>(key: K) => Promise<ModState[K] | undefined>;
  set: <K extends keyof ModState>(key: K, value: ModState[K]) => Promise<void>;
  update: <K extends keyof ModState>(key: K, fn: (value: ModState[K] | undefined) => ModState[K]) => Promise<void>;
}

export interface ModHost {
  ask: (question: ModAskQuestion) => Promise<ModAskAnswer>;
  /** A notice only the person reads (`$.session.append`, type system). */
  notice: (text: string) => void;
  toast: (text: string) => void;
  /** `undefined` clears the status entry. */
  status: (text: string | undefined) => void;
  /** `undefined` draws no band. */
  band: (band: ModBand | undefined) => void;
  /** The start-up banner lines above the prompt (7.21); `undefined` removes them. */
  banner: (lines: readonly string[] | undefined) => void;
  /** Puts text in the prompt box without sending it (`$.prompt.fill`, spike S12). */
  /**
   * Resolves `false` (or throws) when the prompt box could not be filled, so the flow asks for
   * the description in a dialog instead (S12). `void` means it was filled.
   */
  fillPrompt: (text: string) => void | boolean | Promise<void | boolean>;
  fetch: (path: string, init?: ModFetchInit) => Promise<ModFetchResult>;
  env: (name: string) => string | undefined;
  modelWrite: (write: ModModelWrite) => void;
  /** Runs `tick` every `ms`; the returned function stops it. */
  clockEvery: (ms: number, tick: () => void | Promise<void>) => () => void;
  /** Resolves `isPlaced`: whether a surface draws the pane now. */
  paneOpen: (opts: ModPaneOpen) => Promise<{ isPlaced: boolean }>;
  paneClose: () => void;
  paneState: ModPaneState;
  /** Opens a URL for the person (`d Open in the dashboard`). */
  link: (url: string) => void;
}

/** The pane values the controller writes. Later phases widen this where they need more. */
export type CoreStateKey = "registration" | "inbox" | "paneTab";

export interface CorePaneState {
  set: <K extends CoreStateKey>(key: K, value: ModState[K]) => Promise<void>;
}

/**
 * What the session controller (`core.ts`) needs, and all the engine adapter implements in P8.
 * The flow capabilities (`ask`, `fillPrompt`, `modelWrite`, `env`, `link`) and the wider pane
 * state are not here: P11 and P12 add the members they use to the adapter in `register.ts`, next
 * to their one registration line, so nothing in P8 pretends to implement them.
 */
export type CoreHost = Pick<
  ModHost,
  "notice" | "toast" | "status" | "band" | "banner" | "fetch" | "clockEvery" | "paneOpen" | "paneClose"
> & { paneState: CorePaneState };
