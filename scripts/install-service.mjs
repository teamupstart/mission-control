#!/usr/bin/env node
// Install (or remove) the Mission Control daemon as a macOS LaunchAgent so it starts
// at login and stays running. Opt-in: the user runs `npm run install-service`.

import { writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { BASE_URL, stateDir } from "../src/shared/harness-runtime.mjs";

if (platform() !== "darwin") {
  console.error("This installer targets macOS (launchd). On Linux, adapt it to a systemd user unit.");
  process.exit(1);
}

const LABEL = "com.mission-control.daemon";
// Prior label(s) we may still need to unload/remove on an in-place upgrade so a
// stale daemon under the old label doesn't linger (or double-bind the port).
// Every name this app has gone by, oldest included: an install from any of them is
// still out there running, and a leftover would double-bind the port.
const LEGACY_LABELS = ["com.fleet-control.daemon", "com.ai-harness.daemon"];
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;
const serviceEntry = join(repo, "scripts", "start-service.mjs");
const state = stateDir();
const logFile = join(state, "daemon.log");
const plistFor = (label) => join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
const plistPath = plistFor(LABEL);
const uninstall = process.argv.includes("--uninstall");

// launchd starts with a minimal PATH; include node's dir + common tool dirs so
// the daemon can shell out to ps / tmux / git / wezterm.
const pathEnv = [dirname(node), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":");

function tryLaunchctl(...args) {
  try {
    execFileSync("launchctl", args, { stdio: "ignore" });
  } catch {
    /* ignore - unload of a not-loaded job errors harmlessly */
  }
}

/** Unload + delete a label's plist, if present. */
function removeLabel(label) {
  const p = plistFor(label);
  tryLaunchctl("unload", p);
  if (existsSync(p)) rmSync(p);
}

// Always clear any prior-label install first, so an upgrade never leaves a
// second daemon running (both would fight over the port).
for (const legacy of LEGACY_LABELS) removeLabel(legacy);

if (uninstall) {
  removeLabel(LABEL);
  console.log(`Removed LaunchAgent ${LABEL}`);
  process.exit(0);
}

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${serviceEntry}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${repo}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${pathEnv}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logFile}</string>
  <key>StandardErrorPath</key>
  <string>${logFile}</string>
</dict>
</plist>
`;

mkdirSync(dirname(plistPath), { recursive: true });
mkdirSync(state, { recursive: true });
writeFileSync(plistPath, plist);
tryLaunchctl("unload", plistPath);
execFileSync("launchctl", ["load", plistPath], { stdio: "inherit" });

console.log(`Installed and started LaunchAgent ${LABEL}`);
console.log(`  plist: ${plistPath}`);
console.log(`  logs:  ${logFile}`);
console.log(`\nThe dashboard is at ${BASE_URL}`);
console.log(`Stop/remove with:  npm run install-service -- --uninstall`);
// The desktop app (`make app`) has its own "Start at login" and adopts a running
// daemon rather than double-binding the port, so the two coexist safely - but pick
// one to avoid two "start at login" mechanisms. This LaunchAgent is best for a
// headless daemon (no app window).
console.log(`\nNote: if you also run the Mission Control desktop app, it will ADOPT this`);
console.log(`daemon (no double-bind). Use one "start at login" mechanism to avoid confusion.`);
