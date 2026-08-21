import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PRODUCT_ISSUE_REQUIRED_LABELS,
  PRODUCT_ISSUE_STATUS_LABEL,
} from "../../src/shared/product-issues.ts";

/**
 * Stand-in `claude`, `codex` and `pi` binaries, so this suite spends nothing.
 *
 * This works because of a property of the daemon rather than a trick played on it: NOTHING
 * in `src/` talks to a model API directly. There is no `api.anthropic.com`, no
 * `ANTHROPIC_API_KEY`, and the only `BASE_URL` is the daemon's own loopback address. Every
 * model interaction is a spawned CLI subprocess whose path comes from ONE resolution chain,
 * `resolveBinSpec` in `src/server/harness/bin.ts`:
 *
 *     MISSION_<AGENT>_BIN ?? FLEET_<AGENT>_BIN ?? HARNESS_<AGENT>_BIN ?? <legacy> ?? "<agent>"
 *
 * The Agent SDK runtime goes through the same chain: `claude/sdk-deps.ts` deliberately pins
 * `pathToClaudeCodeExecutable` to the harness's own resolution rather than letting the
 * vendor package find its bundled CLI, precisely so an operator's `MISSION_CLAUDE_BIN`
 * wrapper is honoured. So there is no path - terminal or SDK - that reaches a real model
 * once these three are set.
 *
 * Each fake also RECORDS what it was handed, which turns the mock from a cost dam into an
 * assertion surface: a test can check the argv, the cwd, and the absence of inherited pane
 * env rather than only that the UI moved.
 */
export interface FakeAgents {
  /** Directory the fakes write their invocation records into. */
  recordDir: string;
  bins: { claude: string; codex: string; pi: string; cmux: string; keepAwake: string; gh: string };
}

export type FakePiCatalogMode = "success" | "failure";

/** Where the Pi fake reads its per-invocation catalog behavior. */
export function piCatalogControlPath(home: string): string {
  return join(home, "fake-pi-catalog-mode.txt");
}

/** Switch the next and later Pi catalog probes without changing daemon environment. */
export function writePiCatalogMode(home: string, mode: FakePiCatalogMode): void {
  writeFileSync(piCatalogControlPath(home), `${mode}\n`);
}

/**
 * One pull request `FAKE_GH` will report, in the shape `gh pr list --json …` prints.
 *
 * `cwd` is not a `gh` field - it is which CHECKOUT this pull request belongs to, which is how
 * the fake decides who a `pr list` is answering for. See the fake's header.
 */
export interface FakePullRequest {
  /** Absolute path of the worktree whose `gh pr list` should report this pull request. */
  cwd: string;
  url: string;
  number: number;
  state: "OPEN" | "MERGED";
  /** ISO instant. Must be after the session's work episode started, or adoption refuses it. */
  createdAt: string;
  mergedAt: string | null;
  headRefOid: string;
}

/** Where a spec scripts `FAKE_GH`'s pull requests for one daemon. */
export function ghPullRequestsPath(home: string): string {
  return join(home, "gh-prs.json");
}

/** Script what `gh` reports, for this daemon, from now on. Re-read by the fake per call. */
export function writeGhPullRequests(home: string, prs: readonly FakePullRequest[]): void {
  writeFileSync(ghPullRequestsPath(home), JSON.stringify(prs, null, 2));
}

/** The issue `FAKE_GH` says it created, and the id the daemon derives from it. */
export const FAKE_GH_ISSUE_URL = "https://github.com/acme/demo-repo/issues/123";
export const FAKE_GH_ISSUE_ID = "acme/demo-repo#123";

/**
 * How `FAKE_GH` should behave for the public product-report path.
 *
 * The product reporter asks `gh` four read-only questions before it will publish anything -
 * `--version`, `auth status`, `repo view`, and the label listing - and only then runs
 * `issue create`. A spec that wants to see the form's "GitHub CLI is not authenticated"
 * copy has to be able to fail exactly one of those and leave the rest working, which is
 * what `preflight` selects. `issueCreate` then picks between the three terminal outcomes
 * the form draws differently: a created issue, a retry-safe refusal, and an unknown result
 * that must NOT invite a retry.
 *
 * Kept separate from the pull-request script above because they answer different verbs and
 * a spec should be able to set one without disturbing the other.
 */
export interface FakeGhProductScript {
  preflight: "ok" | "gh-unavailable" | "gh-auth" | "repository" | "labels";
  issueCreate: "created" | "refused" | "unknown";
  /** The labels `repos/<target>/labels` reports. Defaults to the full required set. */
  labels?: readonly string[];
}

export const FAKE_GH_PRODUCT_ISSUE_URL = "https://github.com/acme/public-issues/issues/4242";

/** Where a spec scripts `FAKE_GH`'s product-report behavior for one daemon. */
export function ghProductScriptPath(home: string): string {
  return join(home, "gh-product-script.json");
}

export function productConsentScriptPath(home: string): string {
  return join(home, "product-consent-script.json");
}

export function productConsentBinPath(home: string): string {
  return join(home, "bin", "product-consent");
}

/**
 * Stand in for the operator answering the native publish dialog.
 *
 * In the shipped app the daemon asks the Electron shell over its utility-process port and a
 * person clicks. A daemon forked by this fixture has no shell, and deliberately CANNOT publish
 * without one - so the suite gives it something else to ask, through the launch-time
 * `MISSION_PRODUCT_ISSUE_CONSENT_CMD` seam. Setting that is not a bypass anyone gains from: it
 * lives on the daemon's own environment, and a process that can choose that has already
 * replaced the daemon. `MISSION_GH_BIN` redirects the GitHub CLI on the same reasoning.
 *
 * It records what it was asked, so a spec can assert that confirming reached a human question
 * naming the right repository rather than being decided inside the daemon.
 */
export function writeProductConsentBin(home: string): string {
  const bin = productConsentBinPath(home);
  mkdirSync(dirname(bin), { recursive: true });
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "const { readFileSync, writeFileSync, appendFileSync } = require('node:fs');",
      `const script = ${JSON.stringify(productConsentScriptPath(home))};`,
      `const log = ${JSON.stringify(join(home, "product-consent-asked.jsonl"))};`,
      "const [target, title] = process.argv.slice(2);",
      "appendFileSync(log, JSON.stringify({ target, title }) + String.fromCharCode(10));",
      "let answer = 'grant';",
      "try { answer = JSON.parse(readFileSync(script, 'utf8')).answer; } catch {}",
      "process.exit(answer === 'grant' ? 0 : 1);",
    ].join("\n") + "\n",
    { mode: 0o755 },
  );
  writeProductConsentScript(home, { answer: "grant" });
  return bin;
}

/** What the stand-in operator will say next. */
export interface FakeProductConsentScript {
  answer: "grant" | "refuse";
}

export function writeProductConsentScript(
  home: string,
  script: FakeProductConsentScript,
): void {
  writeFileSync(productConsentScriptPath(home), JSON.stringify(script, null, 2));
}

/**
 * Script the product-report path. Re-read by the fake per call, so a spec can move from a
 * blocked preflight to a working one without restarting the daemon.
 */
export function writeGhProductScript(home: string, script: FakeGhProductScript): void {
  writeFileSync(ghProductScriptPath(home), JSON.stringify(script, null, 2));
}

/**
 * The stand-in terminal backend, so a spec can watch what a click asks a terminal to run.
 *
 * cmux, not tmux, and the choice is structural. tmux availability is a question about a
 * PAIR - its sessions open detached, so `terminalTargetViews` reports it unavailable unless
 * an emulator exists to raise them, and CI has neither. cmux is the one backend whose
 * sessions need nobody's help to be seen (`attachArgv: null`), whose binary resolves
 * through an env override (`CMUX_BIN`), and whose launch is a single `new-workspace`
 * subprocess call - one fake, and the continue-in-terminal path is drivable end to end on
 * a machine with no terminal at all.
 *
 * The record it writes is the assertion surface: `--command` carries the exact shell
 * command the workspace would run, which is where a resumed conversation's argv - and the
 * permission mode it must carry - either shows up or provably does not.
 *
 * CommonJS `require`, deliberately: the file is extension-less, which Node treats as CJS,
 * and an `import` here would crash the fake at spawn time in a way that reads as a
 * launch failure rather than a broken fixture.
 */
const FAKE_CMUX = `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const dir = process.env.MC_E2E_RECORD_DIR;
if (dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, \`cmux-\${Date.now()}-\${process.pid}.json\`),
    JSON.stringify({ argv: process.argv.slice(2) }, null, 2),
  );
}
if (process.env.MC_E2E_CMUX_MODE === "unknown") {
  setInterval(() => {}, 1000);
}
`;

/**
 * The stand-in `gh`, so a spec can watch what the daemon asks GitHub to do - and so that it
 * never actually asks.
 *
 * This one is not a cost dam like the agent fakes; it is a BLAST dam. `gh issue create` files
 * an issue into a repository other people are watching, and it cannot be taken back by
 * deleting a row here - so the one place that could do it for real is redirected at this,
 * through `MISSION_GH_BIN` (see `ghBin()` in `src/server/config.ts`). Without it a suite run
 * on a developer's machine, where `gh` is signed in, would file a real issue on every pass.
 *
 * That override is whole-codebase rather than push-only, which has a consequence this fake
 * owns: the PR poller reaches it too. Its `gh pr list --json …` output is parsed as JSON, and
 * a fake that printed nothing would turn every existing spec's PR lookup into a parse error,
 * so `pr list` and `issue list` answer with an empty array - "nothing found", the state every
 * spec that does not care about a PR is already in.
 *
 * A spec that DOES care writes `MC_E2E_GH_PRS` (see `writeGhPullRequests`), and then `pr list`
 * answers for the checkout it was run in and `pr view` answers for the url it was asked about.
 * Keyed on the cwd because that is the only thing that distinguishes one repository's pull
 * request from another's here: a multi-repo task cuts the SAME branch name in every repo, so
 * `--head` cannot tell them apart, and the daemon's whole per-repo fan-out is the claim that
 * it asks in each worktree separately. Re-read on every call, so a spec can merge one pull
 * request and leave its sibling open between two polls.
 *
 * The record it writes is the assertion surface: the argv carries the title, the body and one
 * `--label` per label the source sweeps on, and the cwd is the repo the issue is filed
 * against - which is where a push aimed at the wrong repository would show up.
 *
 * CommonJS `require`, for the reason `FAKE_CMUX` gives: the file is extension-less, which Node
 * treats as CJS, and an `import` here would crash at spawn time in a way that reads as a
 * missing `gh` rather than as a broken fixture.
 */
const FAKE_GH = `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const argv = process.argv.slice(2);
const dir = process.env.MC_E2E_RECORD_DIR;
if (dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, \`gh-\${Date.now()}-\${process.pid}.json\`),
    JSON.stringify({ argv, cwd: process.cwd() }, null, 2),
  );
}
const command = argv.join(" ");
/** Whatever the spec last scripted, re-read per call. Absent or unreadable means none. */
function scriptedPrs() {
  const path = process.env.MC_E2E_GH_PRS;
  if (!path) return [];
  try {
    return JSON.parse(require("node:fs").readFileSync(path, "utf8"));
  } catch {
    return [];
  }
}
/**
 * The product-report script, re-read per call. Absent means the working default: every
 * preflight question answers yes and a create succeeds, which is what a spec that does not
 * care about this path already expects.
 */
function productScript() {
  const fallback = { preflight: "ok", issueCreate: "created" };
  const path = process.env.MC_E2E_GH_PRODUCT;
  if (!path) return fallback;
  try {
    return { ...fallback, ...JSON.parse(require("node:fs").readFileSync(path, "utf8")) };
  } catch {
    return fallback;
  }
}
const REQUIRED_LABELS = ${JSON.stringify(PRODUCT_ISSUE_REQUIRED_LABELS)};
const product = productScript();
/** Fail exactly the scripted preflight question, the way the real CLI fails it. */
function preflightRefusal(stage) {
  if (product.preflight !== stage) return false;
  process.stderr.write(stage + " unavailable\\n");
  process.exit(1);
}
if (argv[0] === "--version") {
  preflightRefusal("gh-unavailable");
  process.stdout.write("gh version 0.0.0-fake\\n");
} else if (command.startsWith("auth status")) {
  preflightRefusal("gh-auth");
  process.stdout.write("Logged in to github.com as fake\\n");
} else if (command.startsWith("repo view")) {
  preflightRefusal("repository");
  process.stdout.write((argv[2] || "acme/public-issues") + "\\n");
} else if (argv[0] === "api" && command.includes("/labels")) {
  // The --slurp form prints one array of PAGES, each a page of label objects. The daemon parses
  // exactly that shape, so the fake has to nest rather than print a flat list.
  const names = product.preflight === "labels"
    ? REQUIRED_LABELS.filter((name) => name !== "usability")
    : (product.labels || REQUIRED_LABELS);
  process.stdout.write(JSON.stringify([names.map((name) => ({ name }))]) + "\\n");
} else if (command.startsWith("issue create") && command.includes("${PRODUCT_ISSUE_STATUS_LABEL}")) {
  // A product report, distinguished from every other \`issue create\` by the fixed triage
  // label only the product reporter attaches. Task sources and the PR path keep their
  // existing behavior below.
  if (product.issueCreate === "refused") {
    process.stderr.write("could not create issue: label not found\\n");
    process.exit(1);
  } else if (product.issueCreate === "unknown") {
    // The shape the daemon must treat as "may have happened": exit 0, no URL.
    process.stdout.write("\\n");
  } else {
    process.stdout.write("${FAKE_GH_PRODUCT_ISSUE_URL}\\n");
  }
} else if (command.startsWith("issue create")) {
  // What the real gh prints on success: the URL of the issue, and nothing else.
  process.stdout.write("${FAKE_GH_ISSUE_URL}\\n");
} else if (command.startsWith("pr view")) {
  const url = argv[2];
  const found = scriptedPrs().find((pr) => pr.url === url);
  if (found) process.stdout.write(JSON.stringify({ state: found.state, mergedAt: found.mergedAt ?? null }) + "\\n");
} else if (command.startsWith("pr list")) {
  const here = scriptedPrs().filter((pr) => pr.cwd === process.cwd());
  process.stdout.write(JSON.stringify(here) + "\\n");
} else if (command.startsWith("issue list")) {
  process.stdout.write("[]\\n");
}
`;

/**
 * The stand-in `caffeinate`, so the keep-awake spec can drive the real manager, routes
 * and SSE path without ever touching host power settings - `MISSION_KEEP_AWAKE_BIN`
 * makes this the provider under test on any platform, which is how Linux CI runs it.
 *
 * It records its argv at start (the assertion surface: `-i -w <daemon PID>` either
 * shows up exactly or provably does not) and an exit record when it goes, then behaves
 * like the real thing: it stays alive until SIGTERM, and it honours `-w <pid>` by
 * exiting when the watched process disappears - which is what keeps a SIGKILLed test
 * daemon from leaking an immortal fake into the operator's process table.
 *
 * CommonJS `require` for the reason FAKE_CMUX gives: the file is extension-less, which
 * Node treats as CJS.
 */
const FAKE_KEEP_AWAKE = `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const dir = process.env.MC_E2E_RECORD_DIR;
const record = (kind, body) => {
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, \`keep-awake-\${process.pid}-\${kind}.json\`),
    JSON.stringify(body, null, 2),
  );
};
record("start", { argv: process.argv.slice(2), pid: process.pid });
const leave = (reason) => {
  record("exit", { reason });
  process.exit(0);
};
process.on("SIGTERM", () => leave("SIGTERM"));
const at = process.argv.indexOf("-w");
const watched = at >= 0 ? Number(process.argv[at + 1]) : null;
setInterval(() => {
  if (watched === null) return;
  try {
    process.kill(watched, 0);
  } catch {
    leave("watched-pid-gone");
  }
}, 250);
`;

/**
 * Write the three fakes into `home` and return their paths.
 *
 * The claude fake is COPIED to an extension-less path rather than symlinked or run in
 * place, because the vendored Agent SDK spawns `node <path>` for anything ending in
 * `.js`/`.mjs`/`.ts`/`.jsx`/`.tsx` and executes everything else directly. Extension-less
 * plus the file's own shebang is the combination that survives that branch.
 */
export function writeFakeAgents(home: string): FakeAgents {
  const binDir = join(home, "fake-bin");
  const recordDir = join(home, "agent-records");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(recordDir, { recursive: true });

  const claude = join(binDir, "fake-claude");
  copyFileSync(fileURLToPath(new URL("./fake-claude.mjs", import.meta.url)), claude);
  chmodSync(claude, 0o755);

  // Copied to an extension-less path for the same reason as its sibling above, though only
  // Claude's vendored SDK actually sniffs the extension: `spawnAppServer` execs the resolved
  // path directly, so the shebang is what picks the interpreter either way.
  const codex = join(binDir, "fake-codex");
  copyFileSync(fileURLToPath(new URL("./fake-codex.mjs", import.meta.url)), codex);
  chmodSync(codex, 0o755);

  const pi = join(binDir, "fake-pi");
  copyFileSync(fileURLToPath(new URL("./fake-pi.mjs", import.meta.url)), pi);
  chmodSync(pi, 0o755);
  writePiCatalogMode(home, "success");

  const cmux = join(binDir, "fake-cmux");
  writeFileSync(cmux, FAKE_CMUX);
  chmodSync(cmux, 0o755);

  const keepAwake = join(binDir, "fake-caffeinate");
  writeFileSync(keepAwake, FAKE_KEEP_AWAKE);
  chmodSync(keepAwake, 0o755);

  const gh = join(binDir, "fake-gh");
  writeFileSync(gh, FAKE_GH);
  chmodSync(gh, 0o755);

  return { recordDir, bins: { claude, codex, pi, cmux, keepAwake, gh } };
}
