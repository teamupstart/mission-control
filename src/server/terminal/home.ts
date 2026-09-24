import type { LaunchProcess } from "./launch-process.ts";
import { readInventory } from "./inventory.ts";
import { EMULATOR_IDS, MULTIPLEXER_IDS } from "@shared/terminal.ts";
import { terminalResourceId } from "@shared/pane.ts";
import {
  binPresent,
  binUnavailableReason,
  binUnsupportedReason,
  type BinAvailabilityDeps,
} from "./bin.ts";
import { PLAIN_NAMES } from "./names.ts";
import { defaultTerminalDeps, type TerminalDeps } from "./registry.ts";
import { underTestRunner } from "../util/test-runner.ts";
import type { SpawnResult, MuxSpawnResult, NameRules, TerminalBackendId, TerminalResult } from "./types.ts";

/**
 * Where a DISPATCHED agent's terminal home comes from, and what can be asked of it
 * afterwards.
 *
 * The dispatcher used to answer all of this with the literal string `"tmux"`: `new-session
 * -d`, `has-session` to probe it, `kill-session` to tear it down, `list-sessions` to pick a
 * free name. A machine with no tmux could not dispatch at all, and nothing said so - the
 * spawn simply failed with an ENOENT the operator had to read out of a task error.
 *
 * ## One backend policy, chosen once
 *
 * In Automatic mode, `homeBackends` returns MULTIPLEXERS if any is installed, and emulators
 * only if none is. With an explicit preference it returns only that exact backend. Automatic
 * follows the precedence rule `enumerateTerminals` already declares -
 * multiplexers before emulators, because a multiplexer pane lives inside an emulator pane
 * and is the inner, more specific answer - applied to creation instead of to naming. An
 * explicit preference returns that one backend only, across either axis.
 *
 * Picking the axis ONCE, in one function every caller shares, is the load-bearing part. The
 * four questions here are asked at four different moments in a task's life, minutes or a
 * restart apart, and three of them are destructive: if `launchHome` and `killHome` could
 * disagree about which axis holds the home, teardown would kill nothing and the operator
 * would be left with a live agent in a worktree that had just been handed back to the pool.
 * They cannot disagree, because neither of them chooses.
 *
 * ## The honest absence
 *
 * A home name proves nothing on a machine where no backend can hold a named home, and
 * `homeAlive` says so with `null` rather than with `false`. The difference decides whether
 * `reconcileOnStartup` reclaims a worktree: `false` tears the tree down and `null` leaves it
 * standing, and the two failure modes are not symmetric. A wrong `false` deletes a live
 * agent's checkout; a wrong `null` leaves a tree the operator reclaims with one click. So an
 * adapter lookup that misses must never arrive at `false` by omission. `reconcileOnStartup`
 * carries the same discipline one step further, defaulting a MISSING `homeName` to `null`
 * too: across the `tmux_session` -> `home_name` migration an unmigrated name reads as absent,
 * and reclaiming on that absence is how a rename would destroy a live agent's tree.
 */

/**
 * The registries, plus the one other question this file asks of a backend: is it installed?
 *
 * `installed` is a dep rather than a direct `binPresent` call because it is the ONLY thing
 * here that reaches outside the process, and without it every test of this file would have
 * to have tmux on the machine running it - which would make the interesting cases (no
 * backend at all; a multiplexer whose sessions are not a killable group; a backend that
 * cannot be enumerated) untestable precisely because they are the ones no developer's
 * machine is in.
 */
export interface HomeDeps extends TerminalDeps, BinAvailabilityDeps {}

export const defaultHomeDeps: HomeDeps = {
  ...defaultTerminalDeps,
  installed: binPresent,
  unsupported: binUnsupportedReason,
};

/** What a new home needs: what to run, where, and under what name. */
export interface HomeSpec {
  name: string;
  cwd: string;
  argv: readonly string[];
  /**
   * Also open a plain shell beside the agent, rooted at the same directory.
   *
   * Best-effort by contract, and an emulator honours it by ignoring it: a tab is one pane
   * and there is nothing to split. A convenience pane is never worth failing a dispatch, so
   * a backend that cannot provide one still reports the home it did create as a success.
   */
  sidePane: boolean;
}

/** The complete terminal-home record returned by a successful launch. */
export interface SpawnedHome {
  /** Ephemeral positive process correlation; only the bound task session id is persisted. */
  launchProcess?: LaunchProcess | null;
  /** Private marker source retained until session readiness if the wrapper starts late. */
  launchStateHome?: string;
  homeName: string;
  homeBackend: TerminalBackendId;
  terminalResourceId: string | null;
}

/** Only these existing task fields are durable; launch observation is not task state. */
export function homeRecord(home: SpawnedHome): Pick<SpawnedHome, "homeName" | "homeBackend" | "terminalResourceId"> & { terminalLaunch: null } {
  return { homeName: home.homeName, homeBackend: home.homeBackend, terminalResourceId: home.terminalResourceId,
    terminalLaunch: null };
}

/**
 * One backend that can hold a dispatched agent's home, with the axis's differences already
 * resolved into four verbs.
 *
 * `held` and `kill` are nullable and their nulls are different claims. A null `held` is "this
 * backend cannot be enumerated", which makes both name-uniqueness and liveness
 * unanswerable HERE rather than answerable as "no". A null `kill` is "these homes are not a
 * group anything can kill at once" - true of every emulator tab, where closing the window is
 * the human's to do and the agent process is reached by its pid instead.
 *
 * ## A name is not an address
 *
 * `held` maps human names to backend addresses for discovery and name allocation. Cleanup
 * uses the address recorded at creation or discovery, never a fresh lookup by mutable name.
 * tmux addresses include a native session ID and the identity of the allocating server;
 * cmux workspaces use UUIDs.
 */
export interface HomeBackend {
  id: TerminalBackendId;
  label: string;
  axis: "multiplexer" | "emulator";
  /** How this backend spells a name - see `NameRules`. */
  names: NameRules;
  /**
   * The homes this backend currently holds, as name -> the address `kill` takes, or null
   * when it cannot be enumerated. See "A name is not an address" above.
   */
  held: (() => Promise<Map<string, string> | null>) | null;
  open(spec: HomeSpec): Promise<MuxSpawnResult | SpawnResult>;
  kill: ((name: string) => Promise<TerminalResult>) | null;
}

/**
 * Every backend that could host a dispatched agent, in precedence order - and from ONE axis.
 *
 * Installed-only, by `binPresent`, for the reason `enumerateTerminals` is: the registries
 * are meant to carry Ghostty, cmux and iTerm2 on a machine that has none of them, and a
 * registered-but-absent adapter must cost nothing but a few `existsSync` calls.
 *
 * Empty is a legitimate answer - a machine with neither a multiplexer nor a scriptable
 * terminal - and every caller below has a defined behaviour for it. None of them is silence.
 */
export function homeBackends(
  deps: HomeDeps = defaultHomeDeps,
  preferredBackend: string | null = null,
): HomeBackend[] {
  const mux: HomeBackend[] = [];
  for (const id of MULTIPLEXER_IDS) {
    const backend = deps.multiplexers[id];
    const sessions = backend.sessions;
    if (!sessions || binUnavailableReason(backend.bin, backend.label, deps)) continue;
    mux.push({
      id,
      label: backend.label,
      axis: "multiplexer",
      names: sessions.names,
      // Derived from the pane list rather than from a `has-session` of its own, and the
      // exactness is the point: tmux's own target matching falls back to a prefix match, so
      // `has-session -t api` answers yes for a session called `api-2`. A dispatch that read
      // that as "the name is taken" would rename for no reason; a teardown that read it as
      // "alive" would leave a tree standing forever.
      //
      // `sessionName` keyed, `session` valued - the two halves of "a name is not an address".
      // Never use this name lookup to authorize teardown.
      held: async () => {
        const panes = await readInventory(id, () => backend.list());
        return panes === null ? null : new Map(panes.map((p) => [p.sessionName, p.session] as const));
      },
      open: (spec) =>
        sessions.spawnDetached({
          name: spec.name,
          cwd: spec.cwd,
          argv: spec.argv,
          sidePane: spec.sidePane,
          // Dispatch is background work. It must not move the operator away from the
          // multiplexer surface they are using when a new home is created.
          select: false,
        }),
      kill: sessions.kill,
    });
  }
  const emu: HomeBackend[] = [];
  for (const id of EMULATOR_IDS) {
    const backend = deps.emulators[id];
    const spawn = backend.spawn;
    if (!spawn || binUnavailableReason(backend.bin, backend.label, deps)) continue;
    const list = backend.list;
    emu.push({
      id,
      label: backend.label,
      axis: "emulator",
      names: backend.names,
      // These are observed tab titles. A dispatched card may retain its launch name
      // separately, so a title rewritten by the shell need not match that card. The
      // address is the pane id - unused today, since no emulator declares a `kill`, and
      // carried anyway so the shape does not have to change when one does.
      held: list
        ? async () => {
            const panes = await readInventory(id, list);
            return panes === null ? null : new Map(panes.filter((p) => p.tabTitle).map((p) => [p.tabTitle, p.paneId] as const));
          }
        : null,
      open: (spec) => spawn.tab({ argv: spec.argv, title: spec.name, cwd: spec.cwd }),
      // Declared, not forgotten: a tab is not a group, and this is the null that says the
      // agent's pid is the only handle its teardown has.
      kill: null,
    });
  }
  if (preferredBackend !== null) {
    return [...mux, ...emu].filter((backend) => backend.id === preferredBackend);
  }
  return mux.length ? mux : emu;
}

/** The naming rules a dispatched home will be created under. */
export function homeNameRules(
  deps: HomeDeps = defaultHomeDeps,
  preferredBackend: string | null = null,
): NameRules {
  // `PLAIN_NAMES` when nothing is installed, so a name can still be cut from a title on a
  // machine that cannot host one - the dispatch fails at `launchHome`, with its own message,
  // rather than at a name that came back empty three steps earlier.
  return homeBackends(deps, preferredBackend)[0]?.names ?? PLAIN_NAMES;
}

/**
 * The names homes already hold, or null when no installed backend can be enumerated.
 *
 * Null and the empty set are different: empty means "asked, and nothing holds a name", which
 * lets a dispatch take the bare label; null means the question could not be asked, and the
 * caller must fall back to a name that is unique by construction rather than assume it is
 * free.
 */
export async function heldHomeNames(
  deps: HomeDeps = defaultHomeDeps,
  preferredBackend: string | null = null,
): Promise<Map<string, string> | null> {
  const selected = homeBackends(deps, preferredBackend);
  // If a selected backend cannot enumerate homes, nobody else may answer on its behalf.
  // A confident false from another terminal would let startup reclaim a live checkout.
  if (selected.some((backend) => !backend.held)) return null;
  const backends = selected.filter((backend) => backend.held);
  if (!backends.length) return null;
  const maps = await Promise.all(backends.map((b) => b.held!()));
  if (maps.some((m) => m === null)) return null;
  return new Map(maps.flatMap((m) => [...m!]));
}

/** What opening a home produced. `where` names the backend, for the error a human reads. */
export type LaunchResult =
  | { ok: true; backend: HomeBackend; resourceId: string | null }
  | { ok: false; error: string };

/**
 * What a test worker is told when it reaches this with the real machine's backends.
 *
 * Exported so the case that pins the boundary asserts the same sentence the guard produces.
 */
export const REAL_BACKEND_UNDER_TEST_RUNNER =
  "refusing to open a real terminal session under the test runner: pass HomeDeps built from " +
  "test/helpers/terminal-fakes.ts, or - for a dispatch - construct the Dispatcher with its " +
  "`spawn` seam, which is what stops `spawnUniquely` opening a session on this machine";

/**
 * Open a terminal home for a dispatched agent on whichever backend is configured.
 *
 * Tries each backend on the chosen axis in order, so a machine with two multiplexers
 * installed and the first one wedged still dispatches. An explicit choice is attempted once
 * and never falls through to a different terminal. The last failure is what the operator is
 * told, because it is the one that is still true.
 *
 * ## Not from a test worker
 *
 * A test that reaches here with the real registries opens a REAL session on the machine
 * running the suite, and nothing in the suite ever closes it. That is not hypothetical:
 * `multi-repo-dispatch.test.ts` built a `Dispatcher` without its `spawn` seam, and its one
 * single-repo case left 42 Herdr workspaces and 2 tmux sessions behind across its runs - one
 * of them still holding a launch pointed at the operator's live daemon on port 7317. The
 * seam existed and was documented for exactly this; the test simply did not use it.
 *
 * So the boundary is stated here, where the session is actually opened, in the same shape
 * `openDb` states the state-dir one: under the test runner, the real backends are refused,
 * and injected ones - which is every existing case in `terminal-home.test.ts` - are not.
 * Production reaches `underTestRunner()` once and returns on its first line.
 *
 * This is not a sandbox, and like `openDb` it is not trying to be one. A test that wants a
 * real tmux session can spawn `tmux` itself without coming through here. What it closes is
 * the accident.
 */
export async function launchHome(
  spec: HomeSpec,
  deps: HomeDeps = defaultHomeDeps,
  preferredBackend: string | null = null,
): Promise<LaunchResult> {
  if (deps === defaultHomeDeps && underTestRunner()) {
    return { ok: false, error: REAL_BACKEND_UNDER_TEST_RUNNER };
  }
  const backends = homeBackends(deps, preferredBackend);
  if (!backends.length) {
    return {
      ok: false,
      // Names what would fix it. A dispatch that fails here fails on every task until
      // something is installed, so "no terminal backend" alone would send the operator
      // looking at their agent binary.
      error: preferredBackend
        ? `the selected terminal backend ${preferredBackend} cannot host a dispatched agent on this machine`
        : "no terminal backend can host a dispatched agent - install one of " +
          [...MULTIPLEXER_IDS, ...EMULATOR_IDS].join(", "),
    };
  }
  let last = "";
  for (const backend of backends) {
    const r = await backend.open(spec);
    if (r.ok) return {
      ok: true,
      backend,
      resourceId: "target" in r
        ? r.target ? `emulator:${backend.id}:${r.target.paneId}` : null
        : r.session ? `multiplexer:${backend.id}:${r.session}` : null,
    };
    last = r.error ?? `${backend.label} could not open a session`;
  }
  return { ok: false, error: last };
}

/**
 * Is the recorded resource still open? A mutable title cannot establish identity on
 * either axis. `null` means nobody could tell, not that the home is gone.
 */
export async function homeAlive(
  _name: string,
  deps: HomeDeps = defaultHomeDeps,
  preferredBackend: string | null = null,
  resourceId: string | null = null,
): Promise<boolean | null> {
  if (resourceId?.startsWith("multiplexer:")) {
    const id = MULTIPLEXER_IDS.find((candidate) => resourceId.startsWith(`multiplexer:${candidate}:`));
    if (!id || (preferredBackend !== null && preferredBackend !== id)) return null;
    const backend = deps.multiplexers[id];
    if (binUnavailableReason(backend.bin, backend.label, deps)) return null;
    if (backend.sessions?.alive) {
      try {
        return await backend.sessions.alive(resourceId.slice(`multiplexer:${id}:`.length));
      } catch {
        return null;
      }
    }
    return (await readInventory(id, () => backend.list!()))?.some((pane) =>
      terminalResourceId({ ...pane, kind: "multiplexer", backend: id }) === resourceId,
    ) ?? null;
  }
  if (resourceId?.startsWith("emulator:")) {
    const id = EMULATOR_IDS.find((candidate) => resourceId.startsWith(`emulator:${candidate}:`));
    if (!id || (preferredBackend !== null && preferredBackend !== id)) return null;
    const backend = deps.emulators[id];
    if (!backend.list || binUnavailableReason(backend.bin, backend.label, deps)) return null;
    return (await readInventory(id, () => backend.list!()))?.some((pane) =>
      terminalResourceId({ ...pane, kind: "emulator", backend: id }) === resourceId,
    ) ?? null;
  }
  // Legacy homes on either axis have no identity with which to confirm absence. A
  // title miss after rename must not undo killHome's refusal and release a live checkout.
  return null;
}

/**
 * What tearing down a named home did.
 *
 * `asked` is the field that matters, and it is separate from `ok` on purpose: a teardown
 * that found no backend able to kill this home did not fail - there was nothing to fail at -
 * but it also did not do what its caller believes it did, and the caller is about to hand
 * the agent's worktree back to a pool. Collapsing the two into a boolean is how that becomes
 * a silent no-op.
 */
export interface KillHomeResult {
  ok: boolean;
  asked: boolean;
  error?: string;
}

/**
 * Close only the recorded resource. A mutable name cannot authorize destructive cleanup:
 * another session may have claimed it since launch. Legacy tasks without an identity
 * remain available for manual cleanup instead of resolving their name to a new owner.
 */
export async function killHome(
  name: string,
  deps: HomeDeps = defaultHomeDeps,
  preferredBackend: string | null = null,
  resourceId: string | null = null,
): Promise<KillHomeResult> {
  const id = MULTIPLEXER_IDS.find((candidate) => resourceId?.startsWith(`multiplexer:${candidate}:`));
  if (!id || (preferredBackend !== null && preferredBackend !== id)) {
    return { ok: false, asked: false, error: `terminal identity for '${name}' is unknown; terminal preserved` };
  }
  const backend = homeBackends(deps, id).find((candidate) => candidate.id === id);
  if (!backend?.kill) return { ok: false, asked: false };
  const address = resourceId!.slice(`multiplexer:${id}:`.length);
  if (!address) return { ok: false, asked: false, error: "terminal identity is empty; terminal preserved" };
  const result = await backend.kill(address);
  return result.ok ? { ok: true, asked: true } : { ok: false, asked: true, error: result.error };
}
