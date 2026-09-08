/**
 * Which terminal backends can open a window on a checkout RIGHT NOW, and doing it.
 *
 * This is the impure half of the conversation pane's two launchers. It adds no registry:
 * `MULTIPLEXERS` / `EMULATORS` already hold every backend, and `launchHome` already opens a
 * window at a cwd. What was missing is a browser-readable answer to "which of these can I
 * actually pick", and the one thing that answer must not do is lie by omission.
 *
 * The reason this file exists rather than a `binPresent` call at the route: availability on
 * the multiplexer axis is NOT a property of that backend alone. `spawnDetached` on tmux
 * creates a session with no window anywhere - exactly right for a dispatched agent, and
 * nothing at all for an operator who pressed a button labelled "open a terminal". Making it
 * visible needs a second backend, an emulator, to run its `attachArgv`. So "is tmux
 * available" is a question about the pair, and answering it per-backend would ship a button
 * that reports success and puts nothing on screen - the worst failure available here,
 * because it is indistinguishable from a slow terminal.
 */

import { randomUUID } from "node:crypto";
import type { TerminalBackendId, TerminalTargetView } from "@shared/terminal.ts";
import { MULTIPLEXER_IDS, EMULATOR_IDS } from "@shared/terminal.ts";
import type {
  DetachedSessionSpec,
  Multiplexer,
  MuxSessions,
  TerminalEmulator,
  TerminalResult,
} from "./types.ts";
import {
  binPresent,
  binUnavailableReason,
  binUnsupportedReason,
  type BinAvailabilityDeps,
} from "./bin.ts";
import { MULTIPLEXERS, EMULATORS } from "./registry.ts";
import {
  cleanupDisposableAgentStateHome,
  createDisposableAgentStateHome,
  isolatedAgentArgv,
} from "../agent-subprocess-env.ts";

export interface TerminalTargetDeps extends BinAvailabilityDeps {
  multiplexers: Record<string, Multiplexer>;
  emulators: Record<string, TerminalEmulator>;
  launchId: () => string;
}

export const defaultTerminalTargetDeps: TerminalTargetDeps = {
  multiplexers: MULTIPLEXERS,
  emulators: EMULATORS,
  installed: binPresent,
  unsupported: binUnsupportedReason,
  launchId: () => randomUUID().slice(0, 6),
};

/** What a launcher asks for: a window, here, running this. */
export interface TerminalLaunchSpec {
  /** Display name for the window / session. Sanitized by the backend that takes it. */
  name: string;
  cwd: string;
  argv: readonly string[];
}

/**
 * The emulator that will raise a detached multiplexer session, or null when none can.
 *
 * First installed one wins, in `EMULATOR_IDS` order, which is the same precedence
 * `homeBackends` uses. Named rather than merely counted so the row can say which one it
 * will use - "New session, raised in WezTerm" is a promise a human can check, and "tmux is
 * available" is not.
 */
function raiser(deps: TerminalTargetDeps): TerminalEmulator | null {
  for (const id of EMULATOR_IDS) {
    const emulator = deps.emulators[id];
    if (
      emulator?.spawn &&
      !binUnavailableReason(emulator.bin, emulator.label, deps)
    ) return emulator;
  }
  return null;
}

function multiplexerView(
  mux: Multiplexer,
  deps: TerminalTargetDeps,
): Omit<TerminalTargetView, "id"> {
  const base = {
    label: mux.label,
    glyph: mux.glyph,
    dispatchBlurb: "New persistent session for each dispatch.",
  };
  const sessions = mux.sessions;
  if (!sessions) {
    // A multiplexer that only ever attaches to what is already running cannot make one.
    const reason = `${mux.label} cannot start a session`;
    return { ...base, blurb: "", detail: null, unavailable: reason, dispatchUnavailable: reason };
  }
  const unavailable = binUnavailableReason(mux.bin, mux.label, deps);
  if (unavailable) {
    return { ...base, blurb: "", detail: null, unavailable, dispatchUnavailable: unavailable };
  }
  // `attachArgv: null` is this interface's way of saying the backend's sessions are never
  // without a window - cmux draws its own. Such a backend needs nobody's help to be seen.
  if (!sessions.attachArgv) {
    return {
      ...base,
      blurb: "New workspace in the worktree.",
      detail: null,
      unavailable: null,
      dispatchUnavailable: null,
    };
  }
  const raise = raiser(deps);
  if (!raise) {
    return {
      ...base,
      blurb: "",
      detail: null,
      // The distinction the sentence exists for. tmux IS installed; what is missing is
      // anything to show it in, and telling the operator to install tmux would be wrong.
      unavailable: `${mux.label} sessions open detached - install a terminal that can show one`,
      dispatchUnavailable: null,
    };
  }
  return {
    ...base,
    blurb: `New session, raised in ${raise.label}.`,
    detail: "new-session -c",
    unavailable: null,
    dispatchUnavailable: null,
  };
}

function emulatorView(
  emulator: TerminalEmulator,
  deps: TerminalTargetDeps,
): Omit<TerminalTargetView, "id"> {
  const base = {
    label: emulator.label,
    glyph: emulator.glyph,
    dispatchBlurb: "New terminal window in the worktree for each dispatch.",
  };
  if (!emulator.spawn) {
    const reason = `${emulator.label} cannot open a window from outside`;
    return {
      ...base,
      blurb: "",
      detail: null,
      unavailable: reason,
      dispatchUnavailable: reason,
    };
  }
  const unavailable = binUnavailableReason(emulator.bin, emulator.label, deps);
  if (unavailable) {
    return { ...base, blurb: "", detail: null, unavailable, dispatchUnavailable: unavailable };
  }
  return {
    ...base,
    blurb: "New window in the worktree.",
    detail: null,
    unavailable: null,
    dispatchUnavailable: null,
  };
}

/**
 * Every registered backend, in `TERMINAL_BACKEND_IDS` order, each saying whether it can be
 * used and why not.
 *
 * Unavailable rows are RETURNED, not filtered. The browser renders them disabled with the
 * sentence, because "we found no terminal" and "we did not look" read identically as an
 * empty menu, and the fix for the first is a sentence away.
 *
 * Installation answers come from the shared locator generation, so the 1500ms discovery
 * sweep is cheap and every backend sees the same positive or negative result. The Setup
 * refresh action advances that generation after an install or PATH change.
 */
export function terminalTargetViews(
  deps: TerminalTargetDeps = defaultTerminalTargetDeps,
): TerminalTargetView[] {
  const views: TerminalTargetView[] = [];
  for (const id of MULTIPLEXER_IDS) {
    const mux = deps.multiplexers[id];
    if (mux) views.push({ id, ...multiplexerView(mux, deps) });
  }
  for (const id of EMULATOR_IDS) {
    const emulator = deps.emulators[id];
    if (emulator) views.push({ id, ...emulatorView(emulator, deps) });
  }
  return views;
}

export interface TerminalLaunchOutcome {
  ok: boolean;
  /** The backend that took it, for the flash the operator reads. */
  label: string;
  /**
   * The DURABLE terminal home to persist when this launch carries a task, or null when
   * this backend produced none.
   *
   * Null is a first-class answer and the axes genuinely differ. A multiplexer session name
   * is durable: `heldHomeNames` enumerates it and `killHome` addresses it, so a later
   * `homeAlive` can answer truthfully. An emulator tab has no such handle - its title is a
   * label, not a resource, and no backend enumerates it.
   *
   * Returning that title as a home would be worse than returning nothing, which is the
   * defect this replaced. `homeAlive` consults the multiplexer axis when one is installed,
   * a window title is never in that list, so it reads `false` - and `false` is the ONE
   * value that lets `reconcileOnStartup` run `git worktree remove --force`. A task whose
   * agent is alive in a WezTerm tab would have had its checkout deleted on the next daemon
   * restart. Null maps to "could not tell", which reclaims nothing.
   */
  homeName?: string | null;
  error?: string;
  status: number;
}

export type TerminalLauncher = (
  backend: TerminalBackendId,
  spec: TerminalLaunchSpec,
) => Promise<TerminalLaunchOutcome>;

/**
 * Launch an agent command through a selected terminal without trusting that terminal's PATH
 * or inherited Mission Control state.
 *
 * The executable in `spec.argv` is already absolute. The wrapper owns the disposable state
 * home after a successful or outcome-unknown launch and removes it when the agent exits. A
 * confirmed refusal started no agent, so this side releases the home immediately.
 */
export async function launchAgentTerminal(
  backend: TerminalBackendId,
  spec: TerminalLaunchSpec,
  launcher: TerminalLauncher = launchTerminal,
): Promise<TerminalLaunchOutcome> {
  const stateHome = createDisposableAgentStateHome();
  try {
    const argv = isolatedAgentArgv(spec.argv, { cwd: spec.cwd, stateHome });
    const result = await launcher(backend, { ...spec, argv });
    if (!result.ok && result.status !== 504) cleanupDisposableAgentStateHome(stateHome);
    return result;
  } catch (error) {
    cleanupDisposableAgentStateHome(stateHome);
    throw error;
  }
}

function uniqueSessionName(sessions: MuxSessions, baseName: string, launchId: string): string {
  const base = sessions.names.sanitize(baseName);
  const suffix = `-${launchId}`;
  for (let length = base.length; length >= 0; length -= 1) {
    const name = sessions.names.sanitize(`${base.slice(0, length)}${suffix}`);
    if (name.endsWith(suffix)) return name;
  }
  return sessions.names.sanitize(`${launchId}-${base}`);
}

async function spawnDetachedUniquely(
  sessions: MuxSessions,
  spec: Omit<DetachedSessionSpec, "name">,
  baseName: string,
  launchId: () => string,
): Promise<{ name: string; result: TerminalResult }> {
  let name = uniqueSessionName(sessions, baseName, launchId());
  let result = await sessions.spawnDetached({ name, ...spec });
  if (!result.ok && !result.outcomeUnknown) {
    name = uniqueSessionName(sessions, baseName, launchId());
    result = await sessions.spawnDetached({ name, ...spec });
  }
  return { name, result };
}

async function cleanupDetachedFailure(
  sessions: MuxSessions,
  name: string,
  label: string,
  error: string,
): Promise<string> {
  if (!sessions.kill) return `${error}; ${label} cannot clean up the detached session`;
  const cleanup = await sessions.kill(name);
  if (cleanup.ok) return error;
  if (cleanup.outcomeUnknown) {
    return `${error}; cleanup of the detached ${label} session did not report back`;
  }
  return `${error}; cleanup failed: ${cleanup.error ?? `${label} could not close the detached session`}`;
}

/**
 * Open one window, on the backend the operator picked.
 *
 * Deliberately NOT `launchHome`, which walks an axis and takes the first backend that
 * works. That is right for a dispatch, where any home will do; it is wrong here, where the
 * operator has just said which terminal they want and silently getting another one is the
 * whole failure. The availability check is re-run rather than trusted from the view, since
 * the browser caches those for 60s and a terminal can be uninstalled inside that window.
 */
export async function launchTerminal(
  backend: TerminalBackendId,
  spec: TerminalLaunchSpec,
  deps: TerminalTargetDeps = defaultTerminalTargetDeps,
): Promise<TerminalLaunchOutcome> {
  const view = terminalTargetViews(deps).find((v) => v.id === backend);
  if (!view) return { ok: false, label: backend, error: "no such terminal", status: 404 };
  if (view.unavailable) {
    return { ok: false, label: view.label, error: view.unavailable, status: 409 };
  }

  let result: TerminalResult;
  let homeName: string | null;
  const mux = deps.multiplexers[backend];
  if (mux?.sessions) {
    const sessions = mux.sessions;
    const spawned = await spawnDetachedUniquely(
      sessions,
      // This route is an explicit operator request, so the new multiplexer surface should
      // become its internal selection. Raising an OS window remains a separate capability.
      { cwd: spec.cwd, argv: spec.argv, sidePane: false, select: true },
      spec.name,
      deps.launchId,
    );
    const name = spawned.name;
    homeName = name;
    result = spawned.result;
    if (result.ok && sessions.attachArgv) {
      // Detached is not open. A backend whose sessions can exist without a window has only
      // half-finished at this point, and reporting success here would be the exact failure
      // this module's header is about.
      const raise = raiser(deps);
      if (!raise?.spawn) {
        const error = await cleanupDetachedFailure(
          sessions,
          name,
          view.label,
          `${view.label} session started but no terminal could show it`,
        );
        return {
          ok: false,
          label: view.label,
          error,
          status: 502,
        };
      }
      const shown = await raise.spawn.tab({ argv: sessions.attachArgv(name), title: name, cwd: null });
      if (!shown.ok) {
        if (shown.outcomeUnknown) {
          return {
            ok: false,
            label: view.label,
            homeName: name,
            error: `${view.label} did not report back - the window may still be opening`,
            status: 504,
          };
        }
        const error = await cleanupDetachedFailure(
          sessions,
          name,
          view.label,
          shown.error ?? `${raise.label} could not open a window`,
        );
        return {
          ok: false,
          label: view.label,
          error,
          status: 502,
        };
      }
    }
  } else {
    const emulator = deps.emulators[backend];
    if (!emulator?.spawn) {
      return { ok: false, label: view.label, error: "no such terminal", status: 404 };
    }
    // Sanitized on THIS path too, not just the multiplexer's. `TerminalEmulator.names` is
    // required for exactly this reason - `spawn` stamps a title, so an emulator that
    // cannot rename a tab can still be handed one it cannot express - and passing
    // `spec.name` through raw let a control character in a session name reach a real tab
    // title. Both shipped emulators declare `PLAIN_NAMES`, which is what strips it.
    const title = emulator.names.sanitize(spec.name);
    // NOT a home. See `TerminalLaunchOutcome.homeName`: a tab title is a label no backend
    // can enumerate, and persisting it as a home is what makes `homeAlive` say `false` and
    // a restart reclaim a live agent's worktree.
    homeName = null;
    result = await emulator.spawn.tab({ argv: spec.argv, title, cwd: spec.cwd });
  }

  if (result.ok) return { ok: true, label: view.label, homeName, status: 200 };
  // `outcomeUnknown` is not a failure: the spawn may well have landed and saying "it did not
  // work" would send the operator to press it a second time. `openFile` draws this line in
  // the same place.
  if (result.outcomeUnknown) {
    return {
      ok: false,
      label: view.label,
      homeName,
      error: `${view.label} did not report back - the window may still be opening`,
      status: 504,
    };
  }
  return {
    ok: false,
    label: view.label,
    error: result.error ?? `${view.label} could not open a window`,
    status: 502,
  };
}
