import { binDropEnv, binEnv, binUnsupportedReason, resolveBin } from "./bin.ts";
import { FIXED_OS_EXECUTABLES } from "../executables/catalog.ts";
import {
  asTerminal,
  createHerdrClient,
  type HerdrClientDeps,
  type HerdrProbe,
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

export const HERDR_BIN: BinSpec = {
  id: "herdr",
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

/** How long to watch for the pasted command before submitting it anyway. */
const PASTE_SETTLE_TIMEOUT_MS = 2_000;
const PASTE_POLL_MS = 50;
/** The measured-sufficient delay for a pane whose visible text cannot be read at all. */
const PASTE_SETTLE_FALLBACK_MS = 400;
/** Enough of the command's tail to identify it on the pane, and short enough to survive a
 * narrow pane's rewrapping. */
const PASTE_TAIL_CHARS = 24;
/** How long an agent has to become the pane's foreground process before the launch failed. */
const LAUNCH_START_TIMEOUT_MS = 5_000;
const LAUNCH_POLL_MS = 100;

/** A pane wraps a long line across rows, so pasted text is matched without its layout. */
function withoutWhitespace(text: string): string {
  return text.replace(/\s+/g, "");
}

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
  const sleep = clientDeps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const now = clientDeps.now ?? Date.now;

  /**
   * Wait for the pasted command to appear on the pane before its Enter is sent.
   *
   * This is the defect this file was rewritten for. `pane.send_input` carries text and keys
   * in one call, and at dispatch size the Enter lands INSIDE the bracketed paste the shell is
   * still consuming - it becomes a literal newline in the edit buffer instead of a submit, so
   * the command sits at the prompt and nothing starts. Measured against the live 0.9.0 server
   * at 3,009 bytes: one combined call ran the command 1 time in 6; the same text followed by
   * a separate `pane.send_keys` ran it 6 times in 6.
   *
   * An observation rather than a fixed sleep, because a sleep long enough to be safe on a
   * loaded machine is one every dispatch pays. The pane's own visible text is the evidence
   * that the paste landed, compared without whitespace because a pane wraps a long line
   * across rows.
   *
   * Nothing here fails a launch. A pane that cannot be read, or that never shows the tail,
   * still gets its Enter and is judged by `launchStarted` - which is the check that can
   * actually tell whether an agent is running.
   */
  const pasteSettled = async (paneId: string, command: string): Promise<void> => {
    const tail = withoutWhitespace(command).slice(-PASTE_TAIL_CHARS);
    const deadline = now() + PASTE_SETTLE_TIMEOUT_MS;
    for (;;) {
      const seen = await client.read(paneId);
      if (!seen.ok) {
        // No way to observe it. Fall back to the delay that was measured to be enough.
        await sleep(PASTE_SETTLE_FALLBACK_MS);
        return;
      }
      if (withoutWhitespace(seen.value).includes(tail)) return;
      if (now() >= deadline) return;
      await sleep(PASTE_POLL_MS);
    }
  };

  /**
   * Did the pane actually start something? `true` yes, `false` it is still only its login
   * shell, `null` the pane would not say.
   *
   * The predicate is a pid comparison inside ONE response. `shell_pid` names the pane's login
   * shell rather than its foreground process, so comparing it across responses proves
   * nothing, and `name` is the process TITLE - for Claude that is its version string, not
   * `claude` - so a name match proves nothing either. A pane has started the agent when
   * `foreground_processes` carries an entry whose pid differs from `shell_pid`.
   *
   * An absent or empty `foreground_processes`, an absent `shell_pid` and a failed lookup are
   * all "cannot tell", never "not started": the field is optional in the wire schema, and
   * reading its absence as a negative would close a workspace on no evidence.
   */
  const launchStarted = async (paneId: string): Promise<boolean | null> => {
    const deadline = now() + LAUNCH_START_TIMEOUT_MS;
    let last: boolean | null = null;
    for (;;) {
      const info = await client.processInfo(paneId);
      const shellPid = info.ok ? info.value?.shell_pid ?? null : null;
      const foreground = info.ok ? info.value?.foreground_processes ?? [] : [];
      last = shellPid === null || foreground.length === 0
        ? null
        : foreground.some((process) => process.pid !== shellPid);
      if (last === true) return true;
      if (now() >= deadline) return last;
      await sleep(LAUNCH_POLL_MS);
    }
  };

  return {
    id: "herdr",
    label: "Herdr",
    glyph: "▦",
    bin: HERDR_BIN,

    // `[]` when the Herdr server is not running, cannot be reached, or answers with anything
    // this adapter will not build a pane list from - the same contract tmux and cmux state in
    // their own listers. Discovery sweeps every installed backend on a 1500ms tick, so a
    // throw here is not a diagnostic: `enumerateTerminals` catches it and prints a stack
    // trace forever on any machine where the herdr CLI is installed and its server is simply
    // not up, which is the ordinary resting state of that machine. The state IS worth
    // reporting, so it is reported where an operator can act on it and where it is said once:
    // the Setup row for Herdr probes the server and offers to start it. See
    // `herdrServerProbe` below.
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
        const process = processes.get(pane.pane_id) ?? null;
        // One pane that does not resolve is skipped; it is not a reason to report that this
        // machine has no Herdr panes at all. `[]` still means exactly "no panes", and the
        // `uniqueBy` checks above still produce it for a snapshot whose own identities are
        // untrustworthy - see the note on the client's per-pane degradation.
        if (!workspace || !tab || tab.workspace_id !== workspace.workspace_id) continue;
        out.push({
          session: workspace.workspace_id,
          sessionName: workspace.label,
          windowIndex: tab.number,
          windowName: tab.label,
          paneId: pane.pane_id,
          panePid: process?.shell_pid && process.shell_pid > 0 ? process.shell_pid : null,
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
        const rollback = async (failure: TerminalResult): Promise<TerminalResult> => {
          const rolledBack = await client.closeWorkspace(workspaceId);
          if (rolledBack.ok) return failure;
          return {
            ok: false,
            outcomeUnknown: rolledBack.outcomeUnknown,
            error: `${failure.error ?? "Herdr command delivery was refused"}; rollback failed: ${rolledBack.error ?? "Herdr workspace close failed"}`,
          };
        };

        const command = shellCommand(spec.argv);
        const delivered = await client.sendInput(paneId, command);
        if (!delivered.ok) {
          // An outcome-unknown delivery may have reached the pane and started an agent, so
          // it is the one failure that keeps its workspace.
          return delivered.outcomeUnknown ? delivered : rollback(delivered);
        }

        await pasteSettled(paneId, command);
        const submitted = await client.sendKeys(paneId, ["enter"]);
        if (!submitted.ok) {
          return submitted.outcomeUnknown ? submitted : rollback(submitted);
        }

        const started = await launchStarted(paneId);
        if (started !== true) {
          const error = started === false
            ? "Herdr accepted the launch command but the shell never ran it"
            : "Herdr accepted the launch command and could not say whether the shell ran it";
          // Only a CONFIRMED shell-only pane is rolled back. "Could not tell" is treated the
          // way an outcome-unknown delivery is: closing the workspace would be closing one
          // that may be holding a live agent, which is the worse of the two mistakes.
          const failed: TerminalResult = { ok: false, error, outcomeUnknown: started === null };
          return started === false ? rollback(failed) : failed;
        }

        if (spec.sidePane) {
          // Convenience only. It shares the launch cwd and never steals selection from the
          // agent pane; failure cannot turn a successfully launched workspace into a failure.
          await client.splitPane({ paneId, cwd: spec.cwd });
        }
        return { ok: true, outcomeUnknown: false };
      },

      attachArgv: () => [
        FIXED_OS_EXECUTABLES.env,
        ...binDropEnv(HERDR_BIN).flatMap((name) => ["-u", name]),
        resolveBin(HERDR_BIN),
      ],

      rename: async (from, to) => unsupported() ?? client.renameWorkspace(from, to),
      kill: async (workspaceId) => unsupported() ?? client.closeWorkspace(workspaceId),
      names: PLAIN_NAMES,
    },
  };
}

/**
 * The Herdr server's own readiness, and starting it - the two operations Setup needs and
 * the `Multiplexer` interface has no place for.
 *
 * Here rather than in `server/setup`, because both are Herdr's transport talking to Herdr:
 * `probe` is the same `herdr status server --json` reading every write in this file already
 * gates on, and `start` is `ensureReady`, which is exactly what a dispatch to Herdr does
 * before it creates a workspace. A second spawn of `herdr server` composed in the setup
 * layer would be a second answer to "how is this server started".
 */
export function herdrServerProbe(exec: TerminalExec = defaultExec): Promise<HerdrProbe> {
  return createHerdrClient(exec, HERDR_BIN).probe();
}

/** Start Herdr's default server and wait for it to answer, or say why it did not. */
export async function herdrServerStart(exec: TerminalExec = defaultExec): Promise<TerminalResult> {
  return unsupported() ?? asTerminal(await createHerdrClient(exec, HERDR_BIN).ensureReady());
}

/** Exposed for exact environment-isolation tests without widening the adapter interface. */
export function herdrEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return binEnv(HERDR_BIN, base);
}
