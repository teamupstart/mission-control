import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import { credentialShapedName, scrubCheckEnv } from "../src/server/workflows/check-env.ts";
import { executableLocator } from "../src/server/executables/locator.ts";

// What a check command is allowed to see.
//
// Table-driven because the rule is a NAME SHAPE, not an enumeration: the interesting cases are
// the ones nobody wrote down - the credential a future tool invents, and the ordinary variable
// whose name merely looks like one. Both directions are asserted, because a deny-list that is
// too eager breaks a build with no legible reason and a deny-list that is too shy leaks.

const goCache = join(tmpdir(), `mission-control-go-build-${userInfo().uid}`);
/** A realistic minted token: 24 random bytes as hex, which is what `ensureToken` produces. */
const TOKEN = "4f3c2b1a9e8d7c6b5a4938271605f4e3d2c1b0a998877665";

function canonicalPath(): string {
  return executableLocator.snapshot().path;
}

const CASES: ReadonlyArray<{ name: string; value?: string; kept: boolean; why: string }> = [
  // --- kept: a build has to be able to find and run its own toolchain -----------------
  { name: "PATH", kept: true, why: "without it nothing resolves at all" },
  // Kept DELIBERATELY, and it is the one entry here worth arguing for. HOME does point at
  // the daemon's default state directory, but removing it neither hides that directory
  // (os.homedir() falls back to getpwuid, and os.userInfo().homedir ignores $HOME outright)
  // nor leaves a usable build environment - npm, cargo, git and ssh all need it.
  { name: "HOME", kept: true, why: "npm, cargo, git and ssh read per-user config from it" },
  { name: "SHELL", kept: true, why: "test runners that shell out read it" },
  { name: "LANG", kept: true, why: "locale changes compiler and test output" },
  { name: "LC_ALL", kept: true, why: "same family as LANG" },
  { name: "TMPDIR", kept: true, why: "a build with no temp dir fails in confusing ways" },
  { name: "TZ", kept: true, why: "date-sensitive tests depend on it" },
  { name: "HTTP_PROXY", kept: true, why: "a dependency fetch behind a proxy needs it" },
  { name: "HTTPS_PROXY", kept: true, why: "same" },
  { name: "NO_PROXY", kept: true, why: "same" },
  { name: "GOCACHE", kept: true, why: "explicit cache settings survive credential scrubbing" },
  { name: "CI", kept: true, why: "ordinary build switch" },
  { name: "NODE_ENV", kept: true, why: "ordinary build switch" },
  { name: "SSH_AUTH_SOCK", kept: true, why: "a git fetch over ssh needs the agent, and the rule is deliberately not 'auth'" },
  // The false-positive traps a substring rule would fall into. `key` is only ever matched as
  // a whole segment, which is the entire reason it can be on the list at all.
  { name: "KEYCHAIN_PATH", kept: true, why: "'keychain' is not 'key'" },
  { name: "KEYBOARD_LAYOUT", kept: true, why: "'keyboard' is not 'key'" },
  { name: "MONKEY", kept: true, why: "the suffix rule deliberately omits 'key' for exactly this" },
  { name: "TURKEY_BUILD", kept: true, why: "same" },
  { name: "PASSTHROUGH", kept: true, why: "'passthrough' is not 'password'" },

  // --- dropped: the daemon's own coordinates ------------------------------------------
  { name: "MISSION_HOME", kept: false, why: "locates the state dir that holds the token file" },
  { name: "FLEET_HOME", kept: false, why: "the same variable under its previous name" },
  { name: "HARNESS_HOME", kept: false, why: "and under the name before that" },

  // --- dropped: credential-shaped names ------------------------------------------------
  { name: "GITHUB_TOKEN", kept: false, why: "suffix segment" },
  { name: "TOKEN", kept: false, why: "the whole name is the segment" },
  { name: "GITHUBTOKEN", kept: false, why: "run together, caught by the suffix rule" },
  { name: "NPM_TOKEN", kept: false, why: "suffix segment" },
  { name: "AWS_SECRET_ACCESS_KEY", kept: false, why: "two segments match" },
  { name: "MY_PASSWORD", kept: false, why: "suffix segment" },
  { name: "DB_PASSWD", kept: false, why: "the short spelling" },
  { name: "SIGNING_PASSPHRASE", kept: false, why: "suffix segment" },
  { name: "GCP_CREDENTIALS", kept: false, why: "plural form" },
  { name: "SERVICE_CREDENTIAL", kept: false, why: "singular form" },
  { name: "OPENAI_API_KEY", kept: false, why: "'key' as its own segment" },
  { name: "SSH_KEY", kept: false, why: "same" },
  { name: "APIKEY", kept: false, why: "run together" },
  { name: "githubToken", kept: false, why: "camelCase segments the same way snake_case does" },
  { name: "vault.secret", kept: false, why: "any non-alphanumeric separates segments" },
  { name: "anthropic-api-key", kept: false, why: "hyphens too" },
];

test("the scrubber keeps a build's environment and drops the daemon's", () => {
  const env: NodeJS.ProcessEnv = {};
  for (const c of CASES) env[c.name] = c.value ?? `value-of-${c.name}`;
  const scrubbed = scrubCheckEnv(env, TOKEN);

  for (const c of CASES.filter((candidate) => candidate.name !== "MISSION_HOME")) {
    assert.equal(
      Object.hasOwn(scrubbed, c.name),
      c.kept,
      `${c.name} should be ${c.kept ? "kept" : "dropped"}: ${c.why}`,
    );
  }
  assert.ok(existsSync(scrubbed.MISSION_HOME!), "normal state resolution gets a real disposable home");
  assert.notEqual(scrubbed.MISSION_HOME, env.MISSION_HOME);
  assert.equal(scrubbed.FLEET_HOME, undefined);
  assert.equal(scrubbed.HARNESS_HOME, undefined);
});

test("the daemon's token is dropped by VALUE, whatever the variable is called", () => {
  const scrubbed = scrubCheckEnv(
    {
      // A name nothing in the deny-list would ever match, carrying the token bare.
      OTEL_EXPORTER_OTLP_HEADERS: `x-mission-token=${TOKEN}`,
      INNOCENT: TOKEN,
      // And one that merely quotes it inside a larger value.
      DASHBOARD_URL: `http://127.0.0.1:7317/?token=${TOKEN}#panel`,
      KEPT: "nothing secret here",
    },
    TOKEN,
  );
  assert.deepEqual(
    Object.keys(scrubbed).filter((name) => name !== "MISSION_HOME"),
    ["KEPT", "PATH", "GOCACHE"],
  );
  assert.ok(scrubbed.PATH, "workflow checks inherit the shared executable search path");
});

test("a SHORT token is scrubbed too - there is no length exception", () => {
  // The regression: a 16-character floor used to mean an unusually short token was not removed
  // at all, so it reached branch code intact whenever it sat in a variable whose name was not
  // credential-shaped. "Shorter than expected" must never read as "safe to hand over".
  const scrubbed = scrubCheckEnv(
    { PATH: "/usr/bin", INNOCENT: "short-token", QUOTING: "Bearer short-token" },
    "short-token",
  );
  assert.deepEqual(
    { ...scrubbed, MISSION_HOME: undefined },
    { PATH: canonicalPath(), GOCACHE: goCache, MISSION_HOME: undefined },
  );

  // Down to a single character, which is where the collateral is worst and the ordering is
  // most deliberate: dropping a variable beats disclosing a credential.
  const single = scrubCheckEnv({ PATH: "/usr/bin", A: "a" }, "a");
  assert.deepEqual(
    { ...single, MISSION_HOME: undefined },
    { PATH: canonicalPath(), GOCACHE: goCache, MISSION_HOME: undefined },
  );
});

test("a whitespace-only token scrubs nothing, like an unminted one", () => {
  // It trims to empty, so it takes the empty-string path rather than matching every value that
  // happens to contain a space.
  const scrubbed = scrubCheckEnv({ PATH: "/usr/bin", SPACED: "a b" }, "   ");
  assert.deepEqual(
    { ...scrubbed, MISSION_HOME: undefined },
    { PATH: canonicalPath(), SPACED: "a b", GOCACHE: goCache, MISSION_HOME: undefined },
  );
});

test("an unminted token scrubs no values, rather than every value", () => {
  // `readToken()` answers "" before the daemon has ever booted. Without the length floor,
  // every value would contain the empty string and the command would run with no environment
  // at all - a build failing for a reason nobody could diagnose.
  const scrubbed = scrubCheckEnv({ PATH: "/usr/bin", HOME: "/home/me" }, "");
  assert.deepEqual(
    { ...scrubbed, MISSION_HOME: undefined },
    { PATH: canonicalPath(), HOME: "/home/me", GOCACHE: goCache, MISSION_HOME: undefined },
  );
});

test("the input environment is never mutated", () => {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", GITHUB_TOKEN: "t", MISSION_HOME: "/h" };
  const before = { ...env };
  scrubCheckEnv(env, TOKEN);
  assert.deepEqual(env, before, "the daemon's own process.env is passed in and must come back whole");
});

test("an undefined value is dropped rather than passed through as undefined", () => {
  const scrubbed = scrubCheckEnv({ PATH: "/usr/bin", EMPTY: undefined }, TOKEN);
  assert.deepEqual(
    { ...scrubbed, MISSION_HOME: undefined },
    { PATH: canonicalPath(), GOCACHE: goCache, MISSION_HOME: undefined },
  );
});

test("credentialShapedName is the name rule on its own", () => {
  assert.equal(credentialShapedName("AWS_SECRET_ACCESS_KEY"), true);
  assert.equal(credentialShapedName("PATH"), false);
  // The one that matters most: a variable this repository has never heard of.
  assert.equal(credentialShapedName("SOME_FUTURE_TOOL_TOKEN"), true);
});

test("every GIT_CONFIG_COUNT spelling git accepts, with all its entries, reaches a Command whole", () => {
  // Zero-padded, signed and space-led counts are all counts to git, so a complete family
  // spelled that way is an operator's real setting and must not be dropped.
  for (const [count, entries] of [["01", 1], ["007", 7], ["+1", 1], [" 1", 1]] as const) {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", HOME: "/home/me", GIT_CONFIG_COUNT: count };
    for (let i = 0; i < entries; i++) {
      env[`GIT_CONFIG_KEY_${i}`] = `mission.probe${i}`;
      env[`GIT_CONFIG_VALUE_${i}`] = `value-${i}`;
    }
    // The premise, asserted: git itself reads this family.
    assert.equal(spawnSync("git", ["config", "--get", "mission.probe0"], { env, encoding: "utf8" }).stdout.trim(), "value-0", count);
    const scrubbed = scrubCheckEnv(env, TOKEN);
    assert.equal(scrubbed.GIT_CONFIG_COUNT, count, JSON.stringify(count));
    const read = spawnSync("git", ["config", "--get", `mission.probe${entries - 1}`], { env: scrubbed, encoding: "utf8" });
    assert.equal(read.status, 0, `${JSON.stringify(count)}: ${read.stderr}`);
    assert.equal(read.stdout.trim(), `value-${entries - 1}`);
  }
});

test("git's GIT_CONFIG_COUNT family reaches a Command whole, so git can still start", () => {
  // `GIT_CONFIG_KEY_0` has a `KEY` segment and names a config key, not a credential. Dropping
  // it while COUNT survived made every git in the Command exit "missing config key".
  const family = { GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "maintenance.auto", GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "core.editor", GIT_CONFIG_VALUE_1: "true" };
  const scrubbed = scrubCheckEnv({ PATH: "/usr/bin", ...family }, TOKEN);
  for (const [name, value] of Object.entries(family)) assert.equal(scrubbed[name], value, name);
  assert.equal(credentialShapedName("GIT_CONFIG_KEY_0"), false);
  assert.equal(credentialShapedName("GIT_CONFIG_KEYS"), true, "only git's exact spelling is exempt");

  const result = spawnSync("git", ["config", "--get", "maintenance.auto"], { env: scrubbed, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "false");
});

test("an inherited GIT_CONFIG family that is already incomplete is removed whole", () => {
  // COUNT promises two entries and the environment carries one and a half: git refuses to
  // start under that ("missing config value"), whoever left it that way. The family goes; the
  // rest of the environment does not.
  for (const missing of ["GIT_CONFIG_KEY_1", "GIT_CONFIG_VALUE_1"]) {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin", HOME: "/home/me", LANG: "en_US.UTF-8",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "core.editor", GIT_CONFIG_VALUE_0: "true",
      GIT_CONFIG_KEY_1: "maintenance.auto", GIT_CONFIG_VALUE_1: "false",
    };
    delete env[missing];
    const scrubbed = scrubCheckEnv(env, TOKEN);
    for (const name of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_KEY_1", "GIT_CONFIG_VALUE_1"]) {
      assert.equal(scrubbed[name], undefined, `${name} survived although ${missing} was never there`);
    }
    assert.equal(scrubbed.HOME, "/home/me");
    assert.equal(scrubbed.LANG, "en_US.UTF-8");
    assert.equal(spawnSync("git", ["--version"], { env: scrubbed }).status, 0, "git starts under what remains");
  }
});

test("an inherited GIT_CONFIG_COUNT that git cannot read as a count removes the whole family", () => {
  // Including spellings JavaScript's `Number` reads as integers and git still refuses.
  for (const count of ["two", "-1", "1.5", "0.0", "1e0", "0x1", "\u00a01"]) {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin", HOME: "/home/me", LANG: "en_US.UTF-8",
      GIT_CONFIG_COUNT: count, GIT_CONFIG_KEY_0: "core.editor", GIT_CONFIG_VALUE_0: "true",
    };
    // The premise, asserted: any git that reads config refuses this count outright.
    assert.equal(spawnSync("git", ["config", "--list"], { env, encoding: "utf8" }).status, 128, count);
    const scrubbed = scrubCheckEnv(env, TOKEN);
    for (const name of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]) {
      assert.equal(scrubbed[name], undefined, `${name} survived a GIT_CONFIG_COUNT of ${JSON.stringify(count)}`);
    }
    assert.equal(scrubbed.HOME, "/home/me");
    assert.equal(scrubbed.LANG, "en_US.UTF-8");
    const listed = spawnSync("git", ["config", "--list"], { env: scrubbed, encoding: "utf8" });
    assert.equal(listed.status, 0, `git reads its config under what remains: ${listed.stderr}`);
  }
});

test("an oversized inherited GIT_CONFIG_COUNT is refused promptly and removes the whole family", { timeout: 5_000 }, () => {
  // Every one of these is a plain decimal that no environment could satisfy: the first
  // converts to Infinity, the second is past the safe-integer range. Each must be refused
  // quickly, with the family gone and git able to start.
  for (const count of ["9".repeat(400), "9007199254740993", "4294967296", "1000000"]) {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin", HOME: "/home/me", LANG: "en_US.UTF-8",
      GIT_CONFIG_COUNT: count, GIT_CONFIG_KEY_0: "core.editor", GIT_CONFIG_VALUE_0: "true",
    };
    const started = Date.now();
    const scrubbed = scrubCheckEnv(env, TOKEN);
    assert.ok(Date.now() - started < 1_000, `a count of ${count.length} digits was iterated`);
    for (const name of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]) {
      assert.equal(scrubbed[name], undefined, `${name} survived a count of ${count.length} digits`);
    }
    assert.equal(scrubbed.HOME, "/home/me");
    const listed = spawnSync("git", ["config", "--list"], { env: scrubbed, encoding: "utf8" });
    assert.equal(listed.status, 0, `git reads its config under what remains: ${listed.stderr}`);
  }
});

test("a GIT_CONFIG value that quotes the daemon token takes its whole family with it", () => {
  // The value rule must still win - and a COUNT left behind with a missing entry is a git that
  // refuses to start, so the family goes as one.
  const scrubbed = scrubCheckEnv({
    PATH: "/usr/bin",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${TOKEN}`,
    GIT_CONFIG_KEY_1: "core.editor", GIT_CONFIG_VALUE_1: "true",
  }, TOKEN);
  for (const name of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_KEY_1", "GIT_CONFIG_VALUE_1"]) {
    assert.equal(scrubbed[name], undefined, name);
  }
  assert.ok(!Object.values(scrubbed).some((value) => value?.includes(TOKEN)));
  assert.equal(spawnSync("git", ["--version"], { env: scrubbed }).status, 0);
});

test("a Command never inherits make's recursion state from whatever launched the daemon", () => {
  // Under `make start` or `make test` the daemon carries MAKELEVEL, so a configured `make test`
  // would speak as `make[1]:` - read as a sub-make inside a recipe that ran - and a repository
  // with no `test` target would be reported as a code failure instead of a missing Command.
  const scrubbed = scrubCheckEnv({
    PATH: "/usr/bin", HOME: "/home/me", MAKELEVEL: "1", MAKEFLAGS: " -j4 --jobserver-auth=3,4",
    MFLAGS: "-j4", MAKEOVERRIDES: "${-*-command-variables-*-}", MAKE_CONFIG: "kept",
  }, TOKEN);
  for (const name of ["MAKELEVEL", "MAKEFLAGS", "MFLAGS", "MAKEOVERRIDES"]) {
    assert.equal(scrubbed[name], undefined, name);
  }
  assert.equal(scrubbed.HOME, "/home/me");
  assert.equal(scrubbed.MAKE_CONFIG, "kept", "only make's own recursion variables are removed");
});
