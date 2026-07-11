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

const LABEL = "com.ai-harness.daemon";
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;
const tsx = join(repo, "node_modules", "tsx", "dist", "cli.mjs");
const entry = join(repo, "src", "server", "index.ts");
const stateDir = process.env.HARNESS_HOME ?? join(homedir(), ".ai-harness");
const logFile = join(stateDir, "daemon.log");
const plistPath = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
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

if (uninstall) {
  tryLaunchctl("unload", plistPath);
  if (existsSync(plistPath)) rmSync(plistPath);
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
console.log(`\nThe dashboard is at http://127.0.0.1:${process.env.HARNESS_PORT ?? 7317}`);
console.log(`Stop/remove with:  npm run install-service -- --uninstall`);
