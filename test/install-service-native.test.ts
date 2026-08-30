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
import { setTimeout as delay } from "node:timers/promises";
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

test("a fresh LaunchAgent enters through the native-build daemon entry", () => {
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

test("the LaunchAgent entry builds first and runs the daemon at its exact PID", async () => {
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
    join(scripts, "build-native.mjs"),
    `import { appendFileSync } from "node:fs";\n` +
      `appendFileSync(process.env.SERVICE_EVENT_LOG, JSON.stringify({ stage: "build", pid: process.pid }) + "\\n");\n`,
  );
  writeFileSync(
    join(tsxDir, "package.json"),
    JSON.stringify({
      name: "tsx",
      type: "module",
      exports: { "./esm/api": "./index.mjs" },
    }),
  );
  writeFileSync(join(tsxDir, "index.mjs"), "export const register = () => {};\n");
  writeFileSync(
    server,
    `import { appendFileSync } from "node:fs";\n` +
      `const record = (event) => appendFileSync(process.env.SERVICE_EVENT_LOG, JSON.stringify(event) + "\\n");\n` +
      `record({ stage: "daemon", pid: process.pid, args: process.argv.slice(1) });\n` +
      `process.on("SIGTERM", () => { record({ stage: "signal", pid: process.pid, signal: "SIGTERM" }); process.exit(0); });\n` +
      `setInterval(() => {}, 1_000);\n`,
  );

  try {
    const child = spawn(process.execPath, [copiedEntry], {
      cwd: root,
      env: { ...process.env, SERVICE_EVENT_LOG: eventsPath },
      stdio: "pipe",
    });
    const servicePid = child.pid;
    assert.ok(servicePid, "the service entry must start");
    const exitPromise = once(child, "exit");

    // The full suite runs six process-heavy files at once. Give the child enough time to be
    // scheduled under that documented contention; the assertion still waits only for one
    // local append and fails immediately once the deadline is reached.
    const deadline = Date.now() + 10_000;
    let recorded = "";
    while (!recorded.includes('"stage":"daemon"') && Date.now() < deadline) {
      await delay(20);
      recorded = existsSync(eventsPath) ? readFileSync(eventsPath, "utf8") : "";
    }
    assert.match(recorded, /"stage":"daemon"/, "the daemon must record its start");
    child.kill("SIGTERM");

    const [code, signal] = (await exitPromise) as [number | null, NodeJS.Signals | null];
    assert.equal(signal, null);
    assert.equal(code, 0);

    const events = readFileSync(eventsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) =>
        JSON.parse(line) as { stage: string; pid: number; args?: string[]; signal?: string },
      );
    assert.deepEqual(events.map((event) => event.stage), ["build", "daemon", "signal"]);
    assert.notEqual(events[0]!.pid, servicePid, "the bounded build runs as a child");
    assert.equal(events[1]!.pid, servicePid, "the daemon keeps launchd's exact service PID");
    assert.notEqual(events[1]!.pid, events[0]!.pid, "the build exits before the daemon starts");
    assert.deepEqual(events[1]!.args, [realpathSync(server)]);
    assert.deepEqual(events[2], {
      stage: "signal",
      pid: events[1]!.pid,
      signal: "SIGTERM",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function assertBuildStopSignal(testedSignal: NodeJS.Signals): Promise<void> {
  const root = mkdtempSync(
    join(tmpdir(), `mission-start-service-build-${testedSignal.toLowerCase()}-`),
  );
  const scripts = join(root, "scripts");
  const tsxDir = join(root, "node_modules", "tsx");
  const serverDir = join(root, "src", "server");
  const copiedEntry = join(scripts, "start-service.mjs");
  const eventsPath = join(root, "events.jsonl");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(tsxDir, { recursive: true });
  mkdirSync(serverDir, { recursive: true });
  copyFileSync(serviceEntry, copiedEntry);
  writeFileSync(
    join(scripts, "build-native.mjs"),
    `import { appendFileSync } from "node:fs";\n` +
      `const record = (event) => appendFileSync(process.env.SERVICE_EVENT_LOG, JSON.stringify(event) + "\\n");\n` +
      `const signal = process.env.SERVICE_TEST_SIGNAL;\n` +
      `process.on(signal, () => { record({ stage: "build-signal", pid: process.pid, signal }); process.exit(0); });\n` +
      `record({ stage: "build-start", pid: process.pid });\n` +
      `setInterval(() => {}, 1_000);\n`,
  );
  writeFileSync(
    join(tsxDir, "package.json"),
    JSON.stringify({
      name: "tsx",
      type: "module",
      exports: { "./esm/api": "./index.mjs" },
    }),
  );
  writeFileSync(join(tsxDir, "index.mjs"), "export const register = () => {};\n");
  writeFileSync(
    join(serverDir, "index.ts"),
    `import { appendFileSync } from "node:fs";\n` +
      `appendFileSync(process.env.SERVICE_EVENT_LOG, JSON.stringify({ stage: "daemon", pid: process.pid }) + "\\n");\n`,
  );

  try {
    const child = spawn(process.execPath, [copiedEntry], {
      cwd: root,
      env: {
        ...process.env,
        SERVICE_EVENT_LOG: eventsPath,
        SERVICE_TEST_SIGNAL: testedSignal,
      },
      stdio: "pipe",
    });
    const servicePid = child.pid;
    assert.ok(servicePid, "the service entry must start");
    const exitPromise = once(child, "exit");

    // Native build startup competes with other process-heavy files in the full suite. Keep
    // polling because this assertion is about signal forwarding after the build starts, not
    // scheduler latency before the fixture child gets its first turn.
    const deadline = Date.now() + 10_000;
    let recorded = "";
    while (!recorded.includes('"stage":"build-start"') && Date.now() < deadline) {
      await delay(20);
      recorded = existsSync(eventsPath) ? readFileSync(eventsPath, "utf8") : "";
    }
    assert.match(recorded, /"stage":"build-start"/, "the native build must start");
    child.kill(testedSignal);

    const [code, signal] = (await exitPromise) as [number | null, NodeJS.Signals | null];
    assert.equal(signal, null);
    assert.equal(code, 0);

    const events = readFileSync(eventsPath, "utf8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as { stage: string; pid: number; signal?: NodeJS.Signals },
      );
    assert.deepEqual(events.map((event) => event.stage), ["build-start", "build-signal"]);
    assert.notEqual(events[0]!.pid, servicePid, "the bounded build runs as a child");
    assert.equal(events[1]!.signal, testedSignal);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the LaunchAgent entry stops cleanly on every supported signal during the build", async (t) => {
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"] as const) {
    await t.test(signal, () => assertBuildStopSignal(signal));
  }
});
