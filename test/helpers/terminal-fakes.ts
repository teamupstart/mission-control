import type {
  BinSpec,
  EmulatorPane,
  Multiplexer,
  MuxClient,
  MuxPane,
  TerminalEmulator,
  TerminalResult,
} from "../../src/server/terminal/types.ts";
import { PLAIN_NAMES } from "../../src/server/terminal/names.ts";
import type { TerminalDeps } from "../../src/server/terminal/registry.ts";

/**
 * Hand-built terminal backends for the lifecycle tests.
 *
 * These are NOT fake tmux and fake wezterm. The point of driving focus / rename / kill
 * through whole registries is that the capability NULLS become reachable - a multiplexer
 * that cannot report its clients, an emulator that can be launched into but not enumerated,
 * a multiplexer whose sessions are not a killable group - and none of those describes a
 * shipped backend. A path first exercised by Ghostty is a path that ships broken, so every
 * builder below defaults to "declares nothing" and each test turns on exactly the
 * capabilities its claim is about.
 */

/**
 * Distinct specs per axis, so a test can say "only the emulator is installed" by identity.
 * `homeBackends` asks `installed(backend.bin)`, and one shared spec would make that question
 * unanswerable for exactly the machine shape this layer exists for.
 */
export const MUX_BIN: BinSpec = { env: null, candidates: ["fake-mux"], dropEnv: [] };
export const EMU_BIN: BinSpec = { env: null, candidates: ["fake-emu"], dropEnv: [] };

export const OK: TerminalResult = { ok: true, outcomeUnknown: false };
export const FAIL = (error: string): TerminalResult => ({ ok: false, error, outcomeUnknown: false });

export function fakeMultiplexer(over: Partial<Multiplexer> = {}): Multiplexer {
  return {
    id: "tmux",
    label: "tmux",
    bin: MUX_BIN,
    list: async () => [],
    write: {
      text: async () => OK,
      keys: async () => OK,
      paste: null,
    },
    clients: null,
    capture: null,
    paneMode: null,
    select: null,
    sessions: null,
    ...over,
  };
}

export function fakeEmulator(over: Partial<TerminalEmulator> = {}): TerminalEmulator {
  return {
    id: "wezterm",
    label: "WezTerm",
    bin: EMU_BIN,
    list: null,
    write: null,
    capture: null,
    focus: null,
    spawn: null,
    retitle: null,
    names: PLAIN_NAMES,
    ...over,
  };
}

/** The two records, from one multiplexer and one emulator - what `TerminalDeps` wants. */
export function fakeTerminals(mux: Multiplexer, emu: TerminalEmulator): TerminalDeps {
  return { multiplexers: { tmux: mux }, emulators: { wezterm: emu } };
}

/** One multiplexer pane, for a `list` that has to answer with something. */
export function muxPane(over: Partial<MuxPane> = {}): MuxPane {
  return {
    session: "api",
    windowIndex: 0,
    windowName: "agent",
    paneId: "%3",
    panePid: 42,
    tty: "ttys028",
    cwd: "/w/api",
    ...over,
  };
}

export function muxClient(over: Partial<MuxClient> = {}): MuxClient {
  return { tty: "ttys012", session: "api", ...over };
}

export function emulatorPane(over: Partial<EmulatorPane> = {}): EmulatorPane {
  return {
    paneId: "5",
    tabId: "2",
    windowId: "1",
    tabTitle: "api",
    windowTitle: "",
    isActive: false,
    tty: "ttys012",
    cwd: null,
    ...over,
  };
}
