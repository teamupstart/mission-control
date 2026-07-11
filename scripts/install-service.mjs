#!/usr/bin/env node
// Install (or remove) the Fleet Control daemon as a macOS LaunchAgent so it starts
// at login and stays running. Opt-in: the user runs `npm run install-service`.

import { writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

if (platform() !== "darwin") {
  console.error("This installer targets macOS (launchd). On Linux, adapt it to a systemd user unit.");
  process.exit(1);
}

const LABEL = "com.fleet-control.daemon";
// Prior label(s) we may still need to unload/remove on an in-place upgrade so a
// stale daemon under the old label doesn't linger (or double-bind the port).
const LEGACY_LABELS = ["com.ai-harness.daemon"];
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;
const tsx = join(repo, "node_modules", "tsx", "dist", "cli.mjs");
const entry = join(repo, "src", "server", "index.ts");

// Same state-dir resolution as the daemon (config.ts): honor the legacy HARNESS_
// env + ~/.ai-harness dir so an upgraded install keeps its logs/db in place.
function resolveStateDir() {
  const override = process.env.FLEET_HOME ?? process.env.HARNESS_HOME;
  if (override) return override;
  const preferred = join(homedir(), ".fleet-control");
  const legacy = join(homedir(), ".ai-harness");
  if (!existsSync(preferred) && existsSync(legacy)) return legacy;
  return preferred;
}
const stateDir = resolveStateDir();
const logFile = join(stateDir, "daemon.log");
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
    <string>${tsx}</string>
    <string>${entry}</string>
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
mkdirSync(stateDir, { recursive: true });
writeFileSync(plistPath, plist);
tryLaunchctl("unload", plistPath);
execFileSync("launchctl", ["load", plistPath], { stdio: "inherit" });

console.log(`Installed and started LaunchAgent ${LABEL}`);
console.log(`  plist: ${plistPath}`);
console.log(`  logs:  ${logFile}`);
console.log(`\nThe dashboard is at http://127.0.0.1:${process.env.FLEET_PORT ?? process.env.HARNESS_PORT ?? 7317}`);
console.log(`Stop/remove with:  npm run install-service -- --uninstall`);
