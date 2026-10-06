import assert from "node:assert/strict";
import test from "node:test";

import {
  detectOrganization,
  detectOrganizationState,
  detectionPermitted,
  type OrganizationDetectionDeps,
} from "../src/server/environment/organization.ts";
import { readMdmEnrollment, readPlistValue } from "../src/server/environment/macos.ts";
import { stubRun, type RunResult } from "../src/server/util/exec.ts";

// The detection rule is the approved uniqueness contract: an Upstart Mac matches, and every
// other machine - including another company's Jamf Mac, and a Mac that LEFT Upstart - does
// not. Everything here is driven through injected `run`, so no case touches this machine.

const UPSTART_ENROLLED = [
  "Enrolled via DEP: No",
  "MDM enrollment: Yes (User Approved)",
  "MDM server: https://upstart.jamfcloud.com/mdm/ServerURL",
  "",
].join("\n");

/** What `plutil -extract jss_url` would answer for a stale Upstart Jamf preference file. */
const STALE_UPSTART_JSS_URL = JSON.stringify("https://upstart.jamfcloud.com/");

function profilesOutput(lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

interface Harness {
  deps: OrganizationDetectionDeps;
  calls: Array<{ bin: string; args: string[] }>;
  warnings: string[];
}

/**
 * A detection harness for a production-shaped launch: macOS, desktop mode, no test markers,
 * and a state home outside the temp dir. `profiles` answers `answer`; `plutil` answers a stale
 * Upstart `jss_url`, so any case that reached for the Jamf preference file would match.
 */
function harness(
  answer: RunResult | (() => Promise<RunResult>),
  overrides: Partial<OrganizationDetectionDeps> = {},
): Harness {
  const calls: Harness["calls"] = [];
  const warnings: string[] = [];
  const deps: OrganizationDetectionDeps = {
    platform: "darwin",
    env: {},
    launchMode: "desktop",
    stateHome: "/Users/someone/.mission-control",
    tmpdir: "/private/var/folders/xy/T",
    realpath: async (path) => path,
    run: (async (bin: string, args: string[]) => {
      calls.push({ bin, args });
      if (bin === "plutil") return stubRun({ stdout: STALE_UPSTART_JSS_URL, stderr: "", code: 0 });
      return typeof answer === "function" ? answer() : answer;
    }) as OrganizationDetectionDeps["run"],
    warn: (message) => warnings.push(message),
    ...overrides,
  };
  return { deps, calls, warnings };
}

const ok = (stdout: string): RunResult => stubRun({ stdout, stderr: "", code: 0 });

test("a Mac actively enrolled in Upstart's Jamf tenant is recognized", async () => {
  const h = harness(ok(UPSTART_ENROLLED));
  const found = await detectOrganization(h.deps);
  assert.equal(found?.entry.id, "upstart");
  assert.equal(found?.forced, false);
  assert.equal(found?.endpoint, "https://corp-otel-staging-1.upstart.com");
  assert.equal(
    found?.evidence,
    "This Mac is enrolled in Upstart's device management (upstart.jamfcloud.com).",
  );
  assert.deepEqual(h.calls, [{ bin: "profiles", args: ["status", "-type", "enrollment"] }]);
});

test("the host matches case-insensitively and with a trailing dot", async () => {
  for (const server of [
    "https://UPSTART.JAMFCLOUD.COM/mdm/ServerURL",
    "https://upstart.jamfcloud.com./mdm/ServerURL",
  ]) {
    const h = harness(
      ok(profilesOutput(["MDM enrollment: Yes (User Approved)", `MDM server: ${server}`])),
    );
    assert.equal((await detectOrganization(h.deps))?.entry.id, "upstart", server);
  }
});

test("a Mac that is not enrolled does not match, even with a Jamf plist naming Upstart", async () => {
  const h = harness(
    ok(profilesOutput(["MDM enrollment: No", "MDM server: https://upstart.jamfcloud.com/mdm/ServerURL"])),
  );
  assert.equal(await detectOrganization(h.deps), null);
  assert.equal(h.calls.some((call) => call.bin === "plutil"), false);
});

test("other tenants, other MDMs and lookalike hosts never match", async () => {
  for (const server of [
    "https://acme.jamfcloud.com/mdm/ServerURL",
    "https://jamf.acme.example/mdm/ServerURL",
    "https://acme.kandji.io/mdm",
    "https://manage.microsoft.com/EnrollmentServer",
    "https://notupstart.jamfcloud.com/mdm/ServerURL",
    "https://upstart-sandbox.jamfcloud.com/mdm/ServerURL",
    "https://upstart.jamfcloud.com.example.com/mdm/ServerURL",
    "http://upstart.jamfcloud.com/mdm/ServerURL",
    "https://user@upstart.jamfcloud.com/mdm/ServerURL",
    "https://user:secret@upstart.jamfcloud.com/mdm/ServerURL",
    "upstart.jamfcloud.com",
  ]) {
    const h = harness(
      ok(profilesOutput(["MDM enrollment: Yes (User Approved)", `MDM server: ${server}`])),
    );
    assert.equal(await detectOrganization(h.deps), null, server);
  }
});

test("a missing or empty MDM server line fails closed and never reads the Jamf plist", async () => {
  for (const lines of [
    ["MDM enrollment: Yes (User Approved)"],
    ["MDM enrollment: Yes (User Approved)", "MDM server:"],
    ["MDM enrollment: Yes", "MDM server:    "],
  ]) {
    const h = harness(ok(profilesOutput(lines)));
    assert.equal(await detectOrganization(h.deps), null, lines.join(" | "));
    // The injected `plutil` would have answered Upstart's `jss_url`. Detection asked only
    // `profiles`, so no file - the Jamf preference file included - was consulted.
    assert.deepEqual(
      h.calls.map((call) => call.bin),
      ["profiles"],
    );
  }
});

test("another organization's active enrollment with a stale Upstart plist does not match", async () => {
  // Without its own MDM server line.
  const without = harness(ok(profilesOutput(["MDM enrollment: Yes (User Approved)"])));
  assert.equal(await detectOrganization(without.deps), null);
  // With its own MDM server line.
  const withOwn = harness(
    ok(
      profilesOutput([
        "MDM enrollment: Yes (User Approved)",
        "MDM server: https://acme.jamfcloud.com/mdm/ServerURL",
      ]),
    ),
  );
  assert.equal(await detectOrganization(withOwn.deps), null);
  for (const h of [without, withOwn]) {
    assert.equal(h.calls.some((call) => call.bin === "plutil"), false);
  }
});

test("malformed output, a failed exit, a timeout and an overflow all answer null", async () => {
  const answers: Array<RunResult | (() => Promise<RunResult>)> = [
    ok("profiles: unrecognized option\n"),
    ok(""),
    stubRun({ stdout: UPSTART_ENROLLED, stderr: "denied", code: 1 }),
    { ...stubRun({ stdout: UPSTART_ENROLLED, stderr: "", code: null }), outcomeUnknown: true },
    { ...stubRun({ stdout: UPSTART_ENROLLED, stderr: "", code: 1 }), overflowed: true },
    async () => {
      throw new Error("spawn exploded");
    },
  ];
  for (const answer of answers) {
    const h = harness(answer);
    assert.equal(await detectOrganization(h.deps), null);
  }
});

test("an unreadable profiles answer is indeterminate, while a clean non-match is definite", async () => {
  const indeterminate: Array<RunResult | (() => Promise<RunResult>)> = [
    ok("profiles: unrecognized option\n"),
    stubRun({ stdout: UPSTART_ENROLLED, stderr: "denied", code: 1 }),
    { ...stubRun({ stdout: UPSTART_ENROLLED, stderr: "", code: null }), outcomeUnknown: true },
    { ...stubRun({ stdout: UPSTART_ENROLLED, stderr: "", code: 1 }), overflowed: true },
    async () => {
      throw new Error("spawn exploded");
    },
  ];
  for (const answer of indeterminate) {
    assert.deepEqual(await detectOrganizationState(harness(answer).deps), { kind: "indeterminate" });
  }
  // An enrollment value that is neither Yes nor No is unread, not "not enrolled".
  for (const value of [
    "",
    "   ",
    "Unknown",
    "Pending",
    "N/A",
    "Yesterday",
    "Nope",
    "Yes-but-not-enrolled",
    "Yes, pending",
    "Yes (User Approved) but removed",
    "Yes ()) (",
    "No-ish",
    "No.",
  ]) {
    const lines = [`MDM enrollment: ${value}`, "MDM server: https://upstart.jamfcloud.com/mdm/ServerURL"];
    assert.deepEqual(
      await detectOrganizationState(harness(ok(profilesOutput(lines))).deps),
      { kind: "indeterminate" },
      JSON.stringify(value),
    );
  }
  for (const lines of [
    ["MDM enrollment: No"],
    ["MDM enrollment: Yes (User Approved)"],
    ["MDM enrollment: Yes (User Approved)", "MDM server: https://acme.jamfcloud.com/mdm/ServerURL"],
  ]) {
    assert.deepEqual(
      await detectOrganizationState(harness(ok(profilesOutput(lines))).deps),
      { kind: "unmatched" },
      lines.join(" | "),
    );
  }
  // The accepted forms: the bare word, or the word with one parenthesised qualifier.
  for (const value of ["Yes", "yes", "Yes (User Approved)", "YES (Device Enrollment)"]) {
    const lines = [`MDM enrollment: ${value}`, "MDM server: https://upstart.jamfcloud.com/mdm/ServerURL"];
    assert.equal(
      (await detectOrganizationState(harness(ok(profilesOutput(lines))).deps)).kind,
      "matched",
      value,
    );
  }
  for (const value of ["No", "no", "No (Removed)"]) {
    const lines = [`MDM enrollment: ${value}`, "MDM server: https://upstart.jamfcloud.com/mdm/ServerURL"];
    assert.deepEqual(
      await detectOrganizationState(harness(ok(profilesOutput(lines))).deps),
      { kind: "unmatched" },
      value,
    );
  }
  // Refusals before `profiles` is asked are definite too.
  assert.deepEqual(
    await detectOrganizationState(harness(ok(""), { platform: "linux" }).deps),
    { kind: "unmatched" },
  );
  assert.deepEqual(
    await detectOrganizationState(harness(ok(""), { launchMode: "dev" }).deps),
    { kind: "unmatched" },
  );
  assert.equal(
    (await detectOrganizationState(harness(ok(UPSTART_ENROLLED)).deps)).kind,
    "matched",
  );
});

test("detection runs nothing on any platform but macOS", async () => {
  for (const platform of ["linux", "win32", "freebsd"] as const) {
    const h = harness(ok(UPSTART_ENROLLED), { platform });
    assert.equal(await detectOrganization(h.deps), null);
    assert.deepEqual(h.calls, []);
  }
});

test("each guard refuses on its own", async () => {
  const refusals: Array<[string, Partial<OrganizationDetectionDeps>]> = [
    ["dev launch", { launchMode: "dev" }],
    ["node test runner", { env: { NODE_TEST_CONTEXT: "child-v8" } }],
    ["mission test state", { env: { MISSION_TEST_STATE: "/tmp/state" } }],
    ["state home inside the temp dir", { stateHome: "/private/var/folders/xy/T/mission-home" }],
    [
      "state home that resolves into the temp dir through a symlink",
      {
        stateHome: "/Users/someone/linked-home",
        realpath: async (path) =>
          path === "/Users/someone/linked-home" ? "/private/var/folders/xy/T/real" : path,
      },
    ],
    [
      "state home that cannot be resolved",
      {
        realpath: async (path) => {
          if (path.startsWith("/Users")) throw new Error("ENOENT");
          return path;
        },
      },
    ],
  ];
  for (const [name, overrides] of refusals) {
    const h = harness(ok(UPSTART_ENROLLED), overrides);
    assert.equal(await detectionPermitted(h.deps), false, name);
    assert.equal(await detectOrganization(h.deps), null, name);
    assert.deepEqual(h.calls, [], `${name} must not run profiles`);
  }
  // And the production-shaped launch is permitted, in both modes that serve a person.
  for (const launchMode of ["desktop", "daemon"] as const) {
    assert.equal(await detectionPermitted(harness(ok(""), { launchMode }).deps), true);
  }
});

test("MISSION_ORGANIZATION=none turns detection off, and wins over a force", async () => {
  const h = harness(ok(UPSTART_ENROLLED), { env: { MISSION_ORGANIZATION: "none" } });
  assert.equal(await detectOrganization(h.deps), null);
  assert.deepEqual(h.calls, []);
});

test("a force without a loopback endpoint is ignored and logged", async () => {
  for (const endpoint of [undefined, "", "https://corp-otel-staging-1.upstart.com", "not a url", "ftp://127.0.0.1"]) {
    const h = harness(ok(""), {
      env: {
        MISSION_ORGANIZATION: "upstart",
        ...(endpoint === undefined ? {} : { MISSION_ORGANIZATION_ENDPOINT: endpoint }),
      },
    });
    assert.equal(await detectOrganization(h.deps), null, String(endpoint));
    assert.equal(h.warnings.length, 1, String(endpoint));
    assert.match(h.warnings[0]!, /ignoring MISSION_ORGANIZATION=upstart/);
  }
  const unknown = harness(ok(""), { env: { MISSION_ORGANIZATION: "acme" } });
  assert.equal(await detectOrganization(unknown.deps), null);
  assert.match(unknown.warnings[0]!, /not a known organization/);
});

test("an ignored force falls through to ordinary detection", async () => {
  const h = harness(ok(UPSTART_ENROLLED), { env: { MISSION_ORGANIZATION: "upstart" } });
  assert.equal((await detectOrganization(h.deps))?.forced, false);
});

test("a force with a loopback endpoint is honoured, bypassing detection and every guard", async () => {
  const h = harness(ok(""), {
    platform: "linux",
    launchMode: "dev",
    env: {
      NODE_TEST_CONTEXT: "child-v8",
      MISSION_ORGANIZATION: "upstart",
      MISSION_ORGANIZATION_ENDPOINT: "http://127.0.0.1:4318",
    },
    stateHome: "/private/var/folders/xy/T/home",
  });
  const found = await detectOrganization(h.deps);
  assert.equal(found?.entry.id, "upstart");
  assert.equal(found?.forced, true);
  assert.equal(found?.endpoint, "http://127.0.0.1:4318");
  assert.deepEqual(h.calls, []);
});

test("readMdmEnrollment parses enrollment and server, bounded", async () => {
  const seen: Array<{ timeoutMs?: number; maxBuffer?: number }> = [];
  const run = (async (_bin: string, _args: string[], opts: { timeoutMs?: number; maxBuffer?: number }) => {
    seen.push(opts);
    return ok(profilesOutput(["MDM enrollment: No"]));
  }) as unknown as OrganizationDetectionDeps["run"];
  assert.deepEqual(await readMdmEnrollment({ run }), { enrolled: false, serverUrl: null });
  assert.equal(seen[0]?.timeoutMs, 2000);
  assert.equal(seen[0]?.maxBuffer, 16 * 1024);
});

test("readPlistValue extracts one key as JSON and answers null on any failure", async () => {
  const calls: string[][] = [];
  const answer = (result: RunResult) =>
    (async (_bin: string, args: string[]) => {
      calls.push(args);
      return result;
    }) as unknown as OrganizationDetectionDeps["run"];
  assert.deepEqual(
    await readPlistValue("/Library/Preferences/x.plist", "a.b", { run: answer(ok('{"c":1}')) }),
    { c: 1 },
  );
  assert.deepEqual(calls[0], ["-extract", "a.b", "json", "-o", "-", "/Library/Preferences/x.plist"]);
  assert.equal(await readPlistValue("/x", "k", { run: answer(ok("not json")) }), null);
  assert.equal(
    await readPlistValue("/x", "k", { run: answer(stubRun({ stdout: "", stderr: "No value", code: 1 })) }),
    null,
  );
});
