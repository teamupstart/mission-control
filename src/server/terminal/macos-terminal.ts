import { MACOS_TERMINAL_FLAG_ID } from "@shared/feature-flag-registry.ts";
import { normTty } from "../discovery/tty.ts";
import { FIXED_OS_EXECUTABLES } from "../executables/catalog.ts";
import { featureEnabled } from "../feature-flags/index.ts";
import { appleScriptString, appleScriptText } from "./applescript.ts";
import { defaultExec, toResult, type TerminalExec } from "./exec.ts";
import { PLAIN_NAMES } from "./names.ts";
import { shellCommand } from "./shell.ts";
import type { EmulatorPane, TerminalEmulator } from "./types.ts";

const BUNDLE_ID = "com.apple.Terminal";
const APP = `application id "${BUNDLE_ID}"`;
const TIMEOUT_MS = 4000;

// Terminal has no persistent tab ID. Its TTY identifies the current tab even when the tab
// changes position or moves to another window. Use it for correlation and focus, where a stale match cannot write or close a tab.
function terminalTty(raw: string): string | null {
  const tty = normTty(raw);
  return tty && /^ttys[0-9]+$/.test(tty) ? tty : null;
}

function parsePanes(stdout: string): EmulatorPane[] | null {
  const panes: EmulatorPane[] = [];
  const seen = new Set<string>();
  for (const record of stdout.trim().split("\n")) {
    if (!record) continue;
    const [windowId, device, active, extra] = record.split("\t");
    const tty = terminalTty(device ?? "");
    if (!windowId || !/^\d+$/.test(windowId) || !tty || seen.has(tty) ||
        (active !== "1" && active !== "0") || extra !== undefined) return null;
    seen.add(tty);
    panes.push({
      paneId: tty,
      tabId: tty,
      tty,
      windowId,
      tabTitle: "",
      windowTitle: "",
      cwd: null,
      isActive: active === "1",
    });
  }
  return panes;
}

const listScript = `
if not (${APP} is running) then error "Terminal is not running"
tell ${APP}
  set rows to ""
  repeat with terminalWindow in windows
    set windowId to id of terminalWindow
    repeat with terminalTab in tabs of terminalWindow
      set activeFlag to "0"
      if selected of terminalTab then set activeFlag to "1"
      set rows to rows & (windowId as text) & (character id 9) & (tty of terminalTab) & (character id 9) & activeFlag & linefeed
    end repeat
  end repeat
  return rows
end tell`;

export function macosTerminalEmulator(
  exec: TerminalExec = defaultExec,
  enabled = () => featureEnabled(MACOS_TERMINAL_FLAG_ID),
): TerminalEmulator {
  const osa = (script: string) =>
    exec(FIXED_OS_EXECUTABLES.osascript, [], { input: script, timeoutMs: TIMEOUT_MS });

  return {
    id: "macos-terminal",
    label: "macOS Terminal",
    glyph: "▣",
    macBundleId: BUNDLE_ID,
    dispatchUnavailable: "Choose a multiplexer for dispatch, then select macOS Terminal under Opens in.",
    bin: {
      id: "macos-terminal",
      enabled,
      unsupportedReason: (platform) => platform === "darwin" ? null : "Terminal.app is available on macOS only.",
    },
    hostProcess: { commands: ["Terminal"] },
    names: PLAIN_NAMES,
    write: null,
    capture: null,
    retitle: null,
    restoreTarget: (paneId) => {
      const tty = terminalTty(paneId);
      return tty ? { paneId: tty, tabId: tty } : null;
    },
    list: async () => {
      if (!enabled()) return null;
      const result = await osa(listScript);
      return result.code === 0 && !result.outcomeUnknown && !result.overflowed ? parsePanes(result.stdout) : null;
    },
    focus: {
      granularity: "pane",
      raise: async ({ paneId }) => {
        const tty = terminalTty(paneId);
        if (!enabled() || !tty) return { ok: false, outcomeUnknown: false };
        const result = await osa(`
if not (${APP} is running) then error "Terminal is not running"
tell ${APP}
  repeat with terminalWindow in windows
    repeat with terminalTab in tabs of terminalWindow
      if tty of terminalTab is ${appleScriptString(`/dev/${tty}`)} then
        set selected of terminalTab to true
        set miniaturized of terminalWindow to false
        set frontmost of terminalWindow to true
        activate
        return
      end if
    end repeat
  end repeat
  error "That Terminal tab is no longer open"
end tell`);
        return toResult(result, "macOS Terminal could not focus that tab");
      },
    },
    spawn: {
      async tab({ cwd, argv, title }) {
        if (!enabled()) return { ok: false, outcomeUnknown: false, target: null };
        const command = `${cwd ? `cd -- ${shellCommand([cwd])} && ` : ""}exec ${shellCommand(argv)}`;
        const launch = shellCommand(["/bin/sh", "-c", command]);
        const result = await osa(`
tell ${APP}
  set newTab to do script (${appleScriptText(launch)})
  try
    set custom title of newTab to ${appleScriptString(title)}
    activate
  end try
  try
    return tty of newTab
  on error
    return ""
  end try
end tell`);
        if (result.code !== 0) {
          // osascript diagnostics may echo the command. Keep launch argv out of the error.
          const denied = result.stderr.includes("(-1743)");
          return {
            ok: false,
            outcomeUnknown: result.outcomeUnknown || result.overflowed || result.stderr.includes("(-1712)"),
            target: null,
            error: denied
              ? "Allow Mission Control to control Terminal in macOS Privacy & Security > Automation."
              : "macOS Terminal could not open a window",
          };
        }
        const tty = !result.overflowed && terminalTty(result.stdout);
        // The command was sent even if the new tab closed before Terminal could report its TTY.
        return { ok: true, outcomeUnknown: false, target: tty ? { paneId: tty, tabId: tty } : null };
      },
    },
  };
}
