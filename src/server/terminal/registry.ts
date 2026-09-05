import { backendPaneToken, innermostPane, type PaneHandles } from "@shared/pane.ts";
import {
  MULTIPLEXER_IDS,
  type TerminalBackendId,
  type TerminalHandle,
} from "@shared/terminal.ts";
import { cmuxMultiplexer } from "./cmux.ts";
import { defaultExec, type TerminalExec } from "./exec.ts";
import { ghosttyEmulator } from "./ghostty.ts";
import { herdrMultiplexer } from "./herdr.ts";
import { itermEmulator } from "./iterm.ts";
import { tmuxMultiplexer } from "./tmux.ts";
import { weztermEmulator } from "./wezterm.ts";
import type {
  BinSpec,
  EmulatorId,
  EmulatorPane,
  EmulatorTarget,
  Key,
  MultiplexerId,
  Multiplexer,
  MuxClient,
  MuxTarget,
  TerminalEmulator,
  TerminalResult,
} from "./types.ts";

/**
 * The two backend registries, and the rule for composing a session's handles.
 *
 * `Record<MultiplexerId, Multiplexer>` is the same compiler enforcement
 * `SESSION_FIELD_COMPARATORS` uses in `server/registry.ts`: adding an id to the union
 * fails typecheck until an adapter exists, and an adapter cannot exist until every
 * capability is either implemented or explicitly declared null. Nothing here may become a
 * lookup with a default - a default is how a backend ends up half-integrated and quiet
 * about it.
 *
 * ## The composition rule
 *
 * A session may hold a multiplexer handle, an emulator handle, or BOTH - a tmux pane lives
 * inside a wezterm pane, and `correlate` keeps both handles when one tty maps to each.
 * Given both:
 *
 *   - **Writes and captures prefer the innermost handle.** The agent's real pane is the
 *     multiplexer pane; the emulator handle addresses the client showing it, so typing
 *     there types at whatever that client currently displays. `bindPane` is this rule, and
 *     it is the only place it is written: `sendText`, `injectPrompt` and `capturePaneText`
 *     each open-coded it identically before the pane-I/O migration. It defers to
 *     `innermostPane` (`@shared/pane.ts`) rather than restating the rule, because the write
 *     lock keys on that same answer without a subprocess seam - a fourth copy is how the
 *     lock comes to guard a different pane than the write lands on.
 *
 *   - **Focus walks outward.** Selecting the pane inside the multiplexer
 *     (`Multiplexer.select`) decides what the session shows; it raises nothing. Bringing it
 *     in front of a human is then the emulator's job, and for a multiplexer-hosted session
 *     the emulator handle on the session is NOT the tab to raise: the agent sits on a
 *     multiplexer pane tty while the tab sits on the client tty. The tab is found by
 *     joining `Multiplexer.clients` to `TerminalEmulator.list` on that shared tty
 *     (`hostPanesFor`), and only if no tab hosts it does the walk end at
 *     `EmulatorSpawn.tab(attachArgv(session))`.
 *
 * The second half is why this is two interfaces. Every step of that walk needs a capability
 * the other axis does not have.
 */

/**
 * The registries are FACTORIES over the subprocess seam, with the module-level records
 * below being them at the default one.
 *
 * The seam has to reach this far because the policy in `actions.ts` is a read-write-read -
 * probe the pane's mode, write, read the pane back - and a caller that can fake only some
 * of those commands drives none of the sequences. Before the pane-I/O migration that file
 * threaded its own `Exec` into hand-rolled `run("tmux", …)` calls; the adapters are now
 * what run the commands, so the seam is theirs to be built with. Every other caller
 * (discovery, enumeration) wants the real thing and reads the records.
 *
 * Each id is still written exactly once per axis, which is what `Record<MultiplexerId, …>`
 * is here to enforce.
 */
export function multiplexers(exec: TerminalExec = defaultExec): Record<MultiplexerId, Multiplexer> {
  return {
    tmux: tmuxMultiplexer(exec),
    herdr: herdrMultiplexer(exec),
    cmux: cmuxMultiplexer(exec),
  };
}

export function emulators(exec: TerminalExec = defaultExec): Record<EmulatorId, TerminalEmulator> {
  return { wezterm: weztermEmulator(exec), ghostty: ghosttyEmulator(exec), iterm: itermEmulator(exec) };
}

export const MULTIPLEXERS: Record<MultiplexerId, Multiplexer> = multiplexers();

export const EMULATORS: Record<EmulatorId, TerminalEmulator> = emulators();

function isMultiplexerId(id: TerminalBackendId): id is MultiplexerId {
  return MULTIPLEXER_IDS.includes(id as MultiplexerId);
}

/** Resolve a terminal registry id to the binary spec owned by its adapter. */
export function terminalBackendBin(id: TerminalBackendId): BinSpec {
  return isMultiplexerId(id) ? MULTIPLEXERS[id].bin : EMULATORS[id].bin;
}

/**
 * Both registries as one injectable object - the seam the LIFECYCLE operations are driven
 * through, the way pane I/O is driven through `PaneDeps.pane`.
 *
 * Whole registries rather than a bag of function fields (`renameTmuxSession`,
 * `setWeztermTabTitle`, `killTmuxSession` - what `RenameDeps` and `KillDeps` used to be),
 * because those named a vendor per call and so could only ever assert the two-backend
 * branch. What has to be assertable now is the COMPOSITION and the capability nulls: a
 * multiplexer that cannot report its clients, an emulator that cannot raise a tab, a
 * multiplexer whose sessions are not a killable group. Every one of those is a hand-built
 * adapter in a record here, and none of them needs a subprocess.
 */
export interface TerminalDeps {
  multiplexers: Record<MultiplexerId, Multiplexer>;
  emulators: Record<EmulatorId, TerminalEmulator>;
}

export const defaultTerminalDeps: TerminalDeps = {
  multiplexers: MULTIPLEXERS,
  emulators: EMULATORS,
};

/** The three write verbs, already aimed at one pane. See `PaneWrite` for their contract. */
export interface BoundWrite {
  text(text: string): Promise<TerminalResult>;
  keys(keys: readonly Key[]): Promise<TerminalResult>;
  paste: ((text: string) => Promise<TerminalResult>) | null;
}

/**
 * One session's pane, with the backend and the target already applied.
 *
 * Partial application is the point. A caller holding this cannot ask which vendor it got,
 * and so cannot branch on one: the difference between a multiplexer target and an emulator
 * target - the difference that put `if (session.tmux) … else if (session.wezterm) …` into
 * six pane-I/O functions, and still shapes focus and rename - is closed over here. What
 * remains visible are capability nulls, which callers SHOULD branch on, because those are
 * real differences in what can be done rather than in who is doing it.
 */
export interface BoundPane {
  kind: "multiplexer" | "emulator";
  backend: MultiplexerId | EmulatorId;
  /** Human label for error text ("tmux", "WezTerm"). */
  label: string;
  /**
   * The pane's identity as a string, for lock keys, miss counters and log lines.
   *
   * The same spelling `paneToken` (`@shared/pane.ts`) emits, which is where phase 0
   * collapsed the four copies that used to disagree - and now literally the same
   * constructor, over the same resolved handle, so a third multiplexer needs no token
   * function written for it. `terminal-registry.test.ts` still pins the two together.
   */
  token: string;
  /** Null when the backend cannot type into a pane at all (an emulator with no scripting). */
  write: BoundWrite | null;
  capture: (() => Promise<string | null>) | null;
  /**
   * The multiplexer mode swallowing keystrokes right now, or null for none. Null CAPABILITY
   * means the backend has no such concept - an emulator never does. The two must not be
   * conflated: "no mode" is evidence a write will land, "cannot ask" is not.
   */
  mode: (() => Promise<string | null>) | null;
}

/**
 * Resolve a session's handles to the one pane its writes and captures address.
 *
 * The innermost handle wins - see the composition rule above. Which handle that is is
 * `innermostPane`'s answer, shared with the browser and with `paneToken`, so the pane a
 * lock protects is the pane the write lands on by construction rather than by three
 * functions agreeing. Null means the session has no pane we can drive, which is a
 * legitimate state (an agent in a terminal we do not integrate with) and the honest error
 * for every caller that needed one.
 *
 * `exec` is the subprocess seam the bound adapter runs its commands through; the default is
 * the real one. See `multiplexers` for why a policy caller supplies its own.
 */
export function bindPane(
  terminals: readonly TerminalHandle[],
  exec: TerminalExec = defaultExec,
): BoundPane | null {
  const handle = innermostPane({ terminals });
  if (handle?.kind === "multiplexer") {
    const mux = handle;
    const backend = multiplexers(exec)[mux.backend];
    const target: MuxTarget = mux;
    // Each capability is read out before being bound, so a null stays a null rather than
    // becoming a closure that dereferences one.
    const { write, capture, paneMode } = backend;
    return {
      kind: "multiplexer",
      backend: backend.id,
      label: backend.label,
      token: backendPaneToken(backend.id, mux.paneId),
      write: {
        text: (text) => write.text(target, text),
        keys: (keys) => write.keys(target, keys),
        paste: write.paste ? (text) => write.paste!(target, text) : null,
      },
      capture: capture ? () => capture(target) : null,
      mode: paneMode ? () => paneMode(target) : null,
    };
  }
  if (handle?.kind === "emulator") {
    const emu = handle;
    const backend = emulators(exec)[emu.backend];
    const target: EmulatorTarget = emu;
    const { write, capture } = backend;
    return {
      kind: "emulator",
      backend: backend.id,
      label: backend.label,
      token: backendPaneToken(backend.id, emu.paneId),
      write: write
        ? {
            text: (text) => write.text(target, text),
            keys: (keys) => write.keys(target, keys),
            paste: write.paste ? (text) => write.paste!(target, text) : null,
          }
        : null,
      capture: capture ? () => capture(target) : null,
      // An emulator has no session-level input mode to be stuck in. This is the null that
      // says so, rather than a probe that always answers "not in one".
      mode: null,
    };
  }
  return null;
}

/**
 * The one pane a session's reads and writes address, or null when it has none.
 *
 * The `Session`-shaped door onto `bindPane`, and all that is left of `terminal/handles.ts` -
 * the file that projected `Session.tmux` / `Session.wezterm` onto handles and back. With
 * the session carrying the list itself there is nothing left to project, which is what that
 * file's own doc said its deletion would look like.
 */
export function bindSession(s: PaneHandles, exec: TerminalExec = defaultExec): BoundPane | null {
  return bindPane(s.terminals, exec);
}

/**
 * The emulator panes whose tabs host a client attached to `session`, in enumeration order.
 *
 * The outward half of the composition rule, kept pure because it is a join and not an
 * effect. Both ttys arrive normalized by the adapters (`normTty`), so this is an equality
 * test. The join it replaced did that strip inline, on one side only - a normalization bug
 * waiting for a backend that reports the `/dev/` prefix on both.
 */
export function hostPanesFor(
  session: string,
  clients: readonly MuxClient[],
  panes: readonly EmulatorPane[],
): EmulatorPane[] {
  const ttys = new Set(
    clients.filter((c) => c.session === session && c.tty).map((c) => c.tty as string),
  );
  return panes.filter((p) => p.tty && ttys.has(p.tty));
}
