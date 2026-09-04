import { normTty } from "../discovery/tty.ts";
import { normalizeItermSessionId } from "@shared/pane.ts";
import { ITERM_BIN } from "./bin.ts";
import { appleScriptString, appleScriptText } from "./applescript.ts";
import { defaultExec, toResult, type TerminalExec } from "./exec.ts";
import { PLAIN_NAMES } from "./names.ts";
import { shellCommand } from "./shell.ts";
import type {
  EmulatorPane,
  EmulatorTarget,
  Key,
  SpawnResult,
  TabSpec,
  TerminalEmulator,
  TerminalResult,
} from "./types.ts";

const BUNDLE_ID = "com.googlecode.iterm2";
const LIST_TIMEOUT_MS = 2500;
const ACTION_TIMEOUT_MS = 4000;
const CAPTURE_TIMEOUT_MS = 1000;
const US = "\x1f";
const RS = "\x1e";

const KEY_EXPRESSIONS: Record<Key, string> = {
  enter: "character id 13",
  escape: "character id 27",
  up: '(character id 27) & "[A"',
  down: '(character id 27) & "[B"',
  left: '(character id 27) & "[D"',
  right: '(character id 27) & "[C"',
  tab: "character id 9",
  "shift-up": '(character id 27) & "[1;2A"',
  "shift-down": '(character id 27) & "[1;2B"',
  "shift-tab": '(character id 27) & "[Z"',
};

function decodeField(value: string): string {
  return value.replaceAll("%1F", US).replaceAll("%1E", RS).replaceAll("%25", "%");
}

function cwdPath(value: string): string | null {
  const cwd = value.trim();
  if (!cwd) return null;
  try {
    const url = new URL(cwd);
    if (url.protocol === "file:") return decodeURIComponent(url.pathname);
  } catch {
    // A plain filesystem path is already the normalized representation.
  }
  return cwd;
}

/** Parse the escaped record stream emitted by one iTerm2 enumeration script. */
export function parseItermSessions(stdout: string): EmulatorPane[] {
  const panes: EmulatorPane[] = [];
  for (const rawRecord of stdout.split(RS)) {
    if (!rawRecord) continue;
    const fields = rawRecord.split(US);
    if (fields.length !== 8) continue;
    const [rawPaneId = "", tabId = "", windowId = "", tabTitle = "", windowTitle = "", tty = "", cwd = "", active = ""] = fields.map(decodeField);
    const paneId = normalizeItermSessionId(rawPaneId);
    if (!paneId || !tabId || !windowId || (active !== "0" && active !== "1")) continue;
    panes.push({
      paneId,
      tabId,
      windowId,
      tabTitle: tabTitle.trim(),
      windowTitle: windowTitle.trim(),
      isActive: active === "1",
      tty: normTty(tty),
      cwd: cwdPath(cwd),
    });
  }
  return panes;
}

const ENCODE_HANDLERS = `
on replaceText(needle, replacement, inputText)
  set previousDelimiters to AppleScript's text item delimiters
  set AppleScript's text item delimiters to needle
  set pieces to text items of inputText
  set AppleScript's text item delimiters to replacement
  set outputText to pieces as text
  set AppleScript's text item delimiters to previousDelimiters
  return outputText
end replaceText

on encodeField(inputValue)
  set outputText to inputValue as text
  set outputText to my replaceText("%", "%25", outputText)
  set outputText to my replaceText(character id 31, "%1F", outputText)
  set outputText to my replaceText(character id 30, "%1E", outputText)
  return outputText
end encodeField
`;

function listScript(): string {
  return `${ENCODE_HANDLERS}
set outputText to ""
tell application id "${BUNDLE_ID}"
  set activeWindowId to ""
  try
    set activeWindowId to id of current window as text
  end try
  repeat with terminalWindow in windows
    repeat with terminalTab in tabs of terminalWindow
      repeat with terminalSession in sessions of terminalTab
        set sessionCwd to ""
        try
          set sessionCwd to variable terminalSession named "path"
        end try
        set activeFlag to "0"
        try
          if ((id of terminalWindow as text) is activeWindowId and (index of terminalTab) is (index of current tab of terminalWindow) and (id of terminalSession as text) is (id of current session of terminalTab as text)) then set activeFlag to "1"
        end try
        set outputText to outputText & my encodeField(id of terminalSession) & "${US}" & my encodeField(index of terminalTab) & "${US}" & my encodeField(id of terminalWindow) & "${US}" & my encodeField(title of terminalTab) & "${US}" & my encodeField(name of terminalWindow) & "${US}" & my encodeField(tty of terminalSession) & "${US}" & my encodeField(sessionCwd) & "${US}" & activeFlag & "${RS}"
      end repeat
    end repeat
  end repeat
end tell
return outputText`;
}

function targetScript(target: EmulatorTarget, body: string): string {
  return `tell application id "${BUNDLE_ID}"
  set targetId to ${appleScriptString(target.paneId)}
  set targetSession to missing value
  set targetTab to missing value
  set targetWindow to missing value
  repeat with candidateWindow in windows
    repeat with candidateTab in tabs of candidateWindow
      repeat with candidateSession in sessions of candidateTab
        if (id of candidateSession as text) is targetId then
          set targetSession to candidateSession
          set targetTab to candidateTab
          set targetWindow to candidateWindow
          exit repeat
        end if
      end repeat
      if targetSession is not missing value then exit repeat
    end repeat
    if targetSession is not missing value then exit repeat
  end repeat
  if targetSession is missing value then error "iTerm2 session no longer exists" number -1728
${body}
end tell`;
}

function actionResult(result: Awaited<ReturnType<TerminalExec>>, fallback: string): TerminalResult {
  if (result.code !== 0 && /-1743|not authorized|automation/i.test(result.stderr)) {
    return {
      ok: false,
      outcomeUnknown: result.outcomeUnknown,
      error: "macOS denied Mission Control access to iTerm2. Re-enable Automation access in System Settings > Privacy & Security > Automation, then retry.",
    };
  }
  return toResult(result, fallback);
}

export function itermEmulator(exec: TerminalExec = defaultExec): TerminalEmulator {
  const osa = (script: string, timeoutMs: number) =>
    exec("/usr/bin/osascript", [], { input: script, timeoutMs });
  const command = async (script: string, fallback: string) =>
    actionResult(await osa(script, ACTION_TIMEOUT_MS), fallback);

  const writeExpressions = (target: EmulatorTarget, expressions: readonly string[], fallback: string) => {
    if (expressions.length === 0) return Promise.resolve({ ok: true, outcomeUnknown: false });
    return command(
      targetScript(target, expressions.map((expr) => `  write targetSession text (${expr}) newline no`).join("\n")),
      fallback,
    );
  };

  return {
    id: "iterm",
    label: "iTerm2",
    glyph: "▧",
    bin: ITERM_BIN,

    list: async () => {
      const result = await osa(listScript(), LIST_TIMEOUT_MS);
      return result.code === 0 ? parseItermSessions(result.stdout) : [];
    },

    hostProcess: { commands: ["iTerm2"] },

    write: {
      text: (target, text) => {
        const parts = text.replaceAll("\r\n", "\n").split("\n");
        const expressions: string[] = [];
        parts.forEach((part, index) => {
          if (index > 0) expressions.push(KEY_EXPRESSIONS.enter);
          if (part) expressions.push(appleScriptText(part));
        });
        return writeExpressions(target, expressions, "iTerm2 could not write to that session");
      },
      keys: (target, keys) =>
        writeExpressions(target, keys.map((key) => KEY_EXPRESSIONS[key]), "iTerm2 could not send keys to that session"),
      paste: (target, text) =>
        writeExpressions(
          target,
          [`(character id 27) & "[200~" & ${appleScriptText(text)} & (character id 27) & "[201~"`],
          "iTerm2 could not paste into that session",
        ),
    },

    capture: async (target) => {
      const result = await osa(targetScript(target, "  return contents of targetSession"), CAPTURE_TIMEOUT_MS);
      return result.code === 0 ? result.stdout : null;
    },

    focus: {
      granularity: "pane",
      raise: (target) =>
        command(
          targetScript(target, "  select targetWindow\n  select targetTab\n  select targetSession\n  activate"),
          "iTerm2 could not focus that session",
        ),
    },

    spawn: {
      async tab(spec: TabSpec): Promise<SpawnResult> {
        const argv = shellCommand(spec.argv);
        const launch = `${spec.cwd ? `cd -- ${shellCommand([spec.cwd])} && ` : ""}exec ${argv}`;
        const script = `tell application id "${BUNDLE_ID}"
  set newWindow to create window with default profile command ${appleScriptString(launch)}
  set newTab to current tab of newWindow
  if ${appleScriptString(spec.title)} is not "" then set title of newTab to ${appleScriptString(spec.title)}
  set newSession to current session of newTab
  return id of newSession & "${US}" & (index of newTab as text)
end tell`;
        const result = await osa(script, ACTION_TIMEOUT_MS);
        if (result.code !== 0) {
          return { ...actionResult(result, "iTerm2 could not open a window"), target: null };
        }
        const [paneIdRaw, tabId = ""] = result.stdout.trim().split(US);
        const paneId = normalizeItermSessionId(paneIdRaw);
        return {
          ok: true,
          outcomeUnknown: false,
          target: paneId ? { paneId, tabId } : null,
        };
      },
    },

    retitle: (target, title) =>
      command(targetScript(target, `  set title of targetTab to ${appleScriptString(title)}`), "iTerm2 could not rename that tab"),

    names: PLAIN_NAMES,
  };
}
