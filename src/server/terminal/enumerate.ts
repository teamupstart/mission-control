import { readInventory, type TerminalInventory } from "./inventory.ts";
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
  | { kind: "multiplexer"; backend: MultiplexerId; panes: TerminalInventory<MuxPane> }
  | {
      kind: "emulator";
      backend: EmulatorId;
      panes: TerminalInventory<EmulatorPane>;
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
 * Four things a backend can be skipped for, and only one of them is a capability:
 *
 *   - `list` is null. An emulator that cannot be enumerated is a legitimate, declared state,
 *     and it simply contributes no panes. (No shipped backend declares it - Ghostty was
 *     expected to and does not; see `ghostty.ts`.)
 *   - the adapter does not support this host. `binPresent` asks the shared `BinSpec` gate
 *     before touching the filesystem, so an unsupported transport cannot accidentally run.
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
 * reports unknown inventory (`null`), because "not running now" is not "not installed" and only the CLI can
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
      readInventory(() => backend.list()).then((panes) => ({
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
      readInventory(() => list()).then((panes) => ({
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
