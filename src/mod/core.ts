import type { HomeDispatchInbox, HomeSessionRegistration, HomeSessionRegistrationAnswer } from "@shared/home-dispatch.ts";
import { bandFor, nextAttention, statusFor, type AttentionMemory } from "./attention.ts";
import { bannerLines } from "./banner.ts";
import { checkHealth, fetchInbox, registerSession, type DaemonResult } from "./client.ts";
import { LAUNCHER_ENABLED, MOD_API, POLL_INTERVAL_MS } from "./constants.ts";
import type { CoreHost } from "./host.ts";

/**
 * The mod's session controller (spec 7.10, 7.12, 7.21): flag follow, registration, the inbox
 * poll and the glance layer, as a plain object over `ModHost`. It imports nothing from the
 * engine, so `test/home-dispatch-mod-core.test.ts` drives it with the fake host and the fake
 * daemon. `register.ts` adapts the engine to `ModHost` and calls `createModCore`; P11 and P12
 * add flows and panes beside it and never edit this file's lifecycle.
 *
 * Phases:
 *   connecting  not registered yet: the daemon is down, the flag is off, or the token was refused.
 *               Each tick tries again, so starting the daemon or turning the flag on later works.
 *   active      registered; each tick polls the inbox.
 *   inert       the person's mod is not one this daemon serves (`minModApi` is newer than
 *               `MOD_API`), or this is not an interactive session. Nothing is shown or polled.
 */

/** The one message for a daemon that is not running, shown once per outage. */
export const DAEMON_DOWN_NOTICE = "Mission Control is not running. Start it with `mctl daemon`, or open the Mission Control app.";

/** The one message for a refused token, shown once per refusal. */
export const TOKEN_REFUSED_NOTICE = "Mission Control refused this session's token. Run `mctl doctor`.";

export interface ModSessionFacts {
  sessionId: string;
  cwd: string;
  /** The mod's own version, sent as `clientVersion`. */
  modVersion: string;
  source: HomeSessionRegistration["source"];
  entrypoint: string | null;
  interactive: boolean;
}

export type CorePhase = "connecting" | "active" | "inert";

export interface ModCore {
  /** Connects once and starts the poll. Resolves when the first attempt has finished. */
  start: () => Promise<void>;
  /** Stops the poll and closes the pane this core opened. Leaves the band, status and banner to the adapter, which wipes them at the session boundary. In-flight work finishes without drawing. */
  stop: () => void;
  /** One poll or connection attempt. The clock calls this; a test may too. */
  tick: () => Promise<void>;
  /** The person submitted a prompt: the banner has done its job. */
  promptSubmitted: () => void;
  /** Opens the pane on Needs you with focus: the band's `1` button, `/mission-dispatch inbox`. */
  openNeedsYou: () => Promise<void>;
  phase: () => CorePhase;
  /** The inbox the last successful poll read. */
  inbox: () => HomeDispatchInbox | null;
}

export function createModCore(host: CoreHost, facts: ModSessionFacts): ModCore {
  let phase: CorePhase = facts.interactive ? "connecting" : "inert";
  let registration: HomeSessionRegistrationAnswer | null = null;
  let memory: AttentionMemory | null = null;
  let lastInbox: HomeDispatchInbox | null = null;
  let paneOpened = false;
  let beforeFirstPrompt = true;
  let noticed: "down" | "token" | null = null;
  let busy = false;
  /** Set by `stop()`: work already in flight finishes without touching the display or the pane. */
  let stopped = false;
  let stopClock: (() => void) | null = null;

  const notifyOnce = (kind: "down" | "token"): void => {
    if (noticed === kind) return;
    noticed = kind;
    host.notice(kind === "down" ? DAEMON_DOWN_NOTICE : TOKEN_REFUSED_NOTICE);
  };

  /** Back to showing nothing: the flag went off, or the daemon went away mid-session. */
  const clearGlance = (): void => {
    host.band(undefined);
    host.status(undefined);
    host.banner(undefined);
    memory = null;
    lastInbox = null;
    void host.paneState.set("inbox", null).catch(() => {});
    void host.paneState.set("registration", null).catch(() => {});
    registration = null;
    if (paneOpened) {
      host.paneClose();
      paneOpened = false;
    }
  };

  const toConnecting = (): void => {
    if (phase === "active") clearGlance();
    phase = "connecting";
  };

  const showInbox = async (inbox: HomeDispatchInbox): Promise<void> => {
    const next = nextAttention(memory, inbox);
    memory = next.memory;
    lastInbox = inbox;
    await host.paneState.set("inbox", inbox);
    if (stopped) return;
    for (const toast of next.toasts) host.toast(toast);
    host.band(bandFor(inbox));
    host.status(statusFor(inbox));
  };

  const poll = async (): Promise<void> => {
    if (!registration) return toConnecting();
    const result = await fetchInbox(host, { repoRoot: registration.repoRoot, sessionId: facts.sessionId });
    if (stopped) return;
    if (result.kind === "ok") return showInbox(result.value);
    // A transient bad reply keeps what is shown; the next tick tries again.
    if (result.kind === "error") return;
    if (result.kind === "down") notifyOnce("down");
    if (result.kind === "unauthorized") notifyOnce("token");
    // `off`: the flag was turned off while the session ran. Show nothing, and watch for it coming back.
    toConnecting();
  };

  const connect = async (): Promise<void> => {
    const health = await checkHealth(host);
    if (stopped) return;
    if (health.kind === "down") return notifyOnce("down");
    if (health.kind === "off") {
      noticed = null;
      return;
    }
    const answer: DaemonResult<HomeSessionRegistrationAnswer> = await registerSession(host, {
      sessionId: facts.sessionId,
      harness: "claude",
      cwd: facts.cwd,
      clientVersion: facts.modVersion,
      source: facts.source,
      entrypoint: facts.entrypoint,
      interactive: facts.interactive,
      beforeFirstPrompt,
      // Told to the daemon so its answer and banner never promise a launcher the mod will not show.
      launcherDisabled: !LAUNCHER_ENABLED,
    });
    if (stopped) return;
    if (answer.kind === "down") return notifyOnce("down");
    if (answer.kind === "unauthorized") return notifyOnce("token");
    if (answer.kind !== "ok") {
      noticed = null;
      return;
    }
    noticed = null;
    // This daemon no longer serves a mod this old (or the mod is newer than the daemon's floor
    // allows): show nothing and stop polling. `mctl doctor` names the mismatch.
    if (answer.value.minModApi > MOD_API) {
      phase = "inert";
      stopClock?.();
      stopClock = null;
      return;
    }
    registration = answer.value;
    phase = "active";
    await host.paneState.set("registration", registration);
    if (stopped) return;
    if (beforeFirstPrompt) host.banner(bannerLines(registration));
    if (!paneOpened) {
      // Opened unasked and unfocused: the person's typing is not interrupted.
      await host.paneState.set("paneTab", "needs-you");
      if (stopped) return;
      await host.paneOpen({ tab: "needs-you" });
      paneOpened = true;
      if (stopped) {
        host.paneClose();
        return;
      }
    }
    await poll();
  };

  const tick = async (): Promise<void> => {
    if (busy || stopped || phase === "inert") return;
    busy = true;
    try {
      if (phase === "active") await poll();
      else await connect();
    } finally {
      busy = false;
    }
  };

  return {
    start: async () => {
      if (phase === "inert" || stopped) return;
      stopClock = host.clockEvery(POLL_INTERVAL_MS, tick);
      await tick();
    },
    stop: () => {
      stopped = true;
      stopClock?.();
      stopClock = null;
      // The session boundary takes the pane back: the next session may be inert (flag off).
      if (paneOpened) {
        host.paneClose();
        paneOpened = false;
      }
    },
    tick,
    promptSubmitted: () => {
      if (!beforeFirstPrompt) return;
      beforeFirstPrompt = false;
      // Only an active session has a banner up; with the flag off, a down daemon or a modApi
      // mismatch the mod has drawn nothing and must not touch the display.
      if (phase === "active") host.banner(undefined);
    },
    openNeedsYou: async () => {
      if (phase !== "active" || stopped) return;
      await host.paneState.set("paneTab", "needs-you");
      if (phase !== "active" || stopped) return;
      await host.paneOpen({ tab: "needs-you", focus: true });
      // The session ended or the flag went off while the open was pending: take the pane back.
      if (phase !== "active" || stopped) {
        host.paneClose();
        paneOpened = false;
        return;
      }
      paneOpened = true;
    },
    phase: () => phase,
    inbox: () => lastInbox,
  };
}
