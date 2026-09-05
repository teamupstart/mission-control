// The update log's two promises, asserted against a real file.
//
// `sanitizeLogLine` was already unit-tested as a function. What was not tested is that the
// writer actually applies it, or that the log cannot grow without bound - both of which are
// properties of the file on disk in an operator's state directory, not of a string helper.
// Extracting this module out of `updater.ts` is what made them testable in one place; a
// staged build now writes here too.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRotatingUpdateLogger, sanitizeLogLine } from "../src/main/update-log.ts";
import { bundleShortVersion, plistShortVersion } from "../src/main/bundle-version.ts";
import { sanitizeDiagnostic } from "../scripts/apply-update.mjs";
import { plistVersion } from "../scripts/app-bundle-swap.mjs";

/**
 * Lines a real staged build produces, each carrying something that must not reach the log.
 *
 * Every one of these is npm, git, or electron-builder's own wording. The registry cases are
 * the ones a review found reaching `update.log` in full: a path rule anchored on a preceding
 * space or quote never fires on the `//` after a scheme's colon, so nothing redacted them.
 */
const LEAKY_LINES: ReadonlyArray<{ line: string; secrets: string[]; keeps: RegExp }> = [
  {
    line: "npm error request to https://registry.npmjs.org/lodash failed, reason: getaddrinfo ENOTFOUND",
    secrets: ["registry.npmjs.org", "https://"],
    keeps: /npm error request to <url> failed/,
  },
  {
    line: "npm warn registry https://deploy:hunter2@registry.internal.example.dev/ returned 403",
    secrets: ["hunter2", "registry.internal.example.dev", "deploy:"],
    keeps: /npm warn registry <url> returned 403/,
  },
  {
    line: "npm error code E401 https://npm.pkg.github.com/@acme%2fui - Unauthorized",
    secrets: ["npm.pkg.github.com"],
    keeps: /npm error code E401 <url> - Unauthorized/,
  },
  {
    line: "fatal: unable to access 'https://github.com/teamupstart/mission-control.git/': 403",
    secrets: ["github.com", "teamupstart"],
    keeps: /unable to access '<url>': 403/,
  },
  {
    line: "cloning ssh://git@github.com/teamupstart/mission-control.git into /Users/someone/.mission-control/app-src",
    secrets: ["github.com", "/Users/someone"],
    keeps: /cloning <url> into <path>/,
  },
  {
    // The scp-style remote, which carries no scheme at all.
    line: "remote: git@github.com:teamupstart/mission-control.git",
    secrets: ["github.com", "teamupstart"],
    keeps: /remote: <url>/,
  },
  {
    line: "git://legacy.example.com/repo.git is unreachable",
    secrets: ["legacy.example.com"],
    keeps: /<url> is unreachable/,
  },
  {
    line: "electron-builder  downloading  url=https://github.com/electron/electron/releases/download/v43.0.0/electron.zip",
    secrets: ["github.com/electron"],
    keeps: /electron-builder\s+downloading\s+url=<url>/,
  },
  {
    line: "npm error path /Users/someone/.mission-control/app-src/node_modules",
    secrets: ["/Users/someone"],
    keeps: /npm error path <path>/,
  },
  {
    line: "npm notice Authorization: Bearer gho_thisisnotarealtoken",
    secrets: ["gho_thisisnotarealtoken", "Bearer"],
    keeps: /Authorization: <redacted>/,
  },
];

test("every line the writer appends is redacted and timestamped", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "mission-update-log-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "update.log");
  const log = createRotatingUpdateLogger(path);

  log("update handoff failed: EACCES /Users/someone/Applications/Mission Control.app");
  log("Authorization: Bearer gho_thisisnotarealtoken");
  log("token=hush at file:///private/tmp/install-app.mjs:13");

  const written = readFileSync(path, "utf8");
  assert.doesNotMatch(written, /gho_thisisnotarealtoken/);
  assert.doesNotMatch(written, /\/Users\/someone/);
  assert.doesNotMatch(written, /hush/);
  assert.doesNotMatch(written, /Bearer/);
  // What is left is still diagnosable: the failure keeps its own words.
  assert.match(written, /update handoff failed: EACCES <path>/);
  assert.match(written, /Authorization: <redacted>/);
  for (const line of written.trimEnd().split("\n")) {
    assert.match(line, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z /, line);
  }
});

test("the log rotates rather than growing without bound, keeping one previous file", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "mission-update-log-rotate-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "update.log");
  const log = createRotatingUpdateLogger(path);

  // Straight past the one-megabyte cap, which is the state a long-lived install reaches on
  // its own after enough builds.
  writeFileSync(path, "x".repeat(1_100_000), "utf8");
  log("the line that trips rotation");

  assert.ok(existsSync(`${path}.1`), "the previous log should be kept as .1");
  const current = readFileSync(path, "utf8");
  assert.match(current, /the line that trips rotation/);
  assert.ok(current.length < 1_000, "the current log should start fresh after rotation");

  // A second rotation replaces that one previous file instead of accumulating a third.
  writeFileSync(path, "y".repeat(1_100_000), "utf8");
  log("the line that trips rotation again");
  assert.ok(!existsSync(`${path}.2`), "rotation must not accumulate files");
  assert.match(readFileSync(path, "utf8"), /rotation again/);
});

test("a broken log directory never breaks the update", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "mission-update-log-broken-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // A file where the log's parent directory should be: every write fails.
  const blocked = join(directory, "not-a-directory");
  writeFileSync(blocked, "", "utf8");
  const log = createRotatingUpdateLogger(join(blocked, "update.log"));
  assert.doesNotThrow(() => log("this cannot be written anywhere"));
});

test("redaction is idempotent, so a line may pass through it twice on its way to disk", () => {
  // The staged build redacts at the boundary where a child's output arrives, and the writer
  // redacts again. That is only safe because the second pass is a no-op - and it was not:
  // the Authorization rule takes an optional second token so `Bearer <token>` goes in one
  // piece, and on its own output that second token was the next word of the diagnostic.
  // `Authorization: Bearer gho_x at line 3` lost "at" by the time it reached disk.
  for (const line of [
    "npm error path /Users/person/.mission-control/app-src/node_modules/.bin",
    "Authorization: Bearer gho_abcdef1234",
    "token=hush at file:///private/tmp/install-app.mjs:13",
    // The regression cases: text AFTER the credential, which is where a real npm or git line
    // puts it.
    "npm notice Authorization: Bearer gho_abcdef1234 at line 3",
    "npm warn Authorization: Bearer gho_abcdef1234 and then more words",
    "fatal: Authorization: token abc failed for https://example.internal/repo.git",
    ...LEAKY_LINES.map(({ line: leaky }) => leaky),
  ]) {
    const once = sanitizeLogLine(line);
    assert.equal(sanitizeLogLine(once), once, line);
    // And the same for the helper's copy, which shares the rule set.
    assert.equal(sanitizeDiagnostic(once), once, line);
  }

  // The words after a credential are diagnostics and have to survive, twice over.
  const twice = sanitizeLogLine(
    sanitizeLogLine("npm notice Authorization: Bearer gho_abcdef1234 at line 3"),
  );
  assert.equal(twice, "npm notice Authorization: <redacted> at line 3");
  assert.doesNotMatch(twice, /gho_abcdef1234|Bearer/);
});

test("remote URLs are redacted, in both spellings of a git remote and in a registry line", () => {
  for (const { line, secrets, keeps } of LEAKY_LINES) {
    const redacted = sanitizeLogLine(line);
    for (const secret of secrets) {
      assert.ok(!redacted.includes(secret), `${secret} survived in: ${redacted}`);
    }
    // Still diagnosable: the error class and the tool's own wording remain.
    assert.match(redacted, keeps);
  }
});

test("redaction leaves ordinary build output alone, so the log stays worth reading", () => {
  // Over-redaction is its own failure: a log of `<url>` and `<path>` and nothing else cannot
  // explain a failed build. None of these carry a host, a path, or a credential.
  const untouched = [
    "npm notice New minor version of npm available! 10.0.0 -> 10.9.2",
    "npm warn deprecated inflight@1.0.6: This module is not supported",
    "npm error notarget No matching version found for @acme/ui@^1.0.0",
    "electron-builder  building  target=macOS arch=arm64",
    "added 812 packages in 41s",
    "the build/install command exited 1",
    "author reachable at someone@example.com: see the notes",
  ];
  for (const line of untouched) assert.equal(sanitizeLogLine(line), line, line);
});

test("the helper's copy of the rule set produces exactly the same output", () => {
  // `scripts/apply-update.mjs` cannot import the shared module - it is copied to a temp
  // directory with one sibling before it outlives the app bundle - so it carries a copy of
  // these rules, and its output feeds the same `update.log` plus the failure message a person
  // reads. Pinned here so the copy cannot drift; sanitizeDiagnostic additionally caps length,
  // which none of these lines reach.
  for (const { line } of LEAKY_LINES) {
    assert.equal(sanitizeDiagnostic(line), sanitizeLogLine(line), line);
  }
  assert.ok(LEAKY_LINES.every(({ line }) => line.length < 500));
});


test("the main process reads a bundle's version the same way the swap script does", (t) => {
  // Two copies of the same three lines, and they have to stay one rule. Neither side can
  // import the other: `src/` must be self-contained (test/session-contracts.test.ts compiles a
  // copy of `src/` alone and proves it), and `scripts/app-bundle-swap.mjs` may import only
  // `node:` builtins because it is copied beside the detached helper and outlives the app.
  const plist = (version: string): string =>
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0">',
      "<dict>",
      "  <key>CFBundleName</key>",
      "  <string>Mission Control</string>",
      "  <key>CFBundleShortVersionString</key>",
      `  <string>${version}</string>`,
      "  <key>CFBundleVersion</key>",
      "  <string>1</string>",
      "</dict>",
      "</plist>",
    ].join("\n");

  for (const text of [
    plist("1.2.4"),
    plist("10.0.0-rc.1"),
    plist(""),
    "<plist><dict><key>CFBundleVersion</key><string>1</string></dict></plist>",
    "not a plist at all",
    "",
  ]) {
    assert.equal(plistShortVersion(text), plistVersion(text), JSON.stringify(text.slice(0, 40)));
  }

  // And the file-reading wrapper: a real bundle, and a path with nothing at it.
  const directory = mkdtempSync(join(tmpdir(), "mission-bundle-version-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bundle = join(directory, "Mission Control.app");
  mkdirSync(join(bundle, "Contents"), { recursive: true });
  writeFileSync(join(bundle, "Contents", "Info.plist"), plist("9.9.9"), "utf8");

  assert.equal(bundleShortVersion(bundle), "9.9.9");
  assert.equal(bundleShortVersion(join(directory, "Nothing.app")), null);
});
