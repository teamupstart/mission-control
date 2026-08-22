import assert from "node:assert/strict";
import test from "node:test";
import { CANONICAL_REPO } from "../src/shared/install-receipt-schema.mjs";
import type { InstallReceipt } from "../src/shared/install-receipt-schema.mjs";
import type { UpdateApplyOutcome } from "../src/shared/update.ts";
import {
  latestStableRelease,
  sanitizeLogLine,
  sanitizeReleaseNotes,
  surfacesFromBackgroundCheck,
  UpdateController,
  UPDATE_GH_ARGS,
  type ReleaseInfo,
  type UpdaterPort,
} from "../src/main/updater.ts";

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

function fixture(over: Partial<UpdaterPort> = {}) {
  const events: string[] = [];
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
    handoff: async () => {
      events.push("handoff");
    },
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
  return { controller, events, port, setOutcome: (value: UpdateApplyOutcome) => (outcome = value) };
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
      CANONICAL_REPO,
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
  await new Promise((resolve) => setImmediate(resolve));
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
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.controller.getSnapshot().phase, "available");
  now += 6 * 60 * 60 * 1000;
  f.controller.onActivate();
  await new Promise((resolve) => setImmediate(resolve));
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

test("an apply already in flight cannot spawn a second helper", async () => {
  let finish!: () => void;
  const f = fixture({ handoff: () => new Promise<void>((resolve) => (finish = resolve)) });
  await f.controller.start();
  await f.controller.check(true);
  const first = f.controller.apply();
  const second = f.controller.apply();
  assert.equal(first, second);
  finish();
  assert.equal(await first, true);
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
  await new Promise((resolve) => setImmediate(resolve));
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
