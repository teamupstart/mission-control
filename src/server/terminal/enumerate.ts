import { EMULATOR_IDS, MULTIPLEXER_IDS } from "@shared/terminal.ts";
import { binPresent } from "./bin.ts";
import { hostIsRunning, type HostProc } from "./host.ts";
import { EMULATORS, MULTIPLEXERS } from "./registry.ts";
import type {
  EmulatorId,
  EmulatorPane,
  HostProcessSpec,
  MultiplexerId,
  MuxPane,
} from "./types.ts";

/**
 * Sweeping every registered terminal backend once, so discovery never names a vendor.
 *
 * This is the third composition primitive, beside `bindPane` (writes go innermost) and
 * `hostPanesFor` (focus walks outward): what each backend can SEE, in the order that decides
 * which of them gets to name a session. `correlate.ts` used to `Promise.all` two listers by
 * name into a fixed `{ procs, tmux, wezterm }` struct, which is the structural blocker that
 * gated every other adapter migration - a third backend had nowhere to be.
 */

/**
 * One backend's panes for one tick, tagged with the axis they came from.
 *
 * Tagged by AXIS and not by vendor, and the distinction is the whole design: which
 * multiplexer this is must not be visible to a caller (that is the branch this migration
 * deletes), but multiplexer-versus-emulator must be, because the two interfaces answer
 * genuinely different questions and a session may hold one handle of each.
 */
export type TerminalEnumeration =
  | { kind: "multiplexer"; backend: MultiplexerId; panes: MuxPane[] }
  | {
      kind: "emulator";
      backend: EmulatorId;
      panes: EmulatorPane[];
      /**
       * Carried through from the adapter so correlation can pair panes this backend could
       * not put a tty on. Null for a backend whose panes report their own.
       *
       * On the enumeration rather than fetched from the registry at the far end because
       * `correlate.ts` names no backend and must not start now: it reads what the sweep
       * reported, exactly as it does for `panes`.
       */
      hostProcess: HostProcessSpec | null;
    };

/**
 * Ask every backend that could answer what panes it can see.
 *
 * Order is `MULTIPLEXER_IDS` then `EMULATOR_IDS`, and it is the naming priority: the first
 * entry holding a pane on a session's tty names that session. Multiplexers rank above
 * emulators because a tmux pane lives INSIDE a wezterm pane, so the multiplexer is the inner,
 * more specific answer - which is today's tmux-beats-wezterm precedence, preserved exactly
 * and now stated as a rule rather than as the arm order of an if/else.
 *
 * Three things a backend can be skipped for, and only one of them is a capability:
 *
 *   - `list` is null. An emulator that cannot be enumerated is a legitimate, declared state,
 *     and it simply contributes no panes. (No shipped backend declares it - Ghostty was
 *     expected to and does not; see `ghostty.ts`.)
 *   - the binary is not installed. `binPresent` answers that from the filesystem rather than
 *     by running anything, which is what keeps a registered-but-absent adapter off the
 *     1500ms poll tick: discovery sweeps every backend, so a failed `fork`+`execve` per
 *     adapter per tick is a tax the registry would levy for merely knowing Ghostty exists.
 *     A few `existsSync` calls cost microseconds where a doomed spawn costs milliseconds.
 *   - it declares a `hostProcess` and that process is not running. This one is not an
 *     optimisation, it is a correctness guard: an adapter driven by Apple Events would
 *     LAUNCH its terminal by asking it anything, so an unguarded sweep opens a window on the
 *     operator's desktop every 1500ms. Answered from the process list discovery has already
 *     paid for - the alternative, asking System Events, measured ~160ms per tick.
 *
 * Everything else - installed but not running, no server, no GUI - still spawns and still
 * degrades to `[]`, because "not running now" is not "not installed" and only the CLI can
 * tell us which. The remaining backends are swept concurrently, so the tick costs the
 * slowest one rather than their sum.
 *
 * `procs` is the live process table. It is a parameter rather than something fetched here so
 * this stays a pure sweep over the registries, and so the one reading of `ps` serves both
 * this gate and the correlation that follows it.
 */
export async function enumerateTerminals(
  procs: readonly HostProc[] = [],
): Promise<TerminalEnumeration[]> {
  const work: Promise<TerminalEnumeration>[] = [];

  for (const id of MULTIPLEXER_IDS) {
    const backend = MULTIPLEXERS[id];
    if (!binPresent(backend.bin)) continue;
    work.push(
      safely(() => backend.list(), `multiplexer ${id}`).then((panes) => ({
        kind: "multiplexer" as const,
        backend: id,
        panes,
      })),
    );
  }

  for (const id of EMULATOR_IDS) {
    const backend = EMULATORS[id];
    const list = backend.list;
    if (!list || !binPresent(backend.bin)) continue;
    const hostProcess = backend.hostProcess;
    if (hostProcess && !hostIsRunning(hostProcess, procs)) continue;
    work.push(
      safely(() => list(), `emulator ${id}`).then((panes) => ({
        kind: "emulator" as const,
        backend: id,
        panes,
        hostProcess,
      })),
    );
  }

  // Order is restored by `Promise.all` regardless of which backend answered first, so the
  // naming priority above is a property of the registries and not of the machine's timing.
  return Promise.all(work);
}

/**
 * Contain one backend's failure to that backend.
 *
 * The two shipped adapters cannot reject - `run` never throws - but the contract must not
 * depend on that, because the sweep is a `Promise.all` and the poller's only handler is a
 * `console.error` around the whole tick. One adapter throwing would otherwise take the
 * ENTIRE sweep down: every card on the machine would vanish because a backend nobody is
 * using misbehaved, which is exactly the silent-degradation promise inverted.
 */
async function safely<T>(work: () => Promise<T[]>, who: string): Promise<T[]> {
  try {
    return await work();
  } catch (err) {
    console.error(`[discovery] ${who} failed to enumerate:`, err);
    return [];
  }
}
