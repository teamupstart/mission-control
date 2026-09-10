import assert from "node:assert/strict";
import test from "node:test";
import { CANONICAL_REPO } from "../src/shared/install-receipt-schema.mjs";
import type { InstallReceipt } from "../src/shared/install-receipt-schema.mjs";
import type { UpdateApplyOutcome } from "../src/shared/update.ts";
import {
  detachedUpdateHelperEnvironment,
  detachedUpdateHelperSources,
  latestStableRelease,
  sanitizeLogLine,
  sanitizeReleaseNotes,
  surfacesFromBackgroundCheck,
  UpdateController,
  UPDATE_GH_ARGS,
  type HelperHandoff,
  type ReleaseInfo,
  type UpdaterPort,
  type UpdateStageRequest,
} from "../src/main/updater.ts";
import type { UpdatePrepareStage } from "../src/shared/update.ts";

const STAGED_BUNDLE = "/tmp/mission-source/release/mac-arm64/Mission Control.app";

/**
 * Let the controller's own promise chain settle.
 *
 * An accepted update is now several awaits deep - build, then the restart question, then the
 * handoff - where it used to be one, so a single `setImmediate` no longer reaches the end of
 * it.
 */
async function flush(turns = 8): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const receipt: InstallReceipt = {
  schema: 1,
  repo: CANONICAL_REPO,
  releaseTag: "v1.2.3",
  installedVersion: "1.2.3",
  sourceClone: "/tmp/mission-source",
  appPath: "/Applications/Mission Control.app",
  installedAt: "2026-08-19T12:00:00.000Z",
};

const release = (over: Partial<ReleaseInfo> = {}): ReleaseInfo => ({
  tagName: "v1.2.4",
  name: "Mission Control 1.2.4",
  publishedAt: "2026-08-19T13:00:00.000Z",
  isDraft: false,
  isPrerelease: false,
  body: "## Fixed\n\n- Safer updates",
  ...over,
});

test("the detached updater carries its narrowly scoped bundle-swap support module", () => {
  assert.deepEqual(
    detachedUpdateHelperSources(
      "/Applications/Mission Control.app/Contents/Resources/scripts/apply-update.mjs",
    ),
    [
      "/Applications/Mission Control.app/Contents/Resources/scripts/apply-update.mjs",
      "/Applications/Mission Control.app/Contents/Resources/scripts/app-bundle-swap.mjs",
    ],
  );
});

test("the detached updater carries the login-shell PATH into the installer", () => {
  assert.deepEqual(
    detachedUpdateHelperEnvironment(
      { PATH: "/usr/bin:/bin", MISSION_HOME: "/state" },
      "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    ),
    {
      PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
      MISSION_HOME: "/state",
    },
  );
});

function fixture(over: Partial<UpdaterPort> = {}) {
  const events: string[] = [];
  const handoffs: HelperHandoff[] = [];
  const stageRequests: UpdateStageRequest[] = [];
  let outcome: UpdateApplyOutcome | null = null;
  // One source of truth for what is on disk, because in the real thing there is one: the
  // install script reads the bundle's identity when it verifies it and reports that with the
  // marker, so a fake whose marker and whose stat disagree is modelling a race, not a bundle.
  // The tests that want that race override both deliberately.
  const identity: UpdaterPort["stagedBundleIdentity"] =
    over.stagedBundleIdentity ?? (() => ({ version: "1.2.4", revision: "staged-1" }));
  const port: UpdaterPort = {
    packaged: true,
    arch: "arm64",
    currentVersion: () => "1.2.3",
    readReceipt: () => receipt,
    latestRelease: async () => release(),
    runtime: async () => ({ ok: true, node: "/opt/homebrew/bin/node", env: { PATH: "/opt/homebrew/bin:/usr/bin:/bin" } }),
    helperSource: () => "/Applications/Mission Control.app/Contents/Resources/scripts/apply-update.mjs",
    stateDirectory: () => "/tmp/mission-state",
    handoff: async (args) => {
      handoffs.push(args);
      events.push("handoff");
    },
    stage: async (request) => {
      stageRequests.push(request);
      // The stages a real build reports, thinned to the ones that change the reading: the
      // first, the long one, and the last before the bundle exists.
      for (const stage of ["prerequisites", "dependencies", "build"] as UpdatePrepareStage[]) {
        request.onStage(stage);
      }
      // The revision comes from the marker the install script printed when it verified the
      // bundle, which is what the controller must pin - not whatever it reads afterwards. Here
      // that is whatever this fixture's disk currently says, which is the consistent case.
      return {
        ok: true,
        staged: {
          version: "1.2.4",
          bundlePath: STAGED_BUNDLE,
          // The script reads this while it still holds the bundle it just built, so it
          // reports an identity even when THIS app cannot stat the path afterwards - that
          // split is the situation `install()` and the ready-time check exist for. A test
          // that wants an install script too old to report one overrides `stage` itself.
          revision: (() => {
            try {
              return identity(STAGED_BUNDLE).revision ?? "staged-1";
            } catch {
              return "staged-1";
            }
          })(),
        },
      };
    },
    // The bundle the fake build leaves behind: the version it reported, and a revision that
    // only changes when something rebuilds it.
    stagedBundleIdentity: identity,
    requestQuit: () => events.push("quit"),
    readOutcome: () => {
      return outcome;
    },
    clearOutcome: () => {
      outcome = null;
    },
    now: () => Date.parse("2026-08-19T14:00:00.000Z"),
    random: () => 0,
    log: (line) => events.push(`log:${line}`),
    dialogs: {
      available: async () => "defer",
      upToDate: async () => {
        events.push("up-to-date-dialog");
      },
      preparing: async (version, stage) => {
        events.push(`preparing-dialog:${version}:${stage}`);
      },
      // The default answer to "ready to install?" is yes, so every test that accepts an
      // update reaches the handoff it used to reach in one step.
      ready: async () => "install",
      applying: async (version) => {
        events.push(`applying-dialog:${version}`);
      },
      error: async (message) => {
        events.push(`error-dialog:${message}`);
      },
      outcome: async (value) => {
        events.push(`outcome:${value.result}`);
      },
    },
    ...over,
  };
  const controller = new UpdateController(port);
  return {
    controller,
    events,
    handoffs,
    stageRequests,
    port,
    setOutcome: (value: UpdateApplyOutcome) => (outcome = value),
  };
}

test("ineligible installations disable before any release query", async () => {
  const cases: Array<[Partial<UpdaterPort>, RegExp]> = [
    [{ packaged: false }, /packaged app/],
    [{ arch: "x64" }, /Apple silicon/],
    [{ readReceipt: () => null }, /managed install/],
    [{ readReceipt: () => ({ ...receipt, repo: "someone/fork" }) }, /someone\/fork/],
  ];
  for (const [over, reason] of cases) {
    let queries = 0;
    const f = fixture({ ...over, latestRelease: async () => (queries += 1, release()) });
    await f.controller.start();
    assert.equal(f.controller.getSnapshot().phase, "disabled");
    assert.match((f.controller.getSnapshot() as { reason: string }).reason, reason);
    assert.equal(queries, 0);
    f.controller.stop();
  }
});

test("Node preflight prevents incompatible build attempts", async () => {
  let attempted = 0;
  for (const version of ["18.20.0", "22.0.0", "23.11.0"]) {
    const f = fixture({
      runtime: async () => ({ ok: false, message: `Requires Node.js 24 or newer (found ${version}). Check again.` }),
      stage: async () => {
        attempted++;
        return { ok: false, reason: "failed", message: "incompatible Node" };
      },
    });
    await f.controller.start();
    await f.controller.check(false);
    await f.controller.apply();
    f.controller.stop();
  }
  console.log(`NODE_PREFLIGHT_MEASUREMENT ${JSON.stringify({ incompatibleScenarios: 3, incompatibleBuildAttempts: attempted })}`);
  assert.equal(attempted, 0, "incompatible runtimes must never reach the build adapter");
});

test("Node remediation rechecks compatibility before offering and starting the build", async () => {
  let compatible = false;
  let probes = 0;
  const f = fixture({ runtime: async () => {
    probes++;
    return compatible
      ? { ok: true, node: "/selected/node", env: { PATH: "/selected:/usr/bin" } }
      : { ok: false, message: "Install Node.js 24+, then choose Check again." };
  } });
  await f.controller.start();
  const blocked = await f.controller.check(false);
  assert.equal(blocked.phase, "available");
  if (blocked.phase === "available") assert.match(blocked.blocker!, /Check again/);
  await f.controller.checkForUpdates();
  assert.ok(f.events.some((event) => event.includes("error-dialog:Install Node")));
  assert.equal(await f.controller.apply(), false);
  assert.equal(f.stageRequests.length, 0);
  compatible = true;
  await f.controller.check(true);
  const before = probes;
  assert.equal(await f.controller.apply(), true);
  assert.equal(probes, before + 1);
  assert.deepEqual(f.stageRequests[0]?.runtime, { ok: true, node: "/selected/node", env: { PATH: "/selected:/usr/bin" } });
  f.controller.stop();
});

test("a deferred intact update can install without npm but still validates Node", async () => {
  for (const nodeCompatible of [true, false]) {
    const f = fixture();
    await f.controller.start();
    await f.controller.check(true);
    await f.controller.apply();
    f.controller.defer();
    const probes: boolean[] = [];
    f.port.runtime = async (_cwd, needsBuildTools = true) => {
      probes.push(needsBuildTools);
      return needsBuildTools || !nodeCompatible
        ? { ok: false, message: needsBuildTools ? "npm is missing" : "Node is incompatible" }
        : { ok: true, node: "/selected/node", env: {} };
    };
    f.port.dialogs.available = async () => "apply";
    try {
      const snapshot = await f.controller.checkForUpdates();
      assert.equal(snapshot.phase, nodeCompatible ? "applying" : "available");
      assert.deepEqual(probes, nodeCompatible ? [false, false] : [false]);
      assert.equal(f.stageRequests.length, 1, "the deferred bundle must not rebuild");
      assert.equal(f.handoffs.length, nodeCompatible ? 1 : 0);
      if (snapshot.phase === "available") assert.equal(snapshot.blocker, "Node is incompatible");
    } finally { f.controller.stop(); }
  }
});

test("a changed or different-release deferred bundle still requires npm", async () => {
  for (const change of ["missing", "replaced", "different-release"] as const) {
    const f = fixture();
    await f.controller.start();
    await f.controller.check(true);
    await f.controller.apply();
    f.controller.defer();
    if (change === "different-release") f.port.latestRelease = async () => release({ tagName: "v1.2.5" });
    else f.port.stagedBundleIdentity = () => change === "missing"
      ? { version: null, revision: null }
      : { version: "1.2.4", revision: "replacement" };
    const probes: boolean[] = [];
    f.port.runtime = async (_cwd, needsBuildTools = true) => {
      probes.push(needsBuildTools);
      return { ok: false, message: "npm is missing" };
    };
    try {
      const snapshot = await f.controller.checkForUpdates();
      assert.equal(snapshot.phase, "available", change);
      if (snapshot.phase === "available") assert.equal(snapshot.blocker, "npm is missing", change);
      assert.deepEqual(probes, [true], change);
      assert.equal(f.stageRequests.length, 1, change);
      assert.equal(f.handoffs.length, 0, change);
    } finally { f.controller.stop(); }
  }
});

test("a runtime changed after the offer blocks before build or quit", async () => {
  const f = fixture();
  await f.controller.start();
  await f.controller.check(false);
  f.port.runtime = async () => ({ ok: false, message: "Node.js 22 is incompatible. Check again." });
  assert.equal(await f.controller.apply(), false);
  const snapshot = f.controller.getSnapshot();
  assert.equal(snapshot.phase, "available");
  if (snapshot.phase === "available") assert.match(snapshot.blocker!, /Node.js 22/);
  assert.equal(f.stageRequests.length, 0);
  assert.equal(f.handoffs.length, 0);
  assert.ok(!f.events.includes("quit"));
  f.controller.stop();
});

test("cancelling during runtime preflight prevents a late build", async () => {
  const f = fixture();
  await f.controller.start();
  await f.controller.check(false);
  let finish!: (runtime: Awaited<ReturnType<UpdaterPort["runtime"]>>) => void;
  f.port.runtime = () => new Promise((resolve) => { finish = resolve; });
  const first = f.controller.apply();
  assert.equal(f.controller.apply(), first);
  f.controller.cancel();
  finish({ ok: true, node: "/node", env: {} });
  assert.equal(await first, false);
  assert.equal(f.stageRequests.length, 0);
  assert.equal(f.controller.getSnapshot().phase, "available");
  f.controller.stop();
});

test("an existing managed install remains eligible during the repository migration", async () => {
  const f = fixture({ readReceipt: () => ({ ...receipt, repo: "mancej-cyc/ai-harness" }) });
  await f.controller.start();
  assert.equal(f.controller.getSnapshot().phase, "idle");
  f.controller.stop();
});

test("a check is deduplicated and offers the newest stable release", async () => {
  let finish!: (value: ReleaseInfo) => void;
  let queries = 0;
  const pending = new Promise<ReleaseInfo>((resolve) => (finish = resolve));
  const f = fixture({ latestRelease: () => (queries += 1, pending) });
  await f.controller.start();

  const first = f.controller.check(true);
  const second = f.controller.check(true);
  assert.equal(first, second);
  assert.equal(f.controller.getSnapshot().phase, "checking");
  finish(release());
  const snapshot = await first;

  assert.equal(queries, 1);
  assert.equal(snapshot.phase, "available");
  if (snapshot.phase === "available") {
    assert.equal(snapshot.newVersion, "1.2.4");
    assert.equal(snapshot.releaseNotes, "Fixed\nSafer updates");
  }
  f.controller.stop();
});

test("equal and lower remote versions are never offered, including v-prefixed tags", async () => {
  for (const tagName of ["v1.2.3", "v1.2.2", "1.2.2"]) {
    const f = fixture({ latestRelease: async () => release({ tagName }) });
    await f.controller.start();
    assert.equal((await f.controller.check(true)).phase, "up-to-date", tagName);
    f.controller.stop();
  }
});

test("release lookup filters before selection and pins every release call to the canonical repo", async () => {
  const calls: string[][] = [];
  const found = await latestStableRelease(async (args) => {
    calls.push(args);
    return calls.length === 1
      ? {
          code: 0,
          stdout: JSON.stringify([
            {
              tagName: "v1.2.4",
              name: "Stable",
              publishedAt: "2026-08-19T13:00:00.000Z",
              isDraft: false,
              isPrerelease: false,
            },
          ]),
          stderr: "",
        }
      : { code: 0, stdout: JSON.stringify({ body: "notes" }), stderr: "" };
  });

  assert.equal(found?.tagName, "v1.2.4");
  assert.deepEqual(calls[0], UPDATE_GH_ARGS.releaseList());
  assert.ok(calls[0]?.includes("--exclude-drafts"));
  assert.ok(calls[0]?.includes("--exclude-pre-releases"));
  for (const args of calls) {
    assert.deepEqual(args.slice(args.indexOf("--repo"), args.indexOf("--repo") + 2), [
      "--repo",
      "teamupstart/mission-control",
    ]);
  }
});

test("newer prereleases and drafts cannot strand the newest stable release", async () => {
  for (const hidden of [
    release({ tagName: "v2.0.0", isPrerelease: true }),
    release({ tagName: "v3.0.0", isDraft: true }),
  ]) {
    let call = 0;
    const found = await latestStableRelease(async (args) => {
      call += 1;
      if (call === 1) {
        const filtersStable =
          args.includes("--exclude-drafts") && args.includes("--exclude-pre-releases");
        return {
          code: 0,
          stdout: JSON.stringify([
            filtersStable
              ? release({ tagName: "v1.2.4" })
              : hidden,
          ]),
          stderr: "",
        };
      }
      return { code: 0, stdout: JSON.stringify({ body: "stable notes" }), stderr: "" };
    });
    assert.equal(found?.tagName, "v1.2.4");
  }
});

test("a draft or prerelease returned despite the gh filter is refused", async () => {
  for (const flags of [{ isDraft: true }, { isPrerelease: true }]) {
    await assert.rejects(
      latestStableRelease(async () => ({
        code: 0,
        stdout: JSON.stringify([release(flags)]),
        stderr: "",
      })),
      /ineligible draft or prerelease/,
    );
  }
});

test("missing and unauthenticated gh failures have specific safe messages", async () => {
  await assert.rejects(
    latestStableRelease(async () => ({ code: 127, stdout: "", stderr: "", errorCode: "ENOENT" })),
    /not installed/,
  );
  await assert.rejects(
    latestStableRelease(async () => ({ code: 1, stdout: "", stderr: "authentication required" })),
    /not authenticated/,
  );
});

test("rate limiting reads as rate limiting, and does not read as a lapsed credential", async () => {
  // GitHub's own 403 body advertises that "higher rate limits apply to authenticated requests",
  // so the auth test has to run second or a working credential is reported as lapsed.
  await assert.rejects(
    latestStableRelease(async () => ({
      code: 1,
      stdout: "",
      stderr:
        "HTTP 403: API rate limit exceeded for user ID 1; higher rate limits apply to authenticated requests",
    })),
    /rate limit is reached/,
  );
  await assert.rejects(
    latestStableRelease(async () => ({ code: 1, stdout: "", stderr: "HTTP 401: Bad credentials" })),
    /not authenticated/,
  );
  // And a URL that merely contains "login" is not an auth failure.
  await assert.rejects(
    latestStableRelease(async () => ({
      code: 1,
      stdout: "",
      stderr: "could not resolve host github.com/login-service",
    })),
    /cannot list releases here/,
  );
});

test("a 403 that is not a rate limit is not reported as one", async () => {
  // 403 is also how GitHub refuses authorization outright. Reporting that as a rate limit tells
  // someone to wait an hour for a permission they will never be granted - and this class is
  // deliberately suppressed during background checks, so the wait would be silent too.
  for (const stderr of [
    "HTTP 403: Resource not accessible by integration",
    "HTTP 403: Must have admin rights to Repository",
  ]) {
    await assert.rejects(
      latestStableRelease(async () => ({ code: 1, stdout: "", stderr })),
      (error: unknown) => {
        assert.doesNotMatch(String((error as Error).message), /rate limit/i);
        return true;
      },
    );
  }
  // 429 is used for nothing else, so it still counts on the code alone.
  await assert.rejects(
    latestStableRelease(async () => ({ code: 1, stdout: "", stderr: "HTTP 429: Too Many Requests" })),
    /rate limit is reached/,
  );
});

test("only a standing, user-actionable failure may interrupt a background check", () => {
  assert.equal(surfacesFromBackgroundCheck("gh-auth"), true);
  assert.equal(surfacesFromBackgroundCheck("gh-missing"), true);
  // These clear themselves; a banner for them trains people to dismiss the one that matters.
  assert.equal(surfacesFromBackgroundCheck("gh-rate-limited"), false);
  assert.equal(surfacesFromBackgroundCheck("gh-failed"), false);
});

test("a lapsed gh credential becomes visible without anyone running a manual check", async () => {
  const f = fixture({
    latestRelease: async () => {
      throw await latestStableRelease(async () => ({
        code: 1,
        stdout: "",
        stderr: "HTTP 401: Bad credentials",
      })).catch((error: unknown) => error);
    },
  });
  await f.controller.start();

  const background = await f.controller.check(false);

  assert.equal(background.phase, "error");
  if (background.phase === "error") {
    assert.match(background.message, /gh auth login/);
    // Reached the banner, not a modal: a background check never interrupts with a dialog.
    assert.equal(background.manual, false);
    assert.equal(background.retryable, true);
  }
  assert.equal(f.events.filter((event) => event.startsWith("error-dialog")).length, 0);
  f.controller.stop();
});

test("a rate-limited background check still returns quietly to idle", async () => {
  const f = fixture({
    latestRelease: async () => {
      throw await latestStableRelease(async () => ({
        code: 1,
        stdout: "",
        stderr: "HTTP 403: API rate limit exceeded",
      })).catch((error: unknown) => error);
    },
  });
  await f.controller.start();

  assert.equal((await f.controller.check(false)).phase, "idle");
  const manual = await f.controller.check(true);
  assert.equal(manual.phase, "error");
  if (manual.phase === "error") assert.match(manual.message, /rate limit is reached/);
  f.controller.stop();
});

test("background failures return quietly to idle while manual failures are actionable", async () => {
  const f = fixture({ latestRelease: async () => { throw new Error("boom"); } });
  await f.controller.start();
  assert.equal((await f.controller.check(false)).phase, "idle");
  const manual = await f.controller.check(true);
  assert.equal(manual.phase, "error");
  if (manual.phase === "error") {
    assert.match(manual.message, /failed unexpectedly/);
    assert.equal(manual.retryable, true);
  }
  assert.equal(f.events.filter((event) => event.startsWith("error-dialog")).length, 0);
  f.controller.stop();
});

test("a manual command joining a failing background check still shows the failure", async () => {
  let fail!: (error: Error) => void;
  const pending = new Promise<ReleaseInfo>((_resolve, reject) => (fail = reject));
  const f = fixture({ latestRelease: () => pending });
  await f.controller.start();

  const background = f.controller.check(false);
  const manual = f.controller.checkForUpdates();
  fail(new Error("boom"));

  assert.equal((await background).phase, "error");
  assert.equal((await manual).phase, "error");
  assert.equal(
    f.events.filter((event) => event.startsWith("error-dialog:")).length,
    1,
  );
  f.controller.stop();
});

test("menu and tray can share one deduplicated command that applies only after acceptance", async () => {
  let choose!: (choice: "apply" | "defer") => void;
  let prompts = 0;
  const f = fixture({
    dialogs: {
      ...fixture().port.dialogs,
      available: () => {
        prompts += 1;
        return new Promise((resolve) => (choose = resolve));
      },
    },
  });
  await f.controller.start();
  const menu = f.controller.checkForUpdates();
  const tray = f.controller.checkForUpdates();
  assert.equal(menu, tray);
  await flush();
  choose("apply");
  await menu;
  assert.equal(prompts, 1);
  assert.deepEqual(f.events, ["handoff", "quit"]);
  f.controller.stop();
});

test("a background recheck cannot invalidate an update dialog awaiting acceptance", async () => {
  let choose!: (choice: "apply" | "defer") => void;
  let queries = 0;
  let now = Date.parse("2026-08-19T14:00:00.000Z");
  const f = fixture({
    now: () => now,
    latestRelease: async () => {
      queries += 1;
      if (queries > 1) throw new Error("transient background failure");
      return release();
    },
    dialogs: {
      ...fixture().port.dialogs,
      available: () => new Promise((resolve) => (choose = resolve)),
    },
  });
  await f.controller.start();

  const command = f.controller.checkForUpdates();
  await flush();
  assert.equal(f.controller.getSnapshot().phase, "available");
  now += 6 * 60 * 60 * 1000;
  f.controller.onActivate();
  await flush();
  const background = await f.controller.check(false);
  choose("apply");
  const completed = await command;

  assert.equal(queries, 1);
  assert.equal(background.phase, "available");
  assert.equal(completed.phase, "applying");
  assert.deepEqual(f.events, ["handoff", "quit"]);
  f.controller.stop();
});

test("declining an available update hands off nothing", async () => {
  const f = fixture();
  await f.controller.start();
  assert.equal((await f.controller.checkForUpdates()).phase, "idle");
  assert.deepEqual(f.events, []);
  f.controller.stop();
});

test("a manual current-version check reports it while a background check stays silent", async () => {
  const f = fixture({ latestRelease: async () => release({ tagName: "v1.2.3" }) });
  await f.controller.start();
  await f.controller.check(false);
  assert.deepEqual(f.events, []);
  await f.controller.checkForUpdates();
  assert.deepEqual(f.events, ["up-to-date-dialog"]);
  f.controller.stop();
});

test("activation preserves the startup delay and checks only after a long sleep", async () => {
  let now = Date.parse("2026-08-19T14:00:00.000Z");
  let queries = 0;
  const f = fixture({
    now: () => now,
    latestRelease: async () => {
      queries += 1;
      return release({ tagName: "v1.2.3" });
    },
  });
  await f.controller.start();

  f.controller.onActivate();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queries, 0);

  now += 6 * 60 * 60 * 1000;
  f.controller.onActivate();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queries, 1);
  f.controller.stop();
});

test("a build already in flight cannot start a second one", async () => {
  let finish!: (outcome: {
    ok: true;
    staged: { version: string; bundlePath: string; revision: string | null };
  }) => void;
  const f = fixture({
    stage: () => new Promise((resolve) => (finish = resolve)),
  });
  await f.controller.start();
  await f.controller.check(true);
  const first = f.controller.apply();
  const second = f.controller.apply();
  assert.equal(first, second);
  assert.equal(f.controller.getSnapshot().phase, "preparing");
  await flush();
  finish({ ok: true, staged: { version: "1.2.4", bundlePath: STAGED_BUNDLE, revision: "staged-1" } });
  assert.equal(await first, true);
  assert.equal(f.controller.getSnapshot().phase, "ready");
  f.controller.stop();
});

test("an install already in flight cannot spawn a second helper", async () => {
  let finish!: () => void;
  const f = fixture({ handoff: () => new Promise<void>((resolve) => (finish = resolve)) });
  await f.controller.start();
  await f.controller.check(true);
  await f.controller.apply();
  const first = f.controller.install();
  const second = f.controller.install();
  assert.equal(first, second);
  await flush();
  finish();
  assert.equal(await first, true);
  // This fixture replaces `handoff` outright, so only the quit it triggers is recorded.
  assert.deepEqual(f.events, ["quit"]);
  f.controller.stop();
});

test("a manual command reports when an update is already being applied", async () => {
  let finish!: () => void;
  const applyingVersions: string[] = [];
  const f = fixture({
    handoff: () => new Promise<void>((resolve) => (finish = resolve)),
    dialogs: {
      ...fixture().port.dialogs,
      available: async () => "apply",
      applying: async (version) => {
        applyingVersions.push(version);
      },
    },
  });
  await f.controller.start();

  const acceptedUpdateCommand = f.controller.checkForUpdates();
  await flush();
  assert.equal(f.controller.getSnapshot().phase, "applying");
  const repeatedCommand = f.controller.checkForUpdates();
  assert.notEqual(repeatedCommand, acceptedUpdateCommand);
  assert.equal((await repeatedCommand).phase, "applying");
  assert.deepEqual(applyingVersions, ["1.2.4"]);

  finish();
  assert.equal((await acceptedUpdateCommand).phase, "applying");
  f.controller.stop();
});

test("a prior outcome is surfaced once and retained in the in-memory snapshot", async () => {
  const f = fixture();
  f.setOutcome({
    result: "failure",
    targetVersion: "1.2.4",
    recordedAt: "2026-08-19T13:30:00.000Z",
    message: "build failed",
  });
  await f.controller.start();
  assert.equal(f.controller.getSnapshot().lastOutcome?.result, "failure");
  assert.deepEqual(f.events, ["outcome:failure"]);
  f.controller.stop();

  const next = fixture();
  await next.controller.start();
  assert.equal(next.controller.getSnapshot().lastOutcome, null);
  next.controller.stop();
});

test("release notes and diagnostics leave only bounded plain safe text", () => {
  const notes = sanitizeReleaseNotes(`# Title\n<script>bad()</script>\n[link](https://secret)\n${"x".repeat(5000)}`);
  assert.doesNotMatch(notes, /<script>|https:\/\//);
  assert.ok(notes.length <= 4000);
  const log = sanitizeLogLine(
    "Authorization: Bearer abc gho_secret /Users/person/private token=hush at file:///private/tmp/install-app.mjs:13",
  );
  assert.doesNotMatch(log, /abc|gho_secret|\/Users\/person|\/private\/tmp|hush/);
});

test("the release-please signature is cut from the notes, but a real horizontal rule is not", () => {
  // Every body release-please writes ends this way, so without this the banner and the native
  // dialog both told the person that their update "was generated with Release Please" as
  // though it were one of the changes. Verified against the real v1.0.1 release body.
  const generated = sanitizeReleaseNotes(
    [
      "## [1.0.1](https://github.com/o/r/compare/v1.0.0...v1.0.1) (2026-08-22)",
      "",
      "### Bug Fixes",
      "",
      "* **release:** unpin release-as ([#732](https://github.com/o/r/issues/732))",
      "",
      "---",
      "This PR was generated with [Release Please](https://github.com/googleapis/release-please)." +
        " See [documentation](https://github.com/googleapis/release-please).",
      "",
      "<!-- codesmith:footer -->",
      "",
    ].join("\n"),
  );
  assert.doesNotMatch(generated, /Release Please|codesmith|---/);
  assert.match(generated, /unpin release-as/);

  // A rule that separates real content is content, and stays.
  const authored = sanitizeReleaseNotes("### Features\n\n* a thing\n\n---\n\nUpgrade notes: migrate first.");
  assert.match(authored, /---/);
  assert.match(authored, /Upgrade notes: migrate first\./);
});


test("an update is built while the app stays open, and only installs when asked", async () => {
  const stages: string[] = [];
  const f = fixture();
  f.controller.subscribe((snapshot) => {
    if (snapshot.phase === "preparing") stages.push(snapshot.stage);
  });
  await f.controller.start();
  await f.controller.check(true);

  assert.equal(await f.controller.apply(), true);
  // The whole point: the minutes of building happen with the app running, so nothing has been
  // handed off and nothing has quit by the time the person is told it is ready.
  assert.deepEqual(f.events, []);
  const ready = f.controller.getSnapshot();
  assert.equal(ready.phase, "ready");
  if (ready.phase === "ready") assert.equal(ready.newVersion, "1.2.4");
  assert.deepEqual(stages, ["starting", "prerequisites", "dependencies", "build"]);
  assert.deepEqual(
    f.stageRequests.map((request) => [request.sourceClone, request.targetTag]),
    [["/tmp/mission-source", "v1.2.4"]],
  );

  assert.equal(await f.controller.install(), true);
  assert.deepEqual(f.events, ["handoff", "quit"]);
  assert.equal(f.handoffs.length, 1);
  assert.equal(f.handoffs[0]?.stagedBundle, STAGED_BUNDLE);
  assert.equal(f.handoffs[0]?.targetTag, "v1.2.4");
  // The pin travels with the path: this app's check happened before it quit, and the install
  // script is the last reader that can refuse a bundle replaced in between.
  assert.equal(f.handoffs[0]?.stagedRevision, "staged-1");
  assert.equal(f.controller.getSnapshot().phase, "applying");
  f.controller.stop();
});

test("cancelling a build returns to the offer and installs nothing", async () => {
  let signal!: AbortSignal;
  const f = fixture({
    stage: (request) =>
      new Promise((resolve) => {
        signal = request.signal;
        request.signal.addEventListener("abort", () =>
          resolve({ ok: false, reason: "cancelled", message: "The update was cancelled." }),
        );
      }),
  });
  await f.controller.start();
  await f.controller.check(true);
  const preparing = f.controller.apply();
  assert.equal(f.controller.getSnapshot().phase, "preparing");

  await flush();
  f.controller.cancel();
  assert.equal(signal.aborted, true);
  assert.equal(await preparing, false);
  assert.equal(f.controller.getSnapshot().phase, "available");
  assert.deepEqual(f.events, []);

  // And the offer is still live: accepting it again starts a new build.
  void f.controller.apply();
  assert.equal(f.controller.getSnapshot().phase, "preparing");
  f.controller.stop();
});

test("quitting the app cancels a build rather than leaving it in the clone", async () => {
  let signal!: AbortSignal;
  const f = fixture({
    stage: (request) =>
      new Promise((resolve) => {
        signal = request.signal;
        request.signal.addEventListener("abort", () =>
          resolve({ ok: false, reason: "cancelled", message: "The update was cancelled." }),
        );
      }),
  });
  await f.controller.start();
  await f.controller.check(true);
  const preparing = f.controller.apply();
  await flush();
  f.controller.stop();
  assert.equal(signal.aborted, true);
  assert.equal(await preparing, false);
});

test("a prepared update that was deferred installs without building again", async () => {
  const f = fixture();
  await f.controller.start();
  await f.controller.check(true);
  await f.controller.apply();
  f.controller.defer();
  assert.equal(f.controller.getSnapshot().phase, "idle");

  await f.controller.check(true);
  assert.equal(await f.controller.apply(), true);
  assert.equal(f.controller.getSnapshot().phase, "ready");
  assert.equal(f.stageRequests.length, 1);

  assert.equal(await f.controller.install(), true);
  assert.equal(f.handoffs[0]?.stagedBundle, STAGED_BUNDLE);
  f.controller.stop();
});

test("a prepared bundle that is gone is reported instead of handed off", async () => {
  let identity = { version: "1.2.4", revision: "staged-1" } as {
    version: string | null;
    revision: string | null;
  };
  const f = fixture({ stagedBundleIdentity: () => identity });
  await f.controller.start();
  await f.controller.check(true);
  await f.controller.apply();
  identity = { version: null, revision: null };

  assert.equal(await f.controller.install(), false);
  const snapshot = f.controller.getSnapshot();
  assert.equal(snapshot.phase, "error");
  if (snapshot.phase === "error") {
    assert.match(snapshot.message, /no longer there to install/);
    assert.equal(snapshot.retryable, true);
  }
  // Nothing quit, so the person still has a working app and a retry.
  assert.deepEqual(f.events, []);

  // And that emptiness means something: the same fixture records both events as soon as an
  // install does happen. Retry rebuilds - the vanished bundle was forgotten, not reused - and
  // this time the handoff goes through.
  identity = { version: "1.2.4", revision: "staged-2" };
  await f.controller.check(true);
  assert.equal(await f.controller.apply(), true);
  assert.equal(f.stageRequests.length, 2);
  assert.equal(await f.controller.install(), true);
  assert.deepEqual(f.events, ["handoff", "quit"]);
  f.controller.stop();
});

test("an installed version that cannot stage still applies through the detached helper", async () => {
  const f = fixture({
    stage: async () => ({
      ok: false,
      reason: "unsupported",
      message: "This installed version cannot build the update in the background.",
    }),
  });
  await f.controller.start();
  await f.controller.check(true);

  assert.equal(await f.controller.apply(), true);
  assert.equal(f.controller.getSnapshot().phase, "applying");
  assert.equal(f.handoffs[0]?.stagedBundle, null);
  // Nothing was staged, so there is nothing to pin either, and the helper builds as it always
  // did rather than being handed a token for a bundle that does not exist.
  assert.equal(f.handoffs[0]?.stagedRevision, null);
  assert.deepEqual(
    f.events.filter((event) => event === "handoff" || event === "quit"),
    ["handoff", "quit"],
  );
  f.controller.stop();
});

test("a failed build reports itself and leaves the app running", async () => {
  const f = fixture({
    stage: async () => ({
      ok: false,
      reason: "failed",
      message: "The update build failed (exit 1). Check the update log and try again.",
    }),
  });
  await f.controller.start();
  await f.controller.check(true);

  assert.equal(await f.controller.apply(), false);
  const snapshot = f.controller.getSnapshot();
  assert.equal(snapshot.phase, "error");
  if (snapshot.phase === "error") assert.match(snapshot.message, /exit 1/);
  assert.ok(f.events.some((event) => event.startsWith("error-dialog:")));
  assert.ok(!f.events.includes("quit"));
  f.controller.stop();
});

test("a failed handoff is reported exactly as a failed build is, and nothing quits", async () => {
  // The second caller of the one failure-reporting path. Both halves of an accepted update can
  // fail - the build while the app is open, and the handoff after the person accepts the
  // restart - and a person must get the same treatment either way: the real reason in the log,
  // a retryable error in the banner, a dialog for whoever started this from the menu bar, and
  // an app still running. Pinned on both callers so the shared helper cannot be right in one
  // place and wrong in the other.
  const f = fixture({
    handoff: async () => {
      throw new Error("EACCES /Applications/Mission Control.app");
    },
  });
  await f.controller.start();
  await f.controller.check(true);
  await f.controller.apply();
  assert.equal(f.controller.getSnapshot().phase, "ready");

  assert.equal(await f.controller.install(), false);
  const snapshot = f.controller.getSnapshot();
  assert.equal(snapshot.phase, "error");
  if (snapshot.phase === "error") {
    assert.equal(snapshot.currentVersion, "1.2.3");
    assert.equal(snapshot.manual, true);
    assert.equal(snapshot.retryable, true);
  }
  // The person sees a dialog, the log keeps the real reason under the handoff prefix, and the
  // app is still there.
  assert.ok(f.events.some((event) => event.startsWith("error-dialog:")));
  assert.ok(
    f.events.some((event) => event.startsWith("log:update handoff failed: EACCES")),
    f.events.join("\n"),
  );
  assert.ok(!f.events.includes("quit"));

  // And the same protocol from the build half: same shaped snapshot, same dialog, only the
  // log prefix differs. That is the whole of what the two callers are allowed to vary.
  const build = fixture({
    stage: async () => ({ ok: false, reason: "failed", message: "The update build failed (exit 1)." }),
  });
  await build.controller.start();
  await build.controller.check(true);
  assert.equal(await build.controller.apply(), false);
  const buildSnapshot = build.controller.getSnapshot();
  assert.equal(buildSnapshot.phase, "error");
  if (buildSnapshot.phase === "error" && snapshot.phase === "error") {
    assert.deepEqual(Object.keys(buildSnapshot).sort(), Object.keys(snapshot).sort());
    assert.equal(buildSnapshot.manual, snapshot.manual);
    assert.equal(buildSnapshot.currentVersion, snapshot.currentVersion);
  }
  assert.ok(build.events.some((event) => event.startsWith("log:update build failed: ")));
  assert.ok(!build.events.includes("quit"));

  f.controller.stop();
  build.controller.stop();
});

test("neither a build nor a prepared update can be overwritten by a check", async () => {
  let signal!: AbortSignal;
  const f = fixture({
    stage: (request) =>
      new Promise((resolve) => {
        signal = request.signal;
        request.signal.addEventListener("abort", () =>
          resolve({ ok: false, reason: "cancelled", message: "The update was cancelled." }),
        );
      }),
  });
  await f.controller.start();
  await f.controller.check(true);
  const preparing = f.controller.apply();

  assert.equal((await f.controller.check(true)).phase, "preparing");
  assert.equal((await f.controller.check(false)).phase, "preparing");
  f.controller.onActivate();
  await flush(2);
  assert.equal(f.controller.getSnapshot().phase, "preparing");

  f.controller.cancel();
  assert.equal(signal.aborted, true);
  await preparing;

  const ready = fixture();
  await ready.controller.start();
  await ready.controller.check(true);
  await ready.controller.apply();
  assert.equal((await ready.controller.check(true)).phase, "ready");
  f.controller.stop();
  ready.controller.stop();
});

test("a manual command reports the stage a build has reached", async () => {
  const f = fixture({
    stage: (request) =>
      new Promise((resolve) => {
        request.onStage("dependencies");
        request.signal.addEventListener("abort", () =>
          resolve({ ok: false, reason: "cancelled", message: "The update was cancelled." }),
        );
      }),
  });
  await f.controller.start();
  await f.controller.check(true);
  void f.controller.apply();
  await flush();

  assert.equal((await f.controller.checkForUpdates()).phase, "preparing");
  assert.deepEqual(f.events, ["preparing-dialog:1.2.4:Installing dependencies"]);
  f.controller.stop();
});

test("the native path can decline the restart and keep the prepared build", async () => {
  const f = fixture({
    dialogs: {
      ...fixture().port.dialogs,
      available: async () => "apply",
      ready: async () => "defer",
    },
  });
  await f.controller.start();

  assert.equal((await f.controller.checkForUpdates()).phase, "idle");
  assert.deepEqual(f.events, []);
  assert.equal(f.stageRequests.length, 1);

  // Coming back to it installs the bundle already built, with no second build.
  await f.controller.check(true);
  await f.controller.apply();
  assert.equal(await f.controller.install(), true);
  assert.equal(f.stageRequests.length, 1);
  assert.deepEqual(f.events, ["handoff", "quit"]);
  f.controller.stop();
});


test("a bundle that is not the one prepared is refused, however it changed", async () => {
  // The updater-owned clone is shared. Anything that rebuilds it between preparation and the
  // restart leaves a perfectly valid app at the staged path, and installing that would put a
  // version nobody accepted into place under a receipt naming the tag they did accept. Version
  // and revision both have to match, and a port that cannot answer fails closed.
  const cases: Array<[string, { version: string | null; revision: string | null }]> = [
    ["nothing there at all", { version: null, revision: null }],
    ["a different version at the same path", { version: "1.5.0", revision: "rebuilt" }],
    ["the same version, rebuilt", { version: "1.2.4", revision: "rebuilt" }],
    ["a version but no readable revision", { version: "1.2.4", revision: null }],
  ];

  for (const [label, changed] of cases) {
    let identity = { version: "1.2.4", revision: "staged-1" } as {
      version: string | null;
      revision: string | null;
    };
    const f = fixture({ stagedBundleIdentity: () => identity });
    await f.controller.start();
    await f.controller.check(true);
    await f.controller.apply();
    assert.equal(f.controller.getSnapshot().phase, "ready", label);

    identity = changed;
    assert.equal(await f.controller.install(), false, label);
    const snapshot = f.controller.getSnapshot();
    assert.equal(snapshot.phase, "error", label);
    if (snapshot.phase === "error") {
      assert.match(snapshot.message, /no longer there to install/, label);
      assert.equal(snapshot.retryable, true, label);
    }
    // Nothing was handed off and nothing quit, so the working app is still the working app.
    assert.deepEqual(f.events, [], label);
    f.controller.stop();
  }
});

test("a rebuilt clone is not reused as a prepared update, it is built again", async () => {
  let identity = { version: "1.2.4", revision: "staged-1" } as {
    version: string | null;
    revision: string | null;
  };
  const f = fixture({ stagedBundleIdentity: () => identity });
  await f.controller.start();
  await f.controller.check(true);
  await f.controller.apply();
  f.controller.defer();
  assert.equal(f.stageRequests.length, 1);

  // Something rebuilt the shared clone while the update sat deferred. Coming back to it must
  // not take that bundle on trust, even though its version happens to match.
  identity = { version: "1.2.4", revision: "rebuilt-by-someone-else" };
  await f.controller.check(true);
  assert.equal(await f.controller.apply(), true);
  assert.equal(f.controller.getSnapshot().phase, "ready");
  assert.equal(f.stageRequests.length, 2, "the offer should have been rebuilt, not reused");

  // Whereas the untouched bundle from that second build is reused, which is the whole point of
  // keeping it: no third build.
  f.controller.defer();
  await f.controller.check(true);
  assert.equal(await f.controller.apply(), true);
  assert.equal(f.stageRequests.length, 2);
  f.controller.stop();
});


test("a bundle whose identity cannot be read is refused, not thrown at the caller", async () => {
  // `statSync` suppresses only ENOENT with `throwIfNoEntry: false`; EACCES on a parent and
  // ELOOP on a replaced symlink still throw. Both callers evaluate the identity check OUTSIDE
  // a try - the reuse shortcut before `apply()`'s async body exists, and `install()` before
  // its promise is assigned - so an escape would reject the IPC call with the snapshot still
  // reading `ready`: no dialog, no banner error, nothing for the person to act on.
  let identity: () => { version: string | null; revision: string | null } = () => ({
    version: "1.2.4",
    revision: "staged-1",
  });
  const f = fixture({ stagedBundleIdentity: () => identity() });
  await f.controller.start();
  await f.controller.check(true);
  await f.controller.apply();
  assert.equal(f.controller.getSnapshot().phase, "ready");

  // Readable while the build ran, unreadable now - a directory whose permissions changed under
  // a prepared update, which is the case `install()`'s own guard exists for.
  identity = () => {
    throw Object.assign(new Error("EACCES: permission denied, stat"), { code: "EACCES" });
  };

  // Resolves false rather than rejecting, and the person gets the error and the retry.
  assert.equal(await f.controller.install(), false);
  const snapshot = f.controller.getSnapshot();
  assert.equal(snapshot.phase, "error");
  if (snapshot.phase === "error") assert.equal(snapshot.retryable, true);
  assert.deepEqual(f.events.filter((event) => event === "quit"), []);
  assert.ok(
    f.events.some((event) => event.startsWith("log:could not identify the prepared update: EACCES")),
    f.events.join("\n"),
  );
  f.controller.stop();

  // And when it is unreadable from the start, the build itself refuses rather than promising a
  // restart it cannot honour.
  const fromTheStart = fixture({
    stagedBundleIdentity: () => {
      throw Object.assign(new Error("ELOOP: too many symbolic links"), { code: "ELOOP" });
    },
  });
  await fromTheStart.controller.start();
  await fromTheStart.controller.check(true);
  assert.equal(await fromTheStart.controller.apply(), false);
  assert.equal(fromTheStart.controller.getSnapshot().phase, "error");
  assert.deepEqual(
    fromTheStart.events.filter((event) => event === "handoff" || event === "quit"),
    [],
  );
  fromTheStart.controller.stop();

  // The reuse shortcut takes the same route rather than throwing out of apply(): a bundle that
  // became unreadable while it sat deferred is rebuilt, not reused.
  let readable = true;
  const reuse = fixture({
    stagedBundleIdentity: () => {
      if (!readable) throw new Error("ELOOP: too many symbolic links");
      return { version: "1.2.4", revision: "staged-1" };
    },
  });
  await reuse.controller.start();
  await reuse.controller.check(true);
  assert.equal(await reuse.controller.apply(), true);
  assert.equal(reuse.controller.getSnapshot().phase, "ready");
  reuse.controller.defer();

  readable = false;
  await reuse.controller.check(true);
  assert.equal(await reuse.controller.apply(), false, "an unreadable bundle cannot be reused");
  assert.equal(reuse.controller.getSnapshot().phase, "error");
  readable = true;
  await reuse.controller.check(true);
  assert.equal(await reuse.controller.apply(), true);
  // Three builds for three acceptances: the deferred bundle was never reused, not once, which
  // is the property here - the unreadable attempt spent a build and then refused rather than
  // installing something it could not identify.
  assert.equal(reuse.stageRequests.length, 3);
  reuse.controller.stop();
});


test("a build replaced before it could be pinned is refused, and never called ready", async () => {
  // The install script reads the bundle's identity in the same breath as it verifies it and
  // reports it with the marker. Anything this app read afterwards could already be a
  // replacement, which would then pass every later check while never having been verified.
  //
  // And the refusal belongs here, at the end of the build: calling it ready and refusing at
  // the restart would spend the person's minutes, promise them a version, and only then send
  // them back to rebuild.
  const f = fixture({
    stage: async () => ({
      ok: true,
      staged: { version: "1.2.4", bundlePath: STAGED_BUNDLE, revision: "verified-at-build" },
    }),
    // What is on disk NOW disagrees, which is exactly the race: something rebuilt the clone
    // between the script's verification and this app looking.
    stagedBundleIdentity: () => ({ version: "1.2.4", revision: "rebuilt-since" }),
  });
  await f.controller.start();
  await f.controller.check(true);

  assert.equal(await f.controller.apply(), false);
  const snapshot = f.controller.getSnapshot();
  assert.equal(snapshot.phase, "error");
  if (snapshot.phase === "error") {
    assert.match(snapshot.message, /replaced while it was being prepared/);
    assert.equal(snapshot.retryable, true);
  }
  // Nothing handed off, nothing quit, and no "ready" ever published.
  assert.deepEqual(f.events.filter((event) => event === "handoff" || event === "quit"), []);
  f.controller.stop();
});

test("a build this app cannot pin is not staged at all, it is handed over whole", async () => {
  // A clone checked out at a ref older than this app has a script that predates the identity
  // field, so it reports no revision. Reading one here instead - after that process exited -
  // would pin whatever is on disk by now, which is the very race the pin exists to close. So
  // the whole install goes to the detached helper: no progress bar, and no claim about a
  // bundle nobody checked.
  const f = fixture({
    stage: async () => ({
      ok: true,
      staged: { version: "1.2.4", bundlePath: STAGED_BUNDLE, revision: null },
    }),
  });
  await f.controller.start();
  await f.controller.check(true);

  assert.equal(await f.controller.apply(), true);
  assert.equal(f.controller.getSnapshot().phase, "applying");
  // Handed over with no bundle and no pin, which is the pre-staging path.
  assert.equal(f.handoffs.length, 1);
  assert.equal(f.handoffs[0]?.stagedBundle, null);
  assert.equal(f.handoffs[0]?.stagedRevision, null);
  assert.ok(
    f.events.some((event) => event.startsWith("log:the installed version's install script reports no bundle identity")),
    f.events.join("\n"),
  );
  // Never called ready, so nobody was promised a restart into a bundle that was not pinned.
  assert.deepEqual(f.events.filter((event) => event === "quit"), ["quit"]);
  f.controller.stop();
});

test("cancelling says so, refuses a second build, and comes back only when the build is gone", async () => {
  // Resolving on the signal let the offer return while npm and electron-builder were still
  // shutting down, and one click on Update Now then started a fresh checkout and install in
  // the directory they were still writing to.
  let release!: () => void;
  let aborted = false;
  let started = 0;
  const dying: { report: ((stage: UpdatePrepareStage) => void) | null } = { report: null };
  const f = fixture({
    stage: (request) =>
      new Promise((resolve) => {
        started += 1;
        dying.report = request.onStage;
        request.signal.addEventListener("abort", () => {
          aborted = true;
          // The group is still shutting down: nothing resolves until it is gone.
          release = () =>
            resolve({ ok: false, reason: "cancelled", message: "The update was cancelled." });
        });
      }),
  });
  await f.controller.start();
  await f.controller.check(true);
  const preparing = f.controller.apply();

  await flush();
  f.controller.cancel();
  assert.equal(aborted, true);
  const cancelling = f.controller.getSnapshot();
  assert.equal(cancelling.phase, "preparing");
  if (cancelling.phase === "preparing") assert.equal(cancelling.cancelling, true);

  // While it is going: no second build, and pressing Cancel again changes nothing.
  assert.equal(f.controller.apply(), preparing);
  f.controller.cancel();
  assert.equal(started, 1);
  assert.equal(f.controller.getSnapshot().phase, "preparing");

  // A stage report arriving from the dying build must not undo the cancelling state.
  dying.report?.("build");
  const during = f.controller.getSnapshot();
  if (during.phase === "preparing") assert.equal(during.cancelling, true);

  release();
  assert.equal(await preparing, false);
  assert.equal(f.controller.getSnapshot().phase, "available");
  assert.deepEqual(f.events, []);

  // And now a new build may start.
  void f.controller.apply();
  await flush();
  assert.equal(started, 2);
  f.controller.stop();
});
