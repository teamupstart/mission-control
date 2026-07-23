import { test } from "node:test";
import assert from "node:assert/strict";
import { OPEN_TARGET_IDS, OPEN_TARGET_INFO } from "../src/shared/open-targets.ts";
import { OPEN_TARGETS, openFile, openTargetViews } from "../src/server/open-targets/index.ts";
import type { OpenDeps } from "../src/server/open-targets/types.ts";
import { stubRun, type RunResult } from "../src/server/util/exec.ts";

// What is at stake: an "Open in" target hands a file to an application OUTSIDE Mission
// Control, and the menu row is a PROMISE about which application. The tempting
// implementation - `open <file>` / `xdg-open <file>` - keeps that promise only for HTML,
// because those route by file type: the row says "Browser" and Xcode opens. The files view
// lists every file in the checkout, so that is the common case, not the edge one.
//
// So these pin three things. The argv each platform produces (an exact list, never a
// string a shell would re-split); that a platform which cannot answer refuses BY NAME
// instead of guessing; and that a launch which never reported back is not reported as a
// failure, because the application may well be open.

const PLIST = JSON.stringify({
  LSHandlers: [
    { LSHandlerURLScheme: "mailto", LSHandlerRoleAll: "com.apple.mail" },
    { LSHandlerURLScheme: "https", LSHandlerRoleAll: "com.google.chrome" },
  ],
});

interface Call { bin: string; args: string[] }

function deps(
  platform: NodeJS.Platform,
  answers: Record<string, RunResult>,
  installed: string[] = [],
  calls: Call[] = [],
): OpenDeps & { calls: Call[] } {
  return {
    platform,
    env: { HOME: "/Users/tester", PATH: "/usr/bin" },
    installed: (bin) => installed.includes(bin),
    calls,
    run: async (bin, args) => {
      calls.push({ bin, args });
      return answers[bin] ?? stubRun({ stdout: "", stderr: "not stubbed", code: 127 });
    },
  };
}

const ok = (stdout: string): RunResult => stubRun({ stdout, stderr: "", code: 0 });

test("every declared target is implemented, and nothing is implemented that isn't declared", () => {
  for (const id of OPEN_TARGET_IDS) {
    assert.ok(OPEN_TARGETS[id], `${id} is declared but has no implementation`);
    assert.equal(OPEN_TARGETS[id].id, id, `${id}'s implementation names itself wrong`);
    assert.equal(OPEN_TARGETS[id].label, OPEN_TARGET_INFO[id].label);
  }
  assert.deepEqual(Object.keys(OPEN_TARGETS).sort(), [...OPEN_TARGET_IDS].sort());
});

// The menu row is all a human gets to choose from; one with no label or no blurb is a row
// they cannot tell from any other.
test("every target says what it is called and what it promises", () => {
  for (const id of OPEN_TARGET_IDS) {
    const info = OPEN_TARGET_INFO[id];
    assert.ok(info.label.trim().length > 0, `${id} has no label`);
    assert.ok(info.blurb.trim().length > 0, `${id} has no blurb`);
    assert.ok(info.glyph.trim().length > 0, `${id} has no glyph`);
  }
});

test("macOS opens the bundle LaunchServices hands https to, by id", async () => {
  const d = deps("darwin", { plutil: ok(PLIST), open: ok("") });
  const [browser] = await openTargetViews(d);
  assert.equal(browser?.unavailable, null);
  assert.equal(browser?.detail, "Chrome");
  assert.deepEqual(d.calls[0], {
    bin: "plutil",
    args: [
      "-convert", "json", "-o", "-",
      "/Users/tester/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist",
    ],
  });

  const outcome = await openFile("browser", "/repo/docs/index.html", d);
  assert.equal(outcome.ok, true);
  assert.deepEqual(d.calls.at(-1), {
    bin: "open",
    args: ["-b", "com.google.chrome", "/repo/docs/index.html"],
  });
});

// An unreadable preference means nobody has overridden the default - never "there is no
// browser", which is not a state a Mac can be in.
test("macOS falls back to the system browser when the preference says nothing", async () => {
  for (const answer of [
    ok("{}"),
    ok("not json at all"),
    stubRun({ stdout: "", stderr: "No such file", code: 1 }),
  ]) {
    const d = deps("darwin", { plutil: answer });
    const [browser] = await openTargetViews(d);
    assert.equal(browser?.unavailable, null);
    assert.equal(browser?.detail, "Safari");
    await openFile("browser", "/repo/notes.md", d);
    assert.deepEqual(d.calls.at(-1), { bin: "open", args: ["-b", "com.apple.Safari", "/repo/notes.md"] });
  }
});

test("Linux prefers the desktop's own answer, and names it", async () => {
  const d = deps(
    "linux",
    { "xdg-settings": ok("firefox.desktop\n") },
    ["gtk-launch", "xdg-settings", "xdg-open"],
  );
  const [browser] = await openTargetViews(d);
  assert.equal(browser?.detail, "firefox");
  await openFile("browser", "/repo/page.html", d);
  assert.deepEqual(d.calls.at(-1), { bin: "gtk-launch", args: ["firefox.desktop", "/repo/page.html"] });
});

// `xdg-open` routes by file type, so it cannot say which application will answer - and
// reporting a guess would put a name on the row that the launch may not honour.
test("Linux falls back to xdg-open, naming nothing", async () => {
  for (const [answers, installed] of [
    [{ "xdg-settings": ok("") }, ["gtk-launch", "xdg-settings", "xdg-open"]],
    [{ "xdg-settings": ok("firefox.desktop") }, ["xdg-open"]],
  ] as const) {
    const d = deps("linux", answers, [...installed]);
    const [browser] = await openTargetViews(d);
    assert.equal(browser?.unavailable, null);
    assert.equal(browser?.detail, null);
    await openFile("browser", "/repo/page.html", d);
    assert.deepEqual(d.calls.at(-1), { bin: "xdg-open", args: ["/repo/page.html"] });
  }
});

// A greyed row that will not say why is a support ticket; each refusal names the fix.
test("a machine with no launcher refuses with a reason, and launches nothing", async () => {
  const d = deps("linux", {}, []);
  const [browser] = await openTargetViews(d);
  assert.match(browser?.unavailable ?? "", /xdg-utils/);
  const outcome = await openFile("browser", "/repo/page.html", d);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, 409);
  assert.deepEqual(d.calls, [], "a refused target must not spawn anything");
});

test("an unsupported platform refuses by name rather than guessing a command", async () => {
  const d = deps("win32", {});
  const [browser] = await openTargetViews(d);
  assert.match(browser?.unavailable ?? "", /win32/);
  assert.equal(browser?.detail, null);
  assert.deepEqual(d.calls, []);
});

test("a launcher that exits non-zero reports what it said", async () => {
  const d = deps("darwin", {
    plutil: ok(PLIST),
    open: stubRun({ stdout: "", stderr: "Unable to find application\n", code: 1 }),
  });
  const outcome = await openFile("browser", "/repo/page.html", d);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, 502);
  assert.equal(outcome.error, "Unable to find application");
});

// `run`'s `outcomeUnknown` is the narrowing flag that matters most here: the child died
// without reporting, so the browser may be opening right now. Calling that "failed" sends
// the human hunting a bug in a launch that worked.
test("a launcher that never reported back is not called a failure", async () => {
  const d = deps("darwin", {
    plutil: ok(PLIST),
    open: { stdout: "", stderr: "", code: 1, outcomeUnknown: true, overflowed: false },
  });
  const outcome = await openFile("browser", "/repo/page.html", d);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, 504);
  assert.match(outcome.error ?? "", /may still be opening/);
});

// One target throwing must not take the whole menu down with it: the other rows are still
// perfectly answerable, and a menu that renders nothing reads as "there is nowhere to go".
test("a target that throws becomes a refusal, not a broken menu", async () => {
  const exploding: OpenDeps = {
    ...deps("darwin", {}),
    run: () => { throw new Error("plutil vanished"); },
  };
  const views = await openTargetViews(exploding);
  assert.equal(views.length, OPEN_TARGET_IDS.length);
  assert.equal(views[0]?.unavailable, "plutil vanished");
});
