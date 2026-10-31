import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  inspectAppLaunch, parseAppProcesses, parseLaunchServices, waitForBundleExit,
  prepareAppLaunch, verifyAppLaunch, launchConflictMessage,
  stopAttemptLaunch, jobLaunchesBundle, realMacAppOps, assertSafeAppLaunch,
  inspectAppLaunches, assertSafeAppLaunches,
  COMMAND_TIMEOUT_MS, LAUNCH_TIMEOUT_MS, LAUNCH_INSPECTION_TIMEOUT_MS, type MacAppOps,
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

test("preflight finds dormant shell respawners after options that consume operands", async (t) => {
  const f = fixture();
  const label = "com.fixture.shell-options";
  f.outputs.set("apps", "");
  f.outputs.set("ps", "1 0 S /sbin/launchd\n");
  f.outputs.set("list", `PID\tStatus\tLabel\n-\t0\t${label}\n`);
  for (const options of [["-o", "posix"], ["+o", "posix"], ["-eo", "posix"], ["-O", "extglob"], ["--rcfile", "/tmp/fixture-rc"]]) {
    await t.test(options.join(" "), async () => {
      const job = (source: string) => `program = /bin/sh\narguments = {\n /bin/sh\n ${[...options, "-c", source].join("\n ")}\n}\n`;
      f.outputs.set(`print gui/501/${label}`, job(`exec "${binary}"`));
      assert.deepEqual((await inspectAppLaunch(bundle, f.ops)).jobs, [label]);
      f.outputs.set(`print gui/501/${label}`, job(`printf '%s' "${binary}"`));
      assert.deepEqual((await inspectAppLaunch(bundle, f.ops)).jobs, []);
    });
  }
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

test("a slow probe gets the rest of its caller's deadline, not a fixed two-second slice", async () => {
  // The regression: every probe was capped at 2s, and a probe that runs out of time rejects
  // rather than retrying, so one slow `ps` or `launchctl print` on a busy Mac failed an update
  // (and then its recovery) long before the caller's own deadline.
  const f = fixture();
  f.outputs.set("list", "PID\tStatus\tLabel\n-\t0\tcom.example.one\n");
  const budgets = new Map<string, number[]>();
  const run = f.ops.run;
  f.ops.run = async (command, args, timeout) => {
    const name = command.split("/").at(-1) ?? command;
    budgets.set(name, [...(budgets.get(name) ?? []), timeout ?? -1]);
    return run(command, args, timeout);
  };
  await inspectAppLaunch(bundle, f.ops, 15_000);
  // The fake clock does not advance during a probe, so each one is offered the whole budget.
  assert.deepEqual(budgets.get("lsappinfo"), [15_000]);
  assert.deepEqual(budgets.get("ps"), [15_000]);
  assert.deepEqual(budgets.get("launchctl"), [15_000, 15_000], "list, then print for the one label");

  budgets.clear();
  f.outputs.set("ps", "1 0 S /sbin/launchd\n");
  await waitForBundleExit(bundle, f.ops, 120_000);
  assert.deepEqual(budgets.get("ps"), [120_000]);

  // Still bounded: an exhausted deadline refuses before running a probe at all.
  budgets.clear();
  await assert.rejects(inspectAppLaunch(bundle, f.ops, 0), /before the time limit/);
  assert.equal(budgets.size, 0);
});

test("the launch-conflict preflight takes its caller's deadline, not a fixed inspection cap", async () => {
  // The same regression one level out: capping each PROBE at the caller's remaining deadline
  // fixed nothing while the sweep itself was pinned to a fixed default, because
  // `assertSafeAppLaunch` took no timeout at all.
  const f = fixture();
  f.outputs.set("list", "PID\tStatus\tLabel\n-\t0\tcom.example.one\n");
  const budgets: number[] = [];
  const run = f.ops.run;
  f.ops.run = async (command, args, timeout) => {
    budgets.push(timeout ?? -1);
    return run(command, args, timeout);
  };
  await assertSafeAppLaunch(bundle, f.ops, 120_000);
  assert.deepEqual(budgets, [120_000, 120_000, 120_000, 120_000],
    "lsappinfo, ps, launchctl list and launchctl print each get the caller's deadline");

  // A caller with no deadline of its own still gets a bound, and it is the named one.
  budgets.length = 0;
  await assertSafeAppLaunch(bundle, f.ops);
  assert.deepEqual(new Set(budgets), new Set([LAUNCH_INSPECTION_TIMEOUT_MS]));
  assert.ok(LAUNCH_INSPECTION_TIMEOUT_MS > 15_000,
    "the no-deadline fallback must clear the loaded-machine cost that made 15s a coin flip");

  // And it is still a refusal, never a pass, when the deadline really is gone.
  await assert.rejects(assertSafeAppLaunch(bundle, f.ops, 0), /before the time limit/);
});

test("one launchd sweep answers for several bundles, exactly as one sweep per bundle would", async () => {
  // The sweep is machine-wide and only its last step depends on the bundle, so one sweep must
  // answer for several bundles exactly as a sweep per bundle would - and cost one sweep.
  const other = "/Users/test/Applications/Other.app";
  const f = fixture();
  const respawner = "com.example.respawner";
  f.outputs.set("list", `PID\tStatus\tLabel\n-\t0\t${respawner}\n-\t0\tcom.example.quiet\n`);
  f.outputs.set(`print gui/501/${respawner}`, `type = Submitted\nprogram = ${binary}\n`);
  f.outputs.set("print gui/501/com.example.quiet", "type = Submitted\nprogram = /bin/true\n");

  const separately = [await inspectAppLaunch(bundle, f.ops), await inspectAppLaunch(other, f.ops)];
  f.calls.length = 0;
  const together = await inspectAppLaunches([bundle, other], f.ops);

  assert.deepEqual(together, separately, "the same answer for every bundle as a sweep of its own");
  assert.deepEqual(together[0]?.jobs, [respawner], "the respawn job is still found for its bundle");
  assert.deepEqual(together[1]?.jobs, [], "and is not misattributed to the other bundle");
  assert.equal(f.calls.filter((call) => call === "/bin/launchctl list").length, 1, "ONE sweep");
  assert.equal(f.calls.filter((call) => call.startsWith("/bin/launchctl print")).length, 2,
    "one print per label, not one per label per bundle");
});

test("several bundles refuse on the first conflict in order, from one sweep", async () => {
  const other = "/Users/test/Applications/Other.app";
  const otherBinary = `${other}/Contents/MacOS/Other`;
  // A DIFFERENT respawn job for each bundle, so the refusal names which bundle it came from. With
  // only one bundle conflicting this test could not tell "first conflict in order" from "last".
  const conflicting = () => {
    const f = fixture();
    f.outputs.set("list", "PID\tStatus\tLabel\n-\t0\tcom.example.respawn-main\n-\t0\tcom.example.respawn-other\n");
    f.outputs.set("print gui/501/com.example.respawn-main", `type = Submitted\nprogram = ${binary}\n`);
    f.outputs.set("print gui/501/com.example.respawn-other", `type = Submitted\nprogram = ${otherBinary}\n`);
    return f;
  };
  for (const [order, reported, withheld] of [
    [[bundle, other], /com\.example\.respawn-main/, /com\.example\.respawn-other/],
    [[other, bundle], /com\.example\.respawn-other/, /com\.example\.respawn-main/],
  ] as const) {
    const f = conflicting();
    await assert.rejects(assertSafeAppLaunches([...order], f.ops), (error: unknown) => {
      const message = (error as Error).message;
      assert.match(message, reported, `the first bundle's conflict is the one reported: ${order.join(" then ")}`);
      assert.doesNotMatch(message, withheld, "and the later bundle's is not folded into it");
      return true;
    });
    assert.equal(f.calls.filter((call) => call === "/bin/launchctl list").length, 1, "one sweep for both");
  }

  // A clean first bundle does not mask a later one's conflict.
  const later = fixture();
  later.outputs.set("list", "PID\tStatus\tLabel\n-\t0\tcom.example.respawn-main\n");
  later.outputs.set("print gui/501/com.example.respawn-main", `type = Submitted\nprogram = ${binary}\n`);
  await assert.rejects(assertSafeAppLaunches([other, bundle], later.ops), /com\.example\.respawn-main/);
  // And a launch with no conflict for any bundle proceeds.
  await assertSafeAppLaunches([other, bundle], fixture().ops);
});

test("an unregistered process is attributed to its own bundle in a combined inspection", async () => {
  // The other conflict kind. `unregistered` is computed per bundle from the same `ps` and
  // LaunchServices reads, so a combined sweep could drop or misattribute it while every
  // launchd-job assertion above still passed.
  const other = "/Users/test/Applications/Other.app";
  const f = fixture();
  // `bundle`'s pid 42 stays a registered Foreground app; `other` gains a running main process
  // that LaunchServices knows nothing about.
  f.outputs.set("ps", `42 1 S ${binary}\n43 42 S ${bundle}/Contents/Frameworks/Helper.app/Contents/MacOS/Helper\n77 1 S ${other}/Contents/MacOS/Other\n`);

  const separately = [await inspectAppLaunch(bundle, f.ops), await inspectAppLaunch(other, f.ops)];
  const together = await inspectAppLaunches([bundle, other], f.ops);
  assert.deepEqual(together, separately, "the same answer as a sweep per bundle");
  assert.deepEqual(together[0], {jobs: [], unregistered: []}, "the registered bundle stays clean");
  assert.deepEqual(together[1], {jobs: [], unregistered: [77]}, "the unregistered process is the other bundle's");

  // And it is a refusal from the combined check, in either order, naming that process.
  for (const order of [[bundle, other], [other, bundle]]) {
    await assert.rejects(assertSafeAppLaunches(order, f.ops), /Mission Control process 77 is not registered/);
  }
});

test("a timed-out probe names which macOS command ran out, and never its arguments", async () => {
  // update.log carried one sentence for six different probes, so a loaded-machine failure could
  // not be attributed. The executable is safe to name; its arguments carry a launchd job label
  // and a bundle path, which this module never prints.
  await assert.rejects(realMacAppOps().run("/bin/sh", ["-c", "sleep 5; echo /Users/secret.app"], 200), (error: unknown) => {
    assert.match((error as Error).message, /within the time limit \(sh\)\./);
    assert.doesNotMatch((error as Error).message, /secret|-c|sleep/);
    return true;
  });
});

test("a real command with no caller deadline is not killed at the old two-second default", async () => {
  // A command slower than the old 2s cap, run through the real ops. Before, this rejected with
  // "within the time limit"; a loaded Mac's `ps` looked exactly like it.
  assert.ok(COMMAND_TIMEOUT_MS > 2_500);
  const result = await realMacAppOps().run("/bin/sh", ["-c", "sleep 2.5; echo done"]);
  assert.deepEqual(result, {code: 0, stdout: "done\n"});
  // Still a bound: a caller's own budget is honored and a hung command is refused.
  await assert.rejects(realMacAppOps().run("/bin/sh", ["-c", "sleep 5"], 200), /within the time limit/);
});

test("lsregister gets the whole launch budget, not the former five-second cap", async () => {
  // Modeled on the real ops: a command slower than the budget it was handed is killed and
  // rejects; otherwise it answers. Only lsregister is slow here.
  for (const [duration, outcome] of [[7_000, "answers"], [LAUNCH_TIMEOUT_MS + 1, "rejects"]] as const) {
    const f = fixture();
    f.outputs.set("apps", "");
    const budgets: number[] = [];
    const run = f.ops.run;
    f.ops.run = async (command, args, timeout) => {
      if (!command.endsWith("/lsregister")) return run(command, args, timeout);
      budgets.push(timeout ?? -1);
      if (duration > (timeout ?? 0)) throw new Error("Could not inspect macOS launch state within the time limit.");
      return run(command, args, timeout);
    };
    const launched = prepareAppLaunch(bundle, f.ops);
    if (outcome === "answers") await launched;
    else await assert.rejects(launched, /within the time limit/);
    assert.deepEqual(budgets, [LAUNCH_TIMEOUT_MS], `a ${duration}ms lsregister ${outcome}`);
  }
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

test("preflight refuses ambiguous multiline shell source from a dormant job", async (t) => {
  const f = fixture();
  const label = "com.fixture.multiline-shell";
  f.outputs.set("apps", "");
  f.outputs.set("ps", "1 0 S /sbin/launchd\n");
  f.outputs.set("list", `PID\tStatus\tLabel\n-\t0\t${label}\n`);
  for (const [name, source] of [
    ["later executable", `/usr/bin/true\nexec "${binary}"`],
    ["later expanded executable", '/usr/bin/true\nexec "$MISSION_APP"'],
    ["comment before executable", `# fixture comment\nexec "${binary}"`],
    ["indented continuation", `/usr/bin/true\n  exec "${binary}"`],
    ["ambiguous positional argument", `/usr/bin/true\n${binary}`],
  ]) {
    await t.test(name, async () => {
      f.outputs.set(`print gui/501/${label}`, `program = /bin/sh\narguments = {\n sh\n -c\n ${source}\n}\nenvironment = {\n MISSION_APP => ${binary}\n}\n`);
      const conflicts = await inspectAppLaunch(bundle, f.ops);
      assert.deepEqual(conflicts, {jobs: [label], unregistered: []});
      const message = launchConflictMessage(conflicts, 501)!;
      assert.match(message, /launchctl bootout 'gui\/501\/com.fixture.multiline-shell'/);
      assert.doesNotMatch(message, /MISSION_APP|Contents\/MacOS/);
    });
  }
});

test("preflight refuses dormant command substitutions even outside executable positions", async (t) => {
  const f = fixture();
  const label = "com.fixture.command-substitution";
  f.outputs.set("apps", "");
  f.outputs.set("ps", "1 0 S /sbin/launchd\n");
  f.outputs.set("list", `PID\tStatus\tLabel\n-\t0\t${label}\n`);
  const substitution = `$("${binary}")`;
  const backticks = '`"$MISSION_APP"`';
  for (const [name, command] of [
    ["quoted argument", `printf %s "${substitution}"`],
    ["unquoted argument", `printf %s ${substitution}`],
    ["assignment", `OUTPUT="${substitution}" /usr/bin/true`],
    ["assignment only", `OUTPUT="${backticks}"`],
    ["backtick argument", `printf %s "${backticks}"`],
    ["unquoted backticks", `printf %s ${backticks}`],
    ["redirect target", `/usr/bin/true >"${substitution}"`],
    ["wrapper option operand", `env -u "${substitution}" /usr/bin/true`],
    ["open app data", `open /Applications/Other.app --args "${substitution}"`],
  ]) {
    await t.test(name, async () => {
      f.outputs.set(`print gui/501/${label}`, `program = /bin/sh\narguments = {\n sh\n -c\n ${command}\n}\nenvironment = {\n MISSION_APP => ${binary}\n TOKEN => private-fixture-secret\n}\n`);
      const conflicts = await inspectAppLaunch(bundle, f.ops);
      assert.deepEqual(conflicts, {jobs: [label], unregistered: []});
      const message = launchConflictMessage(conflicts, 501)!;
      assert.match(message, /launchctl bootout 'gui\/501\/com.fixture.command-substitution'/);
      assert.doesNotMatch(message, /MISSION_APP|TOKEN|private-fixture-secret|Contents\/MacOS/);
    });
  }
  for (const command of [
    `printf %s '${substitution}' '${backticks}'`,
    'printf %s "\\$(literal)" "\\`literal\\`"',
    `printf %s "$MISSION_APP" # ${substitution}`,
  ]) {
    f.outputs.set(`print gui/501/${label}`, `program = /bin/sh\narguments = {\n sh\n -c\n ${command}\n}\n`);
    assert.deepEqual(await inspectAppLaunch(bundle, f.ops), {jobs: [], unregistered: []}, "literal text and variable data do not execute commands");
  }
  f.outputs.set(`print gui/501/${label}`, `program = /usr/bin/true\narguments = {\n true\n ${substitution}\n ${backticks}\n}\n`);
  assert.deepEqual(await inspectAppLaunch(bundle, f.ops), {jobs: [], unregistered: []}, "launchd argv is not shell source");
});

test("preflight refuses dormant jobs that source shell scripts", async (t) => {
  const f = fixture();
  const label = "com.fixture.sourced-launcher";
  f.outputs.set("apps", "");
  f.outputs.set("ps", "1 0 S /sbin/launchd\n");
  f.outputs.set("list", `PID\tStatus\tLabel\n-\t0\t${label}\n`);
  for (const builtin of [".", "source", "command .", "builtin source"]) {
    await t.test(builtin, async () => {
      f.outputs.set(`print gui/501/${label}`, `program = /bin/sh\narguments = {\n sh\n -c\n ${builtin} '/private/fixture-launcher.sh'\n}\n`);
      const conflicts = await inspectAppLaunch(bundle, f.ops);
      assert.deepEqual(conflicts, {jobs: [label], unregistered: []});
      const message = launchConflictMessage(conflicts, 501)!;
      assert.match(message, /launchctl bootout 'gui\/501\/com.fixture.sourced-launcher'/);
      assert.doesNotMatch(message, /private|fixture-launcher/);
    });
  }
  f.outputs.set(`print gui/501/${label}`, `program = /bin/sh\narguments = {\n sh\n -c\n /usr/bin/true source . '/private/fixture-launcher.sh'\n}\n`);
  assert.deepEqual(await inspectAppLaunch(bundle, f.ops), {jobs: [], unregistered: []});
});

test("preflight refuses dormant shells with opaque script or stdin sources", async (t) => {
  const f = fixture();
  const label = "com.fixture.shell-script-launcher";
  f.outputs.set("apps", "");
  f.outputs.set("ps", "1 0 S /sbin/launchd\n");
  f.outputs.set("list", `PID\tStatus\tLabel\n-\t0\t${label}\n`);
  for (const [name, argv] of [
    ["script operand", ["sh", "/private/fixture-respawner.sh"]],
    ["script after flags", ["sh", "-e", "/private/fixture-respawner.sh"]],
    ["script after terminator", ["sh", "--", "/private/fixture-respawner.sh"]],
    ["explicit stdin source", ["sh", "-s"]],
    ["implicit stdin source", ["sh"]],
  ] as const) {
    await t.test(name, async () => {
      f.outputs.set(`print gui/501/${label}`, `program = /bin/sh\narguments = {\n ${argv.join("\n ")}\n}\n`);
      const conflicts = await inspectAppLaunch(bundle, f.ops);
      assert.deepEqual(conflicts, {jobs: [label], unregistered: []});
      const message = launchConflictMessage(conflicts, 501)!;
      assert.match(message, /launchctl bootout 'gui\/501\/com.fixture.shell-script-launcher'/);
      assert.doesNotMatch(message, /private|fixture-respawner/);
    });
  }
  f.outputs.set(`print gui/501/${label}`, `program = /bin/sh\narguments = {\n sh\n -c\n /usr/bin/true\n /private/fixture-respawner.sh\n}\n`);
  assert.deepEqual(await inspectAppLaunch(bundle, f.ops), {jobs: [label], unregistered: []}, "printed positional arguments cannot be distinguished from multiline source");
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

test("preflight refuses dormant env split-string launchers without exposing their source", async (t) => {
  const f = fixture();
  const label = "com.fixture.env-split-launcher";
  f.outputs.set("apps", "");
  f.outputs.set("ps", "1 0 S /sbin/launchd\n");
  f.outputs.set("list", `PID\tStatus\tLabel\n-\t0\t${label}\n`);
  for (const argv of [
    ["env", "-S", `"${binary}" --private-fixture-secret`],
    ["env", `-S"${binary}" --private-fixture-secret`],
    ["env", "-iS", `"${binary}"`],
    ["env", "-i", "-S", '"${MISSION_APP}"'],
    ["env", "--split-string", `"${binary}"`],
    ["env", `--split-string="${binary}"`],
  ]) {
    await t.test(argv[1]!, async () => {
      f.outputs.set(`print gui/501/${label}`, `program = /usr/bin/env\narguments = {\n ${argv.join("\n ")}\n}\n`);
      const conflicts = await inspectAppLaunch(bundle, f.ops);
      assert.deepEqual(conflicts, {jobs: [label], unregistered: []});
      const message = launchConflictMessage(conflicts, 501)!;
      assert.match(message, /launchctl bootout 'gui\/501\/com.fixture.env-split-launcher'/);
      assert.doesNotMatch(message, /MISSION_APP|private-fixture-secret|Contents\/MacOS/);
    });
  }
  f.outputs.set(`print gui/501/${label}`, `program = /usr/bin/env\narguments = {\n env\n -uMISSION_APP\n /usr/bin/true\n -S\n "${binary}"\n}\n`);
  assert.deepEqual(await inspectAppLaunch(bundle, f.ops), {jobs: [], unregistered: []}, "split flags passed as data to a fixed utility are not executable source");
});

test("preflight finds dormant arch jobs that execute the bundle", async (t) => {
  const f = fixture();
  const label = "com.fixture.arch-launcher";
  f.outputs.set("apps", "");
  f.outputs.set("ps", "1 0 S /sbin/launchd\n");
  f.outputs.set("list", `PID\tStatus\tLabel\n-\t0\t${label}\n`);
  for (const [name, program, argv] of [
    ["architecture flag", "/usr/bin/arch", ["arch", "-arm64", binary]],
    ["architecture operand", "/usr/bin/arch", ["arch", "-arch", "arm64", binary]],
    ["environment options", "/usr/bin/arch", ["arch", "-c", "-d", "MISSION_HOME", "-e", "FLAG=private-fixture-secret", "-arm64", binary]],
    ["wrapped utility", "/usr/bin/arch", ["arch", "-arm64", "/usr/bin/nice", "-n", "5", binary]],
    ["shell command", "/bin/sh", ["sh", "-c", `exec /usr/bin/arch -arm64 "${binary}"`]],
  ] as const) {
    await t.test(name, async () => {
      f.outputs.set(`print gui/501/${label}`, `program = ${program}\narguments = {\n ${argv.join("\n ")}\n}\n`);
      const conflicts = await inspectAppLaunch(bundle, f.ops);
      assert.deepEqual(conflicts, {jobs: [label], unregistered: []});
      const message = launchConflictMessage(conflicts, 501)!;
      assert.match(message, /launchctl bootout 'gui\/501\/com.fixture.arch-launcher'/);
      assert.doesNotMatch(message, /MISSION_HOME|FLAG|private-fixture-secret|Contents\/MacOS/);
      assert.ok(!f.calls.some((call) => call.includes("bootout")));
    });
  }
  for (const argv of [
    ["arch", "-arm64", "/usr/bin/true", binary],
    ["arch", "-e", `MISSION_APP=${binary}`, "-arm64", "/usr/bin/true"],
  ]) {
    f.outputs.set(`print gui/501/${label}`, `program = /usr/bin/arch\narguments = {\n ${argv.join("\n ")}\n}\n`);
    assert.deepEqual(await inspectAppLaunch(bundle, f.ops), {jobs: [], unregistered: []}, "data operands do not execute the app");
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

test("launch verification times out for stuck and exited process states despite valid registration and acknowledgment", async (t) => {
  for (const state of ["U", "Z", "X", "U+"]) {
    await t.test(`process state ${state}`, async () => {
      const f = fixture();
      const nonce = "a".repeat(32);
      f.outputs.set("ps", `42 1 ${state} ${binary}\n`);
      await assert.rejects(verifyAppLaunch(bundle, nonce, f.ops, 1000), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(`LaunchServices launch could not be verified (registered=true; process=${state}; renderer=true)`));
        return true;
      });
      assert.equal(f.ops.now(), 1000, "unhealthy process must remain unverified through the bounded wait");
      f.outputs.set("ps", `42 1 S ${binary}\n`);
      await verifyAppLaunch(bundle, nonce, f.ops, 1000);
      assert.equal(f.ops.now(), 1000, "the same launch proof succeeds immediately when the process is healthy");
    });
  }
});

test("unreadable host inventory fails closed without echoing command output", async () => {
  const f = fixture();
  f.ops.run = async () => ({code: 1, stdout: "secret"});
  await assert.rejects(inspectAppLaunch(bundle, f.ops), /Could not inspect/);
});

test("preflight skips a vanished GUI job but refuses other launchctl print failures", async (t) => {
  for (const code of [113, 1]) {
    await t.test(`launchctl print exit ${code}`, async () => {
      const f = fixture();
      f.outputs.set("list", "PID\tStatus\tLabel\n-\t0\tcom.fixture.unreadable\n");
      const run = f.ops.run;
      f.ops.run = async (command, args, timeout) => {
        const result = await run(command, args, timeout);
        return args[0] === "print" ? {code, stdout: "private-fixture-secret"} : result;
      };
      if (code === 113) assert.deepEqual(await inspectAppLaunch(bundle, f.ops), {jobs: [], unregistered: []});
      else await assert.rejects(inspectAppLaunch(bundle, f.ops), {
        message: "Could not inspect a GUI launchd job. Check launchctl before retrying.",
      });
      assert.deepEqual(f.calls, [
        "/usr/bin/lsappinfo list", "/bin/ps -axww -o pid=,ppid=,stat=,comm=",
        "/bin/launchctl list", "/bin/launchctl print gui/501/com.fixture.unreadable",
      ]);
    });
  }
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

test("launch proof accepts an acknowledgment of the same bundle through a symlink", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mission-launch-ack-alias-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const app = join(root, "Mission Control.app");
  const alias = join(root, "Alias.app");
  await mkdir(join(app, "Contents", "MacOS"), {recursive: true});
  await writeFile(join(app, "Contents", "MacOS", "Mission Control"), "fixture");
  await symlink(app, alias);
  const f = fixture();
  f.outputs.set("apps", registration().replaceAll(bundle, app));
  f.outputs.set("ps", `42 1 S ${app}/Contents/MacOS/Mission Control\n`);
  f.ops.readAck = () => ({nonce: "a".repeat(32), bundle: alias, pid: 42, identity: "start-42"});
  await verifyAppLaunch(app, "a".repeat(32), f.ops, 1000);
  f.ops.readAck = () => ({nonce: "a".repeat(32), bundle: `${root}/Other.app`, pid: 42, identity: "start-42"});
  await assert.rejects(verifyAppLaunch(app, "a".repeat(32), f.ops, 1000), /could not be verified/);
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
