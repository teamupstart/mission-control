import { binEnv, binUnsupportedReason, resolveBin } from "./bin.ts";
import {
  asTerminal,
  createHerdrClient,
  type HerdrClientDeps,
} from "./herdr-client.ts";
import { defaultExec, type TerminalExec } from "./exec.ts";
import { PLAIN_NAMES } from "./names.ts";
import { shellCommand } from "./shell.ts";
import type {
  BinSpec,
  Key,
  Multiplexer,
  MuxPane,
  TerminalResult,
} from "./types.ts";

export const HERDR_UNSUPPORTED_REASON = "Herdr integration is supported on macOS and Linux only";

const HERDR_ENV_SELECTORS = [
  "HERDR_SESSION",
  "HERDR_SOCKET_PATH",
  "HERDR_WORKSPACE_ID",
  "HERDR_TAB_ID",
  "HERDR_PANE_ID",
] as const;

export const HERDR_BIN: BinSpec = {
  env: "HERDR_BIN",
  candidates: ["herdr"],
  dropEnv: HERDR_ENV_SELECTORS,
  unsupportedReason: (platform) =>
    platform === "darwin" || platform === "linux" ? null : HERDR_UNSUPPORTED_REASON,
};

const KEY_NAMES: Record<Key, string> = {
  enter: "enter",
  escape: "esc",
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  tab: "tab",
  "shift-up": "shift+up",
  "shift-down": "shift+down",
  "shift-tab": "shift+tab",
};

function unsupported(): TerminalResult | null {
  const error = binUnsupportedReason(HERDR_BIN);
  return error ? { ok: false, error, outcomeUnknown: false } : null;
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): Map<string, T> | null {
  const out = new Map<string, T>();
  for (const value of values) {
    const id = key(value);
    if (out.has(id)) return null;
    out.set(id, value);
  }
  return out;
}

export function herdrMultiplexer(
  exec: TerminalExec = defaultExec,
  clientDeps: Partial<HerdrClientDeps> = {},
): Multiplexer {
  const client = createHerdrClient(exec, HERDR_BIN, clientDeps);

  return {
    id: "herdr",
    label: "Herdr",
    glyph: "▦",
    bin: HERDR_BIN,

    list: async (): Promise<MuxPane[]> => {
      if (unsupported()) return [];
      const listed = await client.snapshotWithProcesses();
      if (!listed.ok) return [];
      const { snapshot, processes } = listed.value;
      const workspaces = uniqueBy(snapshot.workspaces, (workspace) => workspace.workspace_id);
      const tabs = uniqueBy(snapshot.tabs, (tab) => tab.tab_id);
      const panes = uniqueBy(snapshot.panes, (pane) => pane.pane_id);
      if (!workspaces || !tabs || !panes) return [];

      const out: MuxPane[] = [];
      for (const pane of snapshot.panes) {
        const workspace = workspaces.get(pane.workspace_id);
        const tab = tabs.get(pane.tab_id);
        const process = processes.get(pane.pane_id);
        if (!workspace || !tab || tab.workspace_id !== workspace.workspace_id || !process) return [];
        out.push({
          session: workspace.workspace_id,
          sessionName: workspace.label,
          windowIndex: tab.number,
          windowName: tab.label,
          paneId: pane.pane_id,
          panePid: process.shell_pid && process.shell_pid > 0 ? process.shell_pid : null,
          // Herdr 0.8.2 does not publish pane ttys. Keeping this null is what activates the
          // Phase 1 exact shell-PID ancestry join without pretending a client tty is a pane tty.
          tty: null,
          cwd: pane.foreground_cwd ?? pane.cwd ?? null,
        });
      }
      return out;
    },

    // Stable Herdr does not expose attached-client tty identities. Generic focus therefore
    // selects internally and opens the normal full client through the existing fallback.
    clients: null,

    write: {
      text: async (target, text) => unsupported() ?? client.sendText(target.paneId, text),
      keys: async (target, keys) =>
        unsupported() ?? client.sendKeys(target.paneId, keys.map((key) => KEY_NAMES[key])),
      // `pane.send_input` observes the pane's live bracketed-paste mode. No synthetic
      // markers are added, and no Enter key is included on this composer path.
      paste: async (target, text) => unsupported() ?? client.sendInput(target.paneId, text),
    },

    capture: async (target) => {
      if (unsupported()) return null;
      const result = await client.read(target.paneId);
      return result.ok ? result.value : null;
    },

    // Herdr writes to its owned PTY and has no public mode equivalent that can swallow input.
    paneMode: null,

    select: async (target) => unsupported() ?? client.focusAgent(target.paneId),

    sessions: {
      async spawnDetached(spec) {
        const host = unsupported();
        if (host) return host;
        const created = await client.createWorkspace({
          label: spec.name,
          cwd: spec.cwd,
          focus: spec.select,
        });
        if (!created.ok) return asTerminal(created);

        const workspaceId = created.value.workspace.workspace_id;
        const paneId = created.value.root_pane.pane_id;
        const delivered = await client.sendInput(paneId, shellCommand(spec.argv), ["enter"]);
        if (!delivered.ok) {
          if (!delivered.outcomeUnknown) {
            const rolledBack = await client.closeWorkspace(workspaceId);
            if (!rolledBack.ok) {
              return {
                ok: false,
                outcomeUnknown: rolledBack.outcomeUnknown,
                error: `${delivered.error ?? "Herdr command delivery was refused"}; rollback failed: ${rolledBack.error ?? "Herdr workspace close failed"}`,
              };
            }
          }
          return delivered;
        }

        if (spec.sidePane) {
          // Convenience only. It shares the launch cwd and never steals selection from the
          // agent pane; failure cannot turn a successfully launched workspace into a failure.
          await client.splitPane({ paneId, cwd: spec.cwd });
        }
        return { ok: true, outcomeUnknown: false };
      },

      attachArgv: () => [
        "env",
        ...HERDR_ENV_SELECTORS.flatMap((name) => ["-u", name]),
        resolveBin(HERDR_BIN),
      ],

      rename: async (from, to) => unsupported() ?? client.renameWorkspace(from, to),
      kill: async (workspaceId) => unsupported() ?? client.closeWorkspace(workspaceId),
      names: PLAIN_NAMES,
    },
  };
}

/** Exposed for exact environment-isolation tests without widening the adapter interface. */
export function herdrEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return binEnv(HERDR_BIN, base);
}
