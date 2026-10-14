import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  inspectAppLaunch, parseAppProcesses, parseLaunchServices, waitForBundleExit,
  prepareAppLaunch, verifyAppLaunch, launchConflictMessage,
  stopAttemptLaunch, jobLaunchesBundle, type MacAppOps,
} from "../scripts/mac-app-lifecycle.mjs";

const bundle = "/Users/test/Applications/Mission Control.app";
const binary = `${bundle}/Contents/MacOS/Mission Control`;
const registration = (pid = 42, type = "Foreground") => `1) "Mission Control" ASN:0x0-0x123:\n    bundleID="com.mission-control.app"\n    bundle path="${bundle}"\n    executable path="${binary}"\n    pid = ${pid} type="${type}"\n    checkin time = today\n`;
function fixture() {
  let now = 0;
  const calls: string[] = [];
  const outputs = new Map<string, string>([
    ["list", "PID\tStatus\tLabel\n"],
    ["apps", registration()],
    ["ps", `42 1 S ${binary}\n43 42 S ${bundle}/Contents/Frameworks/Helper.app/Contents/MacOS/Helper\n`],
  ]);
  const ops: MacAppOps = {
    uid: 501, now: () => now, sleep: async (ms) => { now += ms; },
    run: async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      const key = command.endsWith("lsappinfo") ? "apps" : command.endsWith("ps") ? "ps" : args[0] === "list" ? "list" : args.join(" ");
      return {code: 0, stdout: outputs.get(key) ?? ""};
    },
    identity: () => "start-42", kill: () => { throw new Error("must not kill"); },
    readAck: () => ({identity: "start-42", nonce: "a".repeat(32), pid: 42, bundle}),
  };
  return {ops, outputs, calls};
}

test("reads actual macOS process and LaunchServices field shapes including spaced paths", () => {
  assert.deepEqual(parseAppProcesses(`42 1 S ${binary}\n`), [{pid: 42, ppid: 1, state: "S", executable: binary}]);
  assert.equal(parseLaunchServices(registration())[0]?.bundle, bundle);
  assert.equal(parseLaunchServices(registration())[0]?.pid, 42);
});

test("preflight finds submitted shell respawners and gives an exact quoted bootout command", async () => {
  const f = fixture();
  f.outputs.set("list", "PID\tStatus\tLabel\n42\t0\tcom.mission-control.recovery-20260918\n");
  f.outputs.set("print gui/501/com.mission-control.recovery-20260918", `type = Submitted\nprogram = /bin/sh\narguments = {\n /bin/sh\n -c\n sleep 8; exec env MISSION_HOME=/private/state "${binary}" >>/tmp/log\n}\n`);
  const result = await inspectAppLaunch(bundle, f.ops);
  assert.deepEqual(result.jobs, ["com.mission-control.recovery-20260918"]);
  assert.match(launchConflictMessage(result, 501)!, /launchctl bootout 'gui\/501\/com.mission-control.recovery-20260918'/);
  assert.doesNotMatch(launchConflictMessage(result, 501)!, /MISSION_HOME|private\/state/);
  assert.ok(!f.calls.some((call) => call.includes("bootout")));
});

test("only a registered runningboard application job is exempt, not a lookalike label", async () => {
  const f = fixture();
  const label = "application.com.mission-control.app.1.2";
  f.outputs.set("list", `PID\tStatus\tLabel\n42\t0\t${label}\n`);
  f.outputs.set(`print gui/501/${label}`, `type = Submitted\nmanaged_by = com.apple.runningboard\npid = 42\nprogram = ${binary}\n`);
  assert.deepEqual((await inspectAppLaunch(bundle, f.ops)).jobs, []);
  f.outputs.set(`print gui/501/${label}`, `type = Submitted\npid = 42\nprogram = ${binary}\n`);
  assert.deepEqual((await inspectAppLaunch(bundle, f.ops)).jobs, [label]);
});

test("preflight finds a dormant job whose program or executable argument is a symlink into the bundle", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mission-launch-alias-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const app = join(root, "Mission Control.app");
  const executableDirectory = join(app, "Contents", "MacOS");
  await mkdir(executableDirectory, {recursive: true});
  await writeFile(join(executableDirectory, "Mission Control"), "fixture");
  const alias = join(root, "launch mission");
  await symlink("Mission Control.app/Contents/MacOS/Mission Control", alias);
  const f = fixture();
  const label = "com.fixture.dormant-respawner";
  f.outputs.set("apps", "");
  f.outputs.set("ps", "1 0 S /sbin/launchd\n");
  f.outputs.set("list", `PID\tStatus\tLabel\n-\t0\t${label}\n`);
  for (const instruction of [
    `program = ${alias}\n`,
    `program = "${alias}"\n`,
    `arguments = {\n ${alias}\n}\n`,
    `program = /usr/bin/env\narguments = {\n /usr/bin/env\n ${alias.replaceAll(" ", "\\ ")}\n}\n`,
  ]) {
    f.outputs.set(`print gui/501/${label}`, `type = Submitted\n${instruction}`);
    assert.deepEqual(await inspectAppLaunch(app, f.ops), {jobs: [label], unregistered: []}, instruction);
  }
  f.outputs.set(`print gui/501/${label}`, `program = /usr/bin/true\nenvironment = {\n OLD_APP => ${alias}\n}\n`);
  assert.deepEqual(await inspectAppLaunch(app, f.ops), {jobs: [], unregistered: []});
  assert.ok(!f.calls.some((call) => call.includes("bootout")));
});

test("unregistered main processes block but their Electron children are not mistaken for apps", async () => {
  const f = fixture();
  assert.deepEqual((await inspectAppLaunch(bundle, f.ops)).unregistered, []);
  f.outputs.set("apps", "");
  assert.deepEqual((await inspectAppLaunch(bundle, f.ops)).unregistered, [42]);
});

test("preflight finds dormant shell jobs that exec a symlinked app through quoted or escaped words", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mission-shell-alias-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const app = join(root, "Mission Control.app");
  const executableDirectory = join(app, "Contents", "MacOS");
  await mkdir(executableDirectory, {recursive: true});
  await writeFile(join(executableDirectory, "Mission Control"), "fixture");
  const alias = join(root, "launch mission");
  await symlink("Mission Control.app/Contents/MacOS/Mission Control", alias);
  const f = fixture();
  const label = "com.fixture.dormant-shell-respawner";
  f.outputs.set("apps", "");
  f.outputs.set("ps", "1 0 S /sbin/launchd\n");
  f.outputs.set("list", `PID\tStatus\tLabel\n-\t0\t${label}\n`);
  for (const shellCommand of [
    `exec "${alias}"`,
    `exec '${alias}'`,
    `exec ${alias.replaceAll(" ", "\\ ")}`,
    `sleep 8; exec env MISSION_HOME=/private/state "${alias}" >>/tmp/log`,
    `true && (exec '${root}/launch 'mission)`,
  ]) {
    await t.test(shellCommand, async () => {
      f.outputs.set(`print gui/501/${label}`, `program = /bin/sh\narguments = {\n /bin/sh\n -c\n ${shellCommand}\n}\n`);
      const conflicts = await inspectAppLaunch(app, f.ops);
      assert.deepEqual(conflicts, {jobs: [label], unregistered: []});
      assert.match(launchConflictMessage(conflicts, 501)!, /launchctl bootout 'gui\/501\/com.fixture.dormant-shell-respawner'/);
      assert.doesNotMatch(launchConflictMessage(conflicts, 501)!, /MISSION_HOME|private\/state/);
    });
  }
  assert.ok(!f.calls.some((call) => call.includes("bootout")));
});

test("quit barrier waits for all bundle executables, including orphan utilities", async () => {
  const f = fixture();
  f.outputs.set("ps", `43 1 S ${bundle}/Contents/Frameworks/Helper.app/Contents/MacOS/Helper\n`);
  await assert.rejects(waitForBundleExit(bundle, f.ops, 1000), /bundle processes.*43/);
  f.outputs.set("ps", "1 0 S /sbin/launchd\n");
  await waitForBundleExit(bundle, f.ops, 1000);
});

test("dormant shell jobs with expanded executables fail closed without disclosing their environment", async (t) => {
  const f = fixture();
  const label = "com.fixture.environment-launcher";
  f.outputs.set("apps", "");
  f.outputs.set("ps", "1 0 S /sbin/launchd\n");
  f.outputs.set("list", `PID\tStatus\tLabel\n-\t0\t${label}\n`);
  for (const [name, command] of [
    ["environment variable", 'exec "$MISSION_APP"'],
    ["braced variable", 'exec "${MISSION_APP}"'],
    ["direct expanded command", '"$MISSION_APP"'],
    ["environment wrapper", 'sleep 8; exec env MISSION_HOME=/private/state "$MISSION_APP"'],
    ["exec argument zero", 'exec -a "Mission Control" "$MISSION_APP"'],
    ["redirected executable", 'exec 2>/tmp/log "$MISSION_APP"'],
    ["unresolved variable", 'exec "$UNKNOWN_APP"'],
    ["command substitution", 'exec "$(printf %s "$MISSION_APP")"'],
  ]) {
    await t.test(name, async () => {
      f.outputs.set(`print gui/501/${label}`, `program = /bin/sh\narguments = {\n /bin/sh\n -c\n ${command}\n}\nenvironment = {\n MISSION_APP => ${binary}\n TOKEN => private-fixture-secret\n}\n`);
      const conflicts = await inspectAppLaunch(bundle, f.ops);
      assert.deepEqual(conflicts, {jobs: [label], unregistered: []});
      const message = launchConflictMessage(conflicts, 501)!;
      assert.match(message, /launchctl bootout 'gui\/501\/com.fixture.environment-launcher'/);
      assert.doesNotMatch(message, /MISSION_APP|UNKNOWN_APP|MISSION_HOME|TOKEN|private-fixture-secret|Contents\/MacOS|private\/state/);
      assert.ok(!f.calls.some((call) => call.includes("bootout")));
    });
  }
  for (const command of ['exec /usr/bin/true "$MISSION_APP"', 'exec /usr/bin/true 2>&1 "$MISSION_APP"', "exec '$MISSION_APP'", 'exec \\$MISSION_APP', 'exec -a "$DISPLAY_NAME" /usr/bin/true', '/usr/bin/true # exec "$MISSION_APP"']) {
    f.outputs.set(`print gui/501/${label}`, `program = /bin/sh\narguments = {\n /bin/sh\n -c\n ${command}\n}\nenvironment = {\n MISSION_APP => ${binary}\n}\n`);
    assert.deepEqual(await inspectAppLaunch(bundle, f.ops), {jobs: [], unregistered: []}, command);
  }
  f.outputs.set(`print gui/501/${label}`, `program = /usr/bin/node\narguments = {\n /usr/bin/node\n script.mjs\n $MISSION_APP\n}\nenvironment = {\n MISSION_APP => ${binary}\n}\n`);
  assert.deepEqual(await inspectAppLaunch(bundle, f.ops), {jobs: [], unregistered: []});
});

test("registers the replacement then waits for stale LaunchServices entries to disappear", async () => {
  const f = fixture();
  await assert.rejects(prepareAppLaunch(bundle, f.ops, 1000), /LaunchServices.*old instance/);
  assert.ok(f.calls[0]?.includes("lsregister -f"));
  f.outputs.set("apps", "");
  await prepareAppLaunch(bundle, f.ops, 1000);
});

test("preflight rejects a dormant nested shell launcher without exposing its environment", async (t) => {
  const f = fixture();
  const label = "com.fixture.nested-shell";
  f.outputs.set("apps", "");
  f.outputs.set("ps", "1 0 S /sbin/launchd\n");
  f.outputs.set("list", `PID\tStatus\tLabel\n-\t0\t${label}\n`);
  for (const command of ["sh -c 'exec \"$MISSION_APP\"'", "exec /bin/sh -c 'exec \"$MISSION_APP\"'", "env FLAG=1 /bin/zsh -c 'exec \"$MISSION_APP\"'"]) {
    await t.test(command, async () => {
      f.outputs.set(`print gui/501/${label}`, `program = /bin/sh\narguments = {\n /bin/sh\n -c\n ${command}\n}\nenvironment = {\n MISSION_APP => ${binary}\n TOKEN => private-fixture-secret\n}\n`);
      const conflicts = await inspectAppLaunch(bundle, f.ops);
      assert.deepEqual(conflicts, {jobs: [label], unregistered: []});
      const message = launchConflictMessage(conflicts, 501)!;
      assert.match(message, /launchctl bootout 'gui\/501\/com.fixture.nested-shell'/);
      assert.doesNotMatch(message, /MISSION_APP|TOKEN|private-fixture-secret|Contents\/MacOS/);
    });
  }
});

test("preflight rejects dormant shell eval without exposing its environment", async (t) => {
  const f = fixture();
  const label = "com.fixture.eval-launcher";
  f.outputs.set("apps", "");
  f.outputs.set("ps", "1 0 S /sbin/launchd\n");
  f.outputs.set("list", `PID\tStatus\tLabel\n-\t0\t${label}\n`);
  for (const command of [
    "eval 'exec \"$MISSION_APP\"'",
    "command eval 'exec \"$MISSION_APP\"'",
    "builtin eval 'exec \"$MISSION_APP\"'",
  ]) {
    await t.test(command, async () => {
      f.outputs.set(`print gui/501/${label}`, `program = /bin/sh\narguments = {\n /bin/sh\n -c\n ${command}\n}\nenvironment = {\n MISSION_APP => ${binary}\n TOKEN => private-fixture-secret\n}\n`);
      const conflicts = await inspectAppLaunch(bundle, f.ops);
      assert.deepEqual(conflicts, {jobs: [label], unregistered: []});
      const message = launchConflictMessage(conflicts, 501)!;
      assert.match(message, /launchctl bootout 'gui\/501\/com.fixture.eval-launcher'/);
      assert.doesNotMatch(message, /MISSION_APP|TOKEN|private-fixture-secret|Contents\/MacOS/);
      assert.ok(!f.calls.some((call) => call.includes("bootout")));
    });
  }
});

test("preflight finds dormant nice jobs that execute the bundle", async (t) => {
  const f = fixture();
  const label = "com.fixture.nice-launcher";
  f.outputs.set("apps", "");
  f.outputs.set("ps", "1 0 S /sbin/launchd\n");
  f.outputs.set("list", `PID\tStatus\tLabel\n-\t0\t${label}\n`);
  for (const [name, program, argv] of [
    ["default priority", "/usr/bin/nice", ["/usr/bin/nice", binary]],
    ["explicit priority", "/usr/bin/nice", ["/usr/bin/nice", "-n", "5", binary]],
    ["negative priority", "/usr/bin/nice", ["/usr/bin/nice", "-n", "-5", binary]],
    ["attached priority", "/usr/bin/nice", ["/usr/bin/nice", "-n5", binary]],
    ["traditional priority", "/usr/bin/nice", ["/usr/bin/nice", "-5", binary]],
    ["option terminator", "/usr/bin/nice", ["/usr/bin/nice", "--", binary]],
    ["nested wrapper", "/usr/bin/nice", ["/usr/bin/nice", "-n", "5", "/usr/bin/env", "FLAG=1", binary]],
    ["shell command", "/bin/sh", ["/bin/sh", "-c", `exec /usr/bin/nice -n 5 "${binary}"`]],
  ] as const) {
    await t.test(name, async () => {
      f.outputs.set(`print gui/501/${label}`, `program = ${program}\narguments = {\n ${argv.join("\n ")}\n}\n`);
      const conflicts = await inspectAppLaunch(bundle, f.ops);
      assert.deepEqual(conflicts, {jobs: [label], unregistered: []});
      const message = launchConflictMessage(conflicts, 501)!;
      assert.match(message, /launchctl bootout 'gui\/501\/com.fixture.nice-launcher'/);
      assert.doesNotMatch(message, /FLAG|Contents\/MacOS/);
      assert.ok(!f.calls.some((call) => call.includes("bootout")));
    });
  }
});

test("preflight finds dormant open jobs that launch the bundle through LaunchServices", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mission-open-launcher-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const app = join(root, "Mission Control.app");
  const alias = join(root, "app alias");
  await mkdir(app);
  await symlink(app, alias);
  const f = fixture();
  const label = "com.fixture.open-launcher";
  f.outputs.set("apps", "");
  f.outputs.set("ps", "1 0 S /sbin/launchd\n");
  f.outputs.set("list", `PID\tStatus\tLabel\n-\t0\t${label}\n`);
  for (const [name, program, argv] of [
    ["bundle target", "/usr/bin/open", ["/usr/bin/open", app]],
    ["hidden background launch", "/usr/bin/open", ["/usr/bin/open", "-g", "-j", app]],
    ["new instance with arguments", "/usr/bin/open", ["/usr/bin/open", "-n", app, "--args", "--fixture"]],
    ["application path", "/usr/bin/open", ["/usr/bin/open", "-a", app]],
    ["application name", "/usr/bin/open", ["/usr/bin/open", "-a", "Mission Control"]],
    ["bundle identifier", "/usr/bin/open", ["/usr/bin/open", "-b", "com.mission-control.app"]],
    ["combined options", "/usr/bin/open", ["/usr/bin/open", "-gja", app]],
    ["option terminator", "/usr/bin/open", ["/usr/bin/open", "--", app]],
    ["bundle symlink", "/usr/bin/open", ["/usr/bin/open", alias]],
    ["file URL", "/usr/bin/open", ["/usr/bin/open", pathToFileURL(app).href]],
    ["shell command", "/bin/sh", ["/bin/sh", "-c", `exec open "${app}"`]],
    ["expanded shell target", "/bin/sh", ["/bin/sh", "-c", 'open "$MISSION_APP"']],
    ["redirected shell command", "/bin/sh", ["/bin/sh", "-c", `open 2>/tmp/fixture-log "${app}"`]],
    ["wrapped open", "/usr/bin/nice", ["/usr/bin/nice", "-n", "5", "/usr/bin/open", app]],
  ] as const) {
    await t.test(name, async () => {
      f.outputs.set(`print gui/501/${label}`, `program = ${program}\narguments = {\n ${argv.join("\n ")}\n}\nenvironment = {\n MISSION_APP => ${app}\n TOKEN => private-fixture-secret\n}\n`);
      const conflicts = await inspectAppLaunch(app, f.ops);
      assert.deepEqual(conflicts, {jobs: [label], unregistered: []});
      const message = launchConflictMessage(conflicts, 501)!;
      assert.match(message, /launchctl bootout 'gui\/501\/com.fixture.open-launcher'/);
      assert.doesNotMatch(message, /MISSION_APP|TOKEN|private-fixture-secret/);
      assert.ok(!f.calls.some((call) => call.includes("bootout")));
    });
  }
});

test("preflight allows a fixed executable whose arguments only contain app paths as data", async (t) => {
  const f = fixture();
  const label = "com.fixture.literal-data";
  f.outputs.set("apps", "");
  f.outputs.set("ps", "1 0 S /sbin/launchd\n");
  f.outputs.set("list", `PID\tStatus\tLabel\n-\t0\t${label}\n`);
  for (const [name, program, argv] of [
    ["direct data", "/usr/bin/true", ["/usr/bin/true", binary]],
    ["argv zero is data when Program is specified", "/usr/bin/true", [binary]],
    ["shell names are data", "/usr/bin/true", ["/usr/bin/true", "/bin/sh", "-c", `exec "${binary}"`]],
    ["wrapper arguments", "/usr/bin/env", ["/usr/bin/env", "FLAG=1", "/usr/bin/true", binary]],
    ["shell data", "/bin/sh", ["/bin/sh", "-c", `/usr/bin/true "${binary}"`]],
    ["shell positional argument", "/bin/sh", ["/bin/sh", "-c", "/usr/bin/true", binary]],
    ["eval is data", "/usr/bin/true", ["/usr/bin/true", "eval", `exec "${binary}"`]],
    ["eval is shell data", "/bin/sh", ["/bin/sh", "-c", "/usr/bin/true eval 'exec \"$MISSION_APP\"'"]],
    ["eval is a display name", "/bin/sh", ["/bin/sh", "-c", "exec -a eval /usr/bin/true"]],
    ["eval is a comment", "/bin/sh", ["/bin/sh", "-c", "/usr/bin/true # eval 'exec \"$MISSION_APP\"'"]],
    ["nice is data", "/usr/bin/true", ["/usr/bin/true", "/usr/bin/nice", binary]],
    ["nice utility receives data", "/usr/bin/nice", ["/usr/bin/nice", "-n", "5", "/usr/bin/true", binary]],
    ["open is data", "/usr/bin/true", ["/usr/bin/true", "/usr/bin/open", bundle]],
    ["open another app", "/usr/bin/open", ["/usr/bin/open", "/Applications/Other.app"]],
    ["reveal in Finder", "/usr/bin/open", ["/usr/bin/open", "-R", bundle]],
    ["selected app receives data", "/usr/bin/open", ["/usr/bin/open", "-a", "/Applications/Other.app", bundle]],
    ["selected identifier receives data", "/usr/bin/open", ["/usr/bin/open", "-b", "com.fixture.other", bundle]],
    ["app arguments are data", "/usr/bin/open", ["/usr/bin/open", "-a", "/Applications/Other.app", "--args", bundle, "-b", "com.mission-control.app"]],
    ["open environment and I/O paths are data", "/usr/bin/open", ["/usr/bin/open", "--env", `MISSION_APP=${bundle}`, "--stdout", bundle, "--stderr", bundle, "--stdin", bundle, "/Applications/Other.app"]],
    ["open with editor", "/usr/bin/open", ["/usr/bin/open", "-e", bundle]],
    ["later shell data", "/bin/sh", ["/bin/sh", "-c", `open /Applications/Other.app; /usr/bin/true "${bundle}"`]],
    ["shell redirect is data", "/bin/sh", ["/bin/sh", "-c", `open /Applications/Other.app 2>"${bundle}"`]],
  ] as const) {
    await t.test(name, async () => {
      f.outputs.set(`print gui/501/${label}`, `program = ${program}\narguments = {\n ${argv.join("\n ")}\n}\n`);
      const conflicts = await inspectAppLaunch(bundle, f.ops);
      assert.deepEqual(conflicts, {jobs: [], unregistered: []});
      assert.equal(launchConflictMessage(conflicts, 501), null);
    });
  }
});

test("launch proof needs matching bundle, Foreground registration, running pid and renderer acknowledgment", async () => {
  const f = fixture();
  const nonce = "a".repeat(32);
  await verifyAppLaunch(bundle, nonce, f.ops, 1000);
  for (const apps of ["", registration(99), registration(42, "BackgroundOnly"), registration().replace(bundle, "/other.app")]) {
    f.outputs.set("apps", apps);
    await assert.rejects(verifyAppLaunch(bundle, nonce, f.ops, 1000), /LaunchServices.*verified/);
  }
  f.outputs.set("apps", registration());
  f.outputs.set("ps", `42 1 T ${binary}\n`);
  await assert.rejects(verifyAppLaunch(bundle, nonce, f.ops, 1000), /verified/);
  f.outputs.set("ps", `42 1 S ${binary}\n`);
  f.ops.readAck = () => null;
  await assert.rejects(verifyAppLaunch(bundle, nonce, f.ops, 1000), /verified/);
});

test("unreadable host inventory fails closed without echoing command output", async () => {
  const f = fixture();
  f.ops.run = async () => ({code: 1, stdout: "secret"});
  await assert.rejects(inspectAppLaunch(bundle, f.ops), /Could not inspect/);
});

test("launch proof rejects stale or mismatched acknowledgment fields", async (t) => {
  const nonce = "a".repeat(32);
  const ack = {nonce, bundle, pid: 42, identity: "start-42"};
  for (const changed of [{nonce: "b".repeat(32)}, {bundle: "/other.app"}, {pid: 99}, {identity: "previous-start-42"}, {identity: ""}]) {
    await t.test(JSON.stringify(changed), async () => {
      const f = fixture();
      f.ops.readAck = () => ({...ack, ...changed});
      await assert.rejects(verifyAppLaunch(bundle, nonce, f.ops, 1000), /LaunchServices launch could not be verified/);
      f.ops.readAck = () => ack;
      await verifyAppLaunch(bundle, nonce, f.ops, 1000);
    });
  }
});


test("job argument matching accepts shell-escaped bundle paths but ignores mere environment mentions", () => {
  assert.equal(jobLaunchesBundle(`program = /bin/sh\narguments = {\n /bin/sh\n -c\n exec ${binary.replaceAll(" ", "\\ ")}\n}\n`, bundle), true);
  assert.equal(jobLaunchesBundle(`program = /usr/bin/node\nenvironment = {\n OLD_APP => ${binary}\n}\n`, bundle), false);
});

test("retry cleanup refuses an unowned main process and rechecks identity before signalling", async () => {
  const f = fixture();
  const nonce = "a".repeat(32);
  const originalRun = f.ops.run;
  f.ops.run = async (command, args, timeout) => args.includes("args=")
    ? {code: 0, stdout: `${binary} --unrelated`} : originalRun(command, args, timeout);
  await assert.rejects(stopAttemptLaunch(bundle, nonce, f.ops), /outside this update attempt/);
  f.ops.run = async (command, args, timeout) => args.includes("args=")
    ? {code: 0, stdout: `${binary} --mission-update-launch ${nonce}`} : originalRun(command, args, timeout);
  const signals: string[] = [];
  f.ops.kill = (pid, signal) => {
    signals.push(`${pid}:${signal}`);
    f.outputs.set("ps", "1 0 S /sbin/launchd\n");
  };
  await stopAttemptLaunch(bundle, nonce, f.ops);
  assert.deepEqual(signals, ["42:SIGTERM"]);
  f.outputs.set("ps", `42 1 S ${binary}\n`);
  let reads = 0;
  f.ops.identity = () => {
    if (++reads === 1) return "original";
    f.outputs.set("ps", "1 0 S /sbin/launchd\n");
    return "reused";
  };
  await stopAttemptLaunch(bundle, nonce, f.ops);
  assert.deepEqual(signals, ["42:SIGTERM"]);
});

test("retry cleanup escalates after its bounded TERM wait only for the same process identity", async (t) => {
  for (const reused of [false, true]) {
    await t.test(reused ? "PID reused after SIGTERM" : "owned process ignores SIGTERM", async () => {
      const f = fixture();
      const nonce = "a".repeat(32);
      f.outputs.set("ps", `42 1 S ${binary}\n`);
      const run = f.ops.run;
      f.ops.run = async (command, args, timeout) => args.includes("args=")
        ? {code: 0, stdout: `${binary} --mission-update-launch ${nonce}`} : run(command, args, timeout);
      const signals: Array<{pid: number; signal: string; at: number}> = [];
      const identityChecks: number[] = [];
      f.ops.identity = () => {
        identityChecks.push(f.ops.now());
        return reused && f.ops.now() >= 5000 ? "new-process" : "start-42";
      };
      f.ops.kill = (pid, signal) => {
        signals.push({pid, signal, at: f.ops.now()});
        if (signal === "SIGKILL") {
          assert.equal(identityChecks.at(-1), f.ops.now(), "recheck identity at escalation");
          f.outputs.set("ps", "1 0 S /sbin/launchd\n");
        }
      };
      if (reused) {
        await assert.rejects(stopAttemptLaunch(bundle, nonce, f.ops), /bundle processes did not exit: 42/);
        assert.deepEqual(signals, [{pid: 42, signal: "SIGTERM", at: 0}]);
        assert.equal(f.ops.now(), 10_000);
      } else {
        await stopAttemptLaunch(bundle, nonce, f.ops);
        assert.deepEqual(signals, [{pid: 42, signal: "SIGTERM", at: 0}, {pid: 42, signal: "SIGKILL", at: 5000}]);
      }
      assert.equal(identityChecks.at(-1), 5000);
    });
  }
});
