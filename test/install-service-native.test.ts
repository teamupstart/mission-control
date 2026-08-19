import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installer = join(repo, "scripts", "install-service.mjs");
const serviceEntry = join(repo, "scripts", "start-service.mjs");

function plistProgramArguments(plist: string): string[] {
  const block = plist.match(
    /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/,
  )?.[1];
  assert.ok(block, "the generated plist must contain ProgramArguments");
  return [...block.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => match[1]!);
}

test("a fresh LaunchAgent builds the native addon before replacing itself with the daemon", () => {
  const root = mkdtempSync(join(tmpdir(), "mission-install-service-native-"));
  const home = join(root, "home");
  const state = join(root, "state");
  const fakeBin = join(root, "bin");
  const launchctlLog = join(root, "launchctl.log");
  mkdirSync(home, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(
    join(fakeBin, "launchctl"),
    "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$FAKE_LAUNCHCTL_LOG\"\n",
    { mode: 0o755 },
  );

  try {
    // Force the macOS branch so this contract remains testable on Linux CI. The child has an
    // isolated HOME, state directory, and launchctl, so it cannot touch an operator's service.
    const importInstaller = [
      'Object.defineProperty(process, "platform", { value: "darwin", configurable: true });',
      `await import(${JSON.stringify(pathToFileURL(installer).href)});`,
    ].join("\n");
    execFileSync(process.execPath, ["--input-type=module", "-e", importInstaller], {
      cwd: repo,
      env: {
        ...process.env,
        HOME: home,
        MISSION_HOME: state,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        FAKE_LAUNCHCTL_LOG: launchctlLog,
      },
      stdio: "pipe",
    });

    const plistPath = join(
      home,
      "Library",
      "LaunchAgents",
      "com.mission-control.daemon.plist",
    );
    const plist = readFileSync(plistPath, "utf8");
    assert.deepEqual(
      plistProgramArguments(plist),
      [process.execPath, serviceEntry],
      "launchd must enter through the checked-in native-build service entry",
    );
    assert.ok(existsSync(serviceEntry), "the LaunchAgent service entry must be checked in");

  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the LaunchAgent entry builds first and exec-replaces itself with the source daemon", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-start-service-native-"));
  const scripts = join(root, "scripts");
  const tsxDir = join(root, "node_modules", "tsx");
  const serverDir = join(root, "src", "server");
  const copiedEntry = join(scripts, "start-service.mjs");
  const eventsPath = join(root, "events.jsonl");
  const server = join(serverDir, "index.ts");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(tsxDir, { recursive: true });
  mkdirSync(serverDir, { recursive: true });
  copyFileSync(serviceEntry, copiedEntry);
  writeFileSync(
    join(scripts, "build-keep-awake-native.mjs"),
    `import { appendFileSync } from "node:fs";\n` +
      `appendFileSync(process.env.SERVICE_EVENT_LOG, JSON.stringify({ stage: "build", pid: process.pid }) + "\\n");\n`,
  );
  writeFileSync(
    join(tsxDir, "package.json"),
    JSON.stringify({ name: "tsx", type: "module", exports: "./index.mjs" }),
  );
  writeFileSync(join(tsxDir, "index.mjs"), "// fake tsx import hook\n");
  writeFileSync(
    server,
    `import { appendFileSync } from "node:fs";\n` +
      `appendFileSync(process.env.SERVICE_EVENT_LOG, JSON.stringify({ stage: "daemon", pid: process.pid, args: process.argv.slice(1) }) + "\\n");\n`,
  );

  try {
    const child = spawn(process.execPath, [copiedEntry], {
      cwd: root,
      env: { ...process.env, SERVICE_EVENT_LOG: eventsPath },
      stdio: "pipe",
    });
    const servicePid = child.pid;
    assert.ok(servicePid, "the service entry must start");
    const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
    assert.equal(signal, null);
    assert.equal(code, 0);

    const events = readFileSync(eventsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { stage: string; pid: number; args?: string[] });
    assert.deepEqual(events.map((event) => event.stage), ["build", "daemon"]);
    assert.notEqual(events[0]!.pid, servicePid, "the bounded build runs as a child");
    assert.equal(events[1]!.pid, servicePid, "execve preserves launchd's exact service PID");
    assert.deepEqual(events[1]!.args, [realpathSync(server)]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
