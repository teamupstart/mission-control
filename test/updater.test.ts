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
  const port: UpdaterPort = {
    packaged: true,
    arch: "arm64",
    currentVersion: () => "1.2.3",
    readReceipt: () => receipt,
    latestRelease: async () => release(),
    systemNode: () => "/opt/homebrew/bin/node",
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
      return { ok: true, staged: { version: "1.2.4", bundlePath: STAGED_BUNDLE } };
    },
    stagedBundleExists: () => true,
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
    [{ systemNode: () => null }, /system Node\.js/],
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
  let finish!: (outcome: { ok: true; staged: { version: string; bundlePath: string } }) => void;
  const f = fixture({
    stage: () => new Promise((resolve) => (finish = resolve)),
  });
  await f.controller.start();
  await f.controller.check(true);
  const first = f.controller.apply();
  const second = f.controller.apply();
  assert.equal(first, second);
  assert.equal(f.controller.getSnapshot().phase, "preparing");
  finish({ ok: true, staged: { version: "1.2.4", bundlePath: STAGED_BUNDLE } });
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
  let present = true;
  const f = fixture({ stagedBundleExists: () => present });
  await f.controller.start();
  await f.controller.check(true);
  await f.controller.apply();
  present = false;

  assert.equal(await f.controller.install(), false);
  const snapshot = f.controller.getSnapshot();
  assert.equal(snapshot.phase, "error");
  if (snapshot.phase === "error") {
    assert.match(snapshot.message, /no longer on disk/);
    assert.equal(snapshot.retryable, true);
  }
  // Nothing quit, so the person still has a working app and a retry.
  assert.deepEqual(f.events, []);

  // And that emptiness means something: the same fixture records both events as soon as an
  // install does happen. Retry rebuilds - the vanished bundle was forgotten, not reused - and
  // this time the handoff goes through.
  present = true;
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
