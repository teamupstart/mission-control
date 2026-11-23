import assert from "node:assert/strict";
import test from "node:test";

import {
  emulatorForBundle,
  shellHandlerBundle,
  systemDefaultEmulator,
} from "../src/server/terminal/system-default.ts";
import { initialTerminalTarget } from "../src/web/lib/terminalTargets.ts";
import type { TerminalTargetView } from "../src/shared/terminal.ts";
import type { RunResult } from "../src/server/util/exec.ts";

const EMULATORS = {
  wezterm: { macBundleId: "com.github.wez.wezterm" },
  ghostty: { macBundleId: "com.mitchellh.ghostty" },
  iterm: { macBundleId: "com.googlecode.iterm2" },
};

// What iTerm2's "Make iTerm2 Default Term" leaves in LaunchServices, beside unrelated rows.
const ITERM_DEFAULT = JSON.stringify([
  { LSHandlerURLScheme: "https", LSHandlerRoleAll: "com.google.chrome" },
  { LSHandlerContentType: "public.unix-executable", LSHandlerRoleShell: "com.googlecode.iterm2" },
]);

function ran(stdout: string, code = 0): RunResult {
  return { stdout, stderr: "", code, childPid: null, outcomeUnknown: false, overflowed: false };
}

test("the shell handler for public.unix-executable names the default terminal", () => {
  assert.equal(shellHandlerBundle(ITERM_DEFAULT), "com.googlecode.iterm2");
  assert.equal(shellHandlerBundle(JSON.stringify([{ LSHandlerURLScheme: "https", LSHandlerRoleAll: "x" }])), null);
  // A handler written for every role, with no shell-specific role, still names the terminal.
  const allRoles = JSON.stringify([{ LSHandlerContentType: "public.unix-executable", LSHandlerRoleAll: "com.googlecode.iterm2" }]);
  assert.equal(shellHandlerBundle(allRoles), "com.googlecode.iterm2");
  assert.equal(emulatorForBundle(EMULATORS, shellHandlerBundle(allRoles)), "iterm");
  assert.equal(shellHandlerBundle("not json"), null);
  assert.equal(shellHandlerBundle(JSON.stringify({ LSHandlers: [] })), null);
});

test("only a bundle a registered emulator declares maps to a backend", () => {
  assert.equal(emulatorForBundle(EMULATORS, "com.googlecode.iterm2"), "iterm");
  assert.equal(emulatorForBundle(EMULATORS, "COM.MITCHELLH.GHOSTTY"), "ghostty");
  // Terminal.app, which Mission Control cannot drive, is no preference at all.
  assert.equal(emulatorForBundle(EMULATORS, "com.apple.Terminal"), null);
  assert.equal(emulatorForBundle(EMULATORS, null), null);
});

test("the default terminal is read from LaunchServices on macOS only, and every miss is null", async () => {
  const calls: string[][] = [];
  const read = (platform: NodeJS.Platform, result: RunResult) => systemDefaultEmulator({
    platform,
    home: "/Users/operator",
    emulators: EMULATORS,
    run: async (bin, args) => { calls.push([bin, ...args]); return result; },
  });

  assert.equal(await read("darwin", ran(ITERM_DEFAULT)), "iterm");
  assert.deepEqual(calls[0], [
    "plutil", "-extract", "LSHandlers", "json", "-o", "-",
    "/Users/operator/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist",
  ]);
  // No LSHandlers key on an untouched machine: plutil exits non-zero.
  assert.equal(await read("darwin", ran("", 1)), null);
  calls.length = 0;
  assert.equal(await read("linux", ran(ITERM_DEFAULT)), null);
  assert.equal(calls.length, 0, "no subprocess off macOS");
});

function view(id: TerminalTargetView["id"], extra: Partial<TerminalTargetView> = {}): TerminalTargetView {
  return { id, label: id, glyph: "*", blurb: "", detail: null, unavailable: null, ...extra };
}

test("a picker starts on the system default terminal when it can open a window", () => {
  const targets = [view("tmux"), view("wezterm"), view("iterm", { systemDefault: true })];
  assert.equal(initialTerminalTarget(targets)?.id, "iterm");
  // An unusable default does not win over a usable first row.
  const unusable = [view("tmux"), view("iterm", { systemDefault: true, unavailable: "iTerm2 is not installed" })];
  assert.equal(initialTerminalTarget(unusable)?.id, "tmux");
  assert.equal(initialTerminalTarget([view("tmux"), view("wezterm")])?.id, "tmux");
  assert.equal(initialTerminalTarget(null), null);
});
