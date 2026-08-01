// The environment a Workflow check command inherits, minus the things that would let a
// branch-authored build reach back into the daemon.
//
// THIS IS NOT A SANDBOX AND MUST NEVER BE DESCRIBED AS ONE. The command still runs with the
// daemon's own filesystem authority, its own network access and its own user. What this
// removes is the daemon's ADMISSION credential from the environment, so a check does not get
// handed one by accident. A build that wants to do damage with the authority it already has is
// outside what any function in this repository can prevent; saying so plainly is more useful
// than implying a boundary that is not here.
//
// ## What it explicitly does NOT do: hide where the daemon keeps its state
//
// The token file lives under the state directory, which defaults to a folder in the invoking
// user's home. A check runs as that user, so it can read it - and no amount of environment
// editing changes that. Measured rather than assumed, because it is the obvious thing to reach
// for: deleting `HOME` from the child's environment still leaves `os.homedir()` resolving the
// real home through `getpwuid`, and substituting a decoy `HOME` is defeated by
// `os.userInfo().homedir`, which ignores `$HOME` altogether. In both cases the token remains
// readable. Meanwhile `HOME` is load-bearing for npm, cargo, git and ssh, so dropping it buys
// nothing and breaks nearly every real build.
//
// The **allowlist** is the boundary here, not this function. A repository has to be authorised
// before any of its commands run at all.
//
// ## Deny-list, and the choice is deliberate
//
// An allow-list is the stronger shape for a sandbox and the wrong shape for this. A build
// reads an enormous, open-ended set of ordinary variables - `CC`, `CARGO_HOME`, `JAVA_HOME`,
// `npm_config_*`, `DOCKER_HOST`, whatever a repository's own tooling invented last week -
// and an allow-list that misses one does not produce a security incident, it produces a
// build that fails in a way nobody can explain from the failure text. A deny-list that
// misses one leaks a variable to code the operator already chose to run in their own
// checkout with their own authority.
//
// Given the threat model above, the second cost is the smaller one, so this is a deny-list
// with a broad NAME-SHAPE rule rather than an enumeration. The rule is what makes it hold up
// over time: it catches the credential the next tool invents without anyone editing this
// file.

/**
 * The three spellings of the variable that OVERRIDES the daemon's state directory.
 *
 * `src/shared/harness-runtime.mjs` owns the fallback chain (`envVar("HOME")` reads
 * `MISSION_HOME`, then `FLEET_HOME`, then `HARNESS_HOME`), and that directory is where the
 * auth token file lives.
 *
 * Removed because an OVERRIDE is the one part of the location that is not otherwise
 * derivable: an operator who moved their state dir somewhere unusual has not published that
 * choice anywhere else, and passing it on would hand it over for free. The DEFAULT location is
 * a different matter and is not hidden by this or by anything else - see the module comment.
 * So this narrows an incidental disclosure; it is not a barrier.
 *
 * None of them is credential-SHAPED, which is exactly why they need naming: a name-shape
 * rule alone would keep every one of them.
 */
const STATE_DIR_ALIASES = ["MISSION_HOME", "FLEET_HOME", "HARNESS_HOME"] as const;

/**
 * Name segments that mean "this is a credential".
 *
 * Matched as whole SEGMENTS of the name, splitting on non-alphanumerics and on camelCase
 * boundaries, so `AWS_SECRET_ACCESS_KEY` and `githubToken` are both caught while `KEYCHAIN`,
 * `KEYBOARD_LAYOUT` and `PATH` are not. Segment matching rather than substring matching is
 * the whole reason `key` can be on this list at all.
 */
const CREDENTIAL_SEGMENTS = new Set([
  "token",
  "tokens",
  "secret",
  "secrets",
  "password",
  "passwd",
  "passphrase",
  "credential",
  "credentials",
  "key",
  "keys",
  "apikey",
]);

/**
 * The same words as unseparated suffixes, for the names that run them together.
 *
 * `GITHUBTOKEN` has one segment and would survive the segment rule. `key` is deliberately
 * ABSENT here and only ever matched as a segment: as a bare suffix it would take `MONKEY`,
 * `TURKEY` and anything else ending in those three letters, which is the kind of
 * false positive that breaks a build with no legible reason.
 */
const CREDENTIAL_SUFFIX = /(token|secret|password|passwd|passphrase|credentials?|apikey)$/;


function nameSegments(name: string): string[] {
  return name
    // `githubToken` -> `github_Token`, so camelCase names segment like snake_case ones.
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Whether this variable's NAME says it carries a credential. */
export function credentialShapedName(name: string): boolean {
  const lower = name.toLowerCase();
  if (CREDENTIAL_SUFFIX.test(lower)) return true;
  return nameSegments(name).some((segment) => CREDENTIAL_SEGMENTS.has(segment));
}

/**
 * The environment for one check command.
 *
 * Pure: it reads nothing, mints nothing, and never mutates the object it is handed - the
 * daemon's own `process.env` is passed in by its one caller and must come back untouched.
 *
 * `daemonToken` is the value from `readToken()`, passed in rather than read here so this
 * stays a function a table-driven test can exhaust. Passing `""` (no token minted yet) is
 * legitimate and simply skips the value rule.
 *
 * Everything not named below SURVIVES, which is what makes a build work: `PATH`, `HOME`,
 * `SHELL`, `LANG` and the `LC_*` family, `TMPDIR`, `TZ`, and the proxy variables all pass
 * through, because a check that cannot find its own toolchain is a check that fails for a
 * reason having nothing to do with the change under review.
 */
export function scrubCheckEnv(
  env: NodeJS.ProcessEnv,
  daemonToken: string,
): NodeJS.ProcessEnv {
  const secret = daemonToken.trim();
  // ANY non-empty token is scrubbed, with no length exception. There used to be a 16-character
  // floor here, on the reasoning that the daemon mints 48 hex characters so anything shorter
  // was a placeholder - but that reasoning protected the wrong side. It turned "the token is
  // unusually short" into "the token is not removed at all", so a token like `short-token`
  // sitting in an ordinarily-named variable travelled straight through to branch code.
  //
  // The empty string is still excluded, and that exclusion is doing real work rather than
  // being the same rule restated: `"".includes` is true of every value, so an unminted token
  // would otherwise scrub the entire environment and leave a build failing for a reason nobody
  // could diagnose. Between those two, the ordering is deliberate - a token short enough to
  // collide with ordinary values is a token that must not leak either, so this errs toward
  // dropping a variable rather than toward disclosing a credential.
  const scrubValues = secret.length > 0;
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if ((STATE_DIR_ALIASES as readonly string[]).includes(name)) continue;
    if (credentialShapedName(name)) continue;
    // The VALUE rule, which is the only one that removes the daemon's own token by identity
    // rather than by hoping whoever exported it chose a credential-shaped name. `includes`
    // rather than equality because the token travels inside composed values - an
    // `Authorization: Bearer <token>` header, a URL with it in the query - and a variable
    // that quotes it is as good as one that is it.
    if (scrubValues && value.includes(secret)) continue;
    out[name] = value;
  }
  return out;
}
