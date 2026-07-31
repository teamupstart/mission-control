import test from "node:test";
import assert from "node:assert/strict";

import { credentialShapedName, scrubCheckEnv } from "../src/server/workflows/check-env.ts";

// What a check command is allowed to see.
//
// Table-driven because the rule is a NAME SHAPE, not an enumeration: the interesting cases are
// the ones nobody wrote down - the credential a future tool invents, and the ordinary variable
// whose name merely looks like one. Both directions are asserted, because a deny-list that is
// too eager breaks a build with no legible reason and a deny-list that is too shy leaks.

/** A realistic minted token: 24 random bytes as hex, which is what `ensureToken` produces. */
const TOKEN = "4f3c2b1a9e8d7c6b5a4938271605f4e3d2c1b0a998877665";

const CASES: ReadonlyArray<{ name: string; value?: string; kept: boolean; why: string }> = [
  // --- kept: a build has to be able to find and run its own toolchain -----------------
  { name: "PATH", kept: true, why: "without it nothing resolves at all" },
  { name: "HOME", kept: true, why: "npm, cargo and git all read per-user config from it" },
  { name: "SHELL", kept: true, why: "test runners that shell out read it" },
  { name: "LANG", kept: true, why: "locale changes compiler and test output" },
  { name: "LC_ALL", kept: true, why: "same family as LANG" },
  { name: "TMPDIR", kept: true, why: "a build with no temp dir fails in confusing ways" },
  { name: "TZ", kept: true, why: "date-sensitive tests depend on it" },
  { name: "HTTP_PROXY", kept: true, why: "a dependency fetch behind a proxy needs it" },
  { name: "HTTPS_PROXY", kept: true, why: "same" },
  { name: "NO_PROXY", kept: true, why: "same" },
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

  for (const c of CASES) {
    assert.equal(
      Object.hasOwn(scrubbed, c.name),
      c.kept,
      `${c.name} should be ${c.kept ? "kept" : "dropped"}: ${c.why}`,
    );
  }
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
  assert.deepEqual(Object.keys(scrubbed), ["KEPT"]);
});

test("an unminted token scrubs no values, rather than every value", () => {
  // `readToken()` answers "" before the daemon has ever booted. Without the length floor,
  // every value would contain the empty string and the command would run with no environment
  // at all - a build failing for a reason nobody could diagnose.
  const scrubbed = scrubCheckEnv({ PATH: "/usr/bin", HOME: "/home/me" }, "");
  assert.deepEqual(scrubbed, { PATH: "/usr/bin", HOME: "/home/me" });
});

test("the input environment is never mutated", () => {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", GITHUB_TOKEN: "t", MISSION_HOME: "/h" };
  const before = { ...env };
  scrubCheckEnv(env, TOKEN);
  assert.deepEqual(env, before, "the daemon's own process.env is passed in and must come back whole");
});

test("an undefined value is dropped rather than passed through as undefined", () => {
  const scrubbed = scrubCheckEnv({ PATH: "/usr/bin", EMPTY: undefined }, TOKEN);
  assert.deepEqual(scrubbed, { PATH: "/usr/bin" });
});

test("credentialShapedName is the name rule on its own", () => {
  assert.equal(credentialShapedName("AWS_SECRET_ACCESS_KEY"), true);
  assert.equal(credentialShapedName("PATH"), false);
  // The one that matters most: a variable this repository has never heard of.
  assert.equal(credentialShapedName("SOME_FUTURE_TOOL_TOKEN"), true);
});
