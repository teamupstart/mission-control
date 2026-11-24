import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import ts from "typescript";

import { originRepositoryShell } from "../src/shared/pr-command.mjs";

// The regression guard for the SAML refusal.
//
// A `gh` call that names no repository is resolved through gh's base-repository choice, which
// outside a terminal prefers a remote called `upstream`. On a fork of an organization that
// enforces SAML SSO that is the parent, and the call is refused. Every fix so far was local to
// one call site, so this file makes the choice a test failure instead of a code review catch:
// every `gh` call in the daemon, the app and the scripts is classified below, and every line of
// agent instructions that names a `gh` command is held to naming its repository.

const ROOT = join(import.meta.dirname, "..");

// ---- part 1: the call-site inventory ----

/**
 * How a call tells gh which repository it means.
 *
 * - `resolver`: `--repo` from `checkoutGitHubRepository`, the shared
 *   resolver (gh default pin, else origin; never gh's own choice).
 * - `url`: a GitHub URL names the repository.
 * - `explicit`: the repository is spelled out - a `repos/<owner>/<repo>` REST path, GraphQL
 *   `owner`/`name` variables, or `--repo` with a configured or canonical repository.
 * - `node-id`: a GraphQL mutation on a global node id, which names one object and no repository
 *   gh could choose. Restricted like `none` (`NODE_ID_ARGV`): it names no repository, so each
 *   call that uses it is listed there and called out in the pull request that adds it.
 * - `none`: no repository at all. Only `auth status`, `--version` and `api user` may say so
 *   (`NO_REPOSITORY_ARGV`); any other call that names no repository is fixed, not classified.
 */
type Targeting = "resolver" | "url" | "explicit" | "node-id" | "none";

interface GhCall {
  /** The enclosing named function, `Class.method`, or `<module>`; `<shell>` for a shell script. */
  fn: string;
  /** The argv expression exactly as the scanner reads it (`normalize`), or a shell command. */
  argv: string;
  how: Targeting | readonly Targeting[];
  why: string;
}

/** A `gh` binary the scanner found but cannot follow to a call: declared here or it fails. */
interface GhMention {
  fn: string;
  /** The trimmed source line the mention is on. */
  line: string;
  why: string;
}

/** The only argv a `none` row may carry. */
const NO_REPOSITORY_ARGV = new Set([
  '["--version"]',
  '["auth", "status"]',
  '["auth", "status", "--hostname", "github.com"]',
  '["api", "user", "--jq", ".login"]',
  // `scripts/install-app.mjs`: `authProbe: () => ["api", "user", "--jq", ".login"]`.
  "GH_ARGS.authProbe()",
]);

/** The only argv a `node-id` row may carry: the Inspector resolving a thread it read off the PR. */
const NODE_ID_ARGV = new Set([
  '["api", "graphql", "-f", `query=${RESOLVE_MUTATION}`, "-F", `threadId=${threadId}`]',
]);

/**
 * Every `gh` call the scanner finds, by file. A call missing here fails, and so does a row no
 * call reads any more, so this stays the exact list rather than a superset.
 */
const GH_CALLS: Readonly<Record<string, readonly GhCall[]>> = {
  "src/main/updater.ts": [
    { fn: "latestMainCommit", argv: "UPDATE_GH_ARGS.mainCommit()", how: "explicit", why: "`repos/${CANONICAL_REPO}/commits/main`, through `runGh`" },
  ],
  "src/server/github/branch-update.ts": [
    { fn: "readBranchSnapshot", argv: '["api", "graphql", "-f", `query=${QUERY}`, "-F", `owner=${pr.owner}`, "-F", `name=${pr.repo}`, "-F", `number=${pr.number}`]', how: "explicit", why: "owner and name parsed from the PR URL" },
    { fn: "update", argv: '["api", "--method", "PUT", `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/update-branch`, "-f", `expected_head_sha=${head}`]', how: "explicit", why: "owner and name parsed from the PR URL" },
  ],
  "src/server/inspector/github.ts": [
    { fn: "authenticatedLogin", argv: '["api", "user", "--jq", ".login"]', how: "none", why: "the token's own login" },
    { fn: "fetchPr", argv: '["api", "graphql", "-f", `query=${PR_QUERY(includeCodeRabbitComments)}`, "-F", `owner=${owner}`, "-F", `name=${repo}`, "-F", `number=${number}`]', how: "explicit", why: "owner and name parsed from the PR URL" },
    { fn: "fetchReviewPage", argv: '["api", "graphql", "-f", `query=${REVIEW_PAGE_QUERY}`, "-F", `owner=${owner}`, "-F", `name=${repo}`, "-F", `number=${number}`, "-F", `before=${before}`]', how: "explicit", why: "owner and name parsed from the PR URL" },
    { fn: "fetchThreadPage", argv: '["api", "graphql", "-f", `query=${THREAD_PAGE_QUERY}`, "-F", `owner=${owner}`, "-F", `name=${repo}`, "-F", `number=${number}`, "-F", `after=${after}`]', how: "explicit", why: "owner and name parsed from the PR URL" },
    { fn: "fetchIssueCommentPage", argv: '["api", "graphql", "-f", `query=${ISSUE_COMMENT_PAGE_QUERY}`, "-F", `owner=${owner}`, "-F", `name=${repo}`, "-F", `number=${number}`, "-F", `after=${after}`]', how: "explicit", why: "owner and name parsed from the PR URL" },
    { fn: "fetchPrRefs", argv: '["api", "graphql", "-f", `query=${PR_REFS_QUERY}`, "-F", `owner=${owner}`, "-F", `name=${repo}`, "-F", `number=${number}`]', how: "explicit", why: "owner and name parsed from the PR URL" },
    { fn: "isAncestor", argv: '["api", `repos/${owner}/${repo}/compare/${ancestor}...${head}`, "--jq", ".status"]', how: "explicit", why: "owner and name parsed from the PR URL" },
    { fn: "compareCommits", argv: `["api", \`repos/\${owner}/\${repo}/compare/\${base}...\${head}\`, "--jq", '.status + " " + (.behind_by | tostring)']`, how: "explicit", why: "owner and name parsed from the PR URL" },
    { fn: "mergeBase", argv: '["api", `repos/${owner}/${repo}/compare/${base}...${head}`, "--jq", ".merge_base_commit.sha"]', how: "explicit", why: "owner and name parsed from the PR URL" },
    { fn: "retargetPr", argv: '["api", "--method", "PATCH", `repos/${owner}/${repo}/pulls/${number}`, "--input", "-"]', how: "explicit", why: "owner and name parsed from the PR URL" },
    { fn: "fetchDiff", argv: '["api", `repos/${owner}/${repo}/pulls/${number}`, "-H", "Accept: application/vnd.github.v3.diff"]', how: "explicit", why: "owner and name parsed from the PR URL" },
    { fn: "fetchHeadSha", argv: '["api", `repos/${owner}/${repo}/pulls/${number}`, "--jq", ".head.sha"]', how: "explicit", why: "owner and name parsed from the PR URL" },
    { fn: "postReview", argv: '["api", "--method", "POST", `repos/${owner}/${repo}/pulls/${number}/reviews`, "--input", "-"]', how: "explicit", why: "owner and name parsed from the PR URL" },
    { fn: "replyToComment", argv: '["api", "--method", "POST", `repos/${owner}/${repo}/pulls/${number}/comments/${commentId}/replies`, "--input", "-"]', how: "explicit", why: "owner and name parsed from the PR URL" },
    { fn: "resolveThread", argv: '["api", "graphql", "-f", `query=${RESOLVE_MUTATION}`, "-F", `threadId=${threadId}`]', how: "node-id", why: "the review thread's global node id, read from that PR's own snapshot" },
    { fn: "mergePr", argv: '["api", "--method", "PUT", `repos/${owner}/${repo}/pulls/${number}/merge`, "--input", "-"]', how: "explicit", why: "owner and name parsed from the PR URL" },
  ],
  "src/server/pr.ts": [
    { fn: "queryPr", argv: "prListArgs(branch, repo.repo, search)", how: "resolver", why: "the episode search; `--repo` from `checkoutGitHubRepository`, no gh call when it fails" },
    { fn: "queryPr", argv: "prListArgs(branch, repo.repo)", how: "resolver", why: "`--repo` from `checkoutGitHubRepository`; no gh call when it fails" },
    { fn: "queryPrUrl", argv: '["pr", "view", url, "--json", "state,mergedAt"]', how: "url", why: "the adopted PR's URL" },
    { fn: "queryHeadChecks", argv: '["api", "graphql", "-f", `query=${HEAD_CHECKS_QUERY}`, "-F", `owner=${parts[1]}`, "-F", `name=${parts[2]}`, "-F", `number=${parts[3]}`]', how: "explicit", why: "owner and name parsed from the PR URL" },
  ],
  "src/server/product-issues.ts": [
    { fn: "ProductIssueService.preflight", argv: '["--version"]', how: "none", why: "version probe" },
    { fn: "ProductIssueService.preflight", argv: '["auth", "status"]', how: "none", why: "authentication probe" },
    { fn: "ProductIssueService.preflight", argv: '["repo", "view", target.repo, "--json", "nameWithOwner", "--jq", ".nameWithOwner"]', how: "explicit", why: "the configured product-issues repository" },
    { fn: "ProductIssueService.preflight", argv: '["api", "--paginate", "--slurp", `repos/${target.repo}/labels?per_page=100`]', how: "explicit", why: "the configured product-issues repository" },
    { fn: "ProductIssueService.submit", argv: '["--version"]', how: "none", why: "attachment support probe" },
    { fn: "ProductIssueService.submit", argv: "productIssueCreateArgs(target.repo, draft, labels, attachmentArgs)", how: "explicit", why: "`--repo` with the configured product-issues repository" },
  ],
  "src/server/setup/index.ts": [
    { fn: "ghCliStatus", argv: '["--version"]', how: "none", why: "version probe, run on the path `present` resolved" },
    { fn: "ghAuthStatus", argv: '["auth", "status", "--hostname", "github.com"]', how: "none", why: "authentication probe" },
  ],
  "src/server/task-sources/github-issues.ts": [
    // Every `argsFor` names its repository: the sweep and preflight pass
    // `ghIssueListArgs(cfg, target.repo, fields)` from `sourceRepository` (Repository, else
    // `checkoutGitHubRepository`), and the linked read passes `ghLinkedIssueArgs`, whose
    // `issue view <url>` throws for anything but the item's own issue URL.
    { fn: "runGhJson", argv: "argsFor(JSON_FIELDS)", how: ["resolver", "url"], why: "each caller's `argsFor` names the repository, as above" },
    { fn: "runGhJson", argv: "argsFor(BASE_JSON_FIELDS)", how: ["resolver", "url"], why: "the older-gh retry of the same read" },
    { fn: "preflight", argv: '["auth", "status"]', how: "none", why: "authentication probe" },
    { fn: "push", argv: "ghIssueCreateArgs(cfg, draft, target.repo)", how: "resolver", why: "`sourceRepository`, and the created URL is checked against it" },
    { fn: "annotate", argv: "ghIssueCommentArgs(ready.cfg, notice)", how: ["explicit", "url", "resolver"], why: "`issueTargetFor`: the item's `owner/repo#n` id, else its URL, else the resolved Repository (`writebackConfig`)" },
    { fn: "resolve", argv: "ghIssueCloseArgs(ready.cfg, notice)", how: ["explicit", "url", "resolver"], why: "`issueTargetFor`, as the comment" },
  ],
  "scripts/distribution-input.mjs": [
    { fn: "read", argv: "['api', '--hostname', 'github.com', `repos/${BINARY_REPO}/${endpoint}`]", how: "explicit", why: "`BINARY_REPO`, the canonical repository distribution publishes from" },
  ],
  "scripts/install-app.mjs": [
    { fn: "newestStableRelease", argv: "GH_ARGS.releaseList(repo)", how: "explicit", why: "`--repo`, defaulting to `CANONICAL_REPO`" },
    { fn: "ghCredentialProblem", argv: '["--version"]', how: "none", why: "version probe" },
    { fn: "ghCredentialProblem", argv: "GH_ARGS.authProbe()", how: "none", why: "active-credential probe (`gh api user`)" },
  ],
  // The binary bootstrap and its template: the words of `download`'s failure message, which the
  // shell reader takes for a command. The real call goes through `$mission_gh` (a mention below).
  "scripts/install-bootstrap.sh": [
    { fn: "<shell>", argv: "gh authentication and connectivity", how: "explicit", why: "not a call: prose in `fail`; `download` runs `api --hostname github.com` on a `repos/@REPO@/...` endpoint" },
    { fn: "<shell>", argv: "gh release list --repo @REPO@", how: "explicit", why: "not a call: a hint in a release-selection failure message, naming the release repository" },
    { fn: "<shell>", argv: "gh release list --repo @REPO@", how: "explicit", why: "not a call: a hint in a release-selection failure message, naming the release repository" },
    { fn: "<shell>", argv: "gh release list --repo @REPO@", how: "explicit", why: "not a call: a hint in a release-selection failure message, naming the release repository" },
    { fn: "<shell>", argv: "gh release list --repo @REPO@", how: "explicit", why: "not a call: a hint in a release-selection failure message, naming the release repository" },
  ],
  "scripts/install.sh": [
    { fn: "<shell>", argv: "gh authentication and connectivity", how: "explicit", why: "not a call: prose in `fail`; `download` runs `api --hostname github.com` on a `repos/teamupstart/mission-control/...` endpoint" },
    { fn: "<shell>", argv: "gh release list --repo teamupstart/mission-control", how: "explicit", why: "not a call: a hint in a release-selection failure message, naming the release repository" },
    { fn: "<shell>", argv: "gh release list --repo teamupstart/mission-control", how: "explicit", why: "not a call: a hint in a release-selection failure message, naming the release repository" },
    { fn: "<shell>", argv: "gh release list --repo teamupstart/mission-control", how: "explicit", why: "not a call: a hint in a release-selection failure message, naming the release repository" },
    { fn: "<shell>", argv: "gh release list --repo teamupstart/mission-control", how: "explicit", why: "not a call: a hint in a release-selection failure message, naming the release repository" },
  ],
};

/** Each `gh` binary the scanner cannot follow to a call, and why it runs nothing unclassified. */
const GH_MENTIONS: Readonly<Record<string, readonly GhMention[]>> = {
  "src/main/updater.ts": [
    { fn: "runGh", line: 'env: {...executable.env, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", GH_DEBUG: "", DEBUG: ""},', why: "the located gh's child environment, handed to the same `execFile` that runs it" },
    { fn: "latestRelease", line: "latestRelease: () => latestStableBinary(runGh, options.currentVersion()),", why: "hands `runGh` to `update-binary-release.ts`, whose every call is `api` on `repos/${BINARY_REPO}/...`" },
    { fn: "binaryForCommit", line: "binaryForCommit: (commit) => binaryForCommit(runGh, commit),", why: "hands `runGh` to `update-binary-release.ts`, whose every call is `api` on `repos/${BINARY_REPO}/...`" },
    { fn: "latestReadyAlpha", line: "latestReadyAlpha: (installedCommit, headCommit) => latestReadyAlpha(runGh, installedCommit, headCommit),", why: "hands `runGh` to `update-binary-release.ts`, whose every call is `api` on `repos/${BINARY_REPO}/...`" },
    { fn: "stage", line: "stateDirectory: options.stateDirectory, gh: gh.path, env: gh.env, log});", why: "hands the located gh to `update-binary-download.ts`, which runs `api` on `repos/${BINARY_REPO}/releases/assets/<id>`" },
  ],
  "scripts/install-bootstrap.sh": [
    { fn: "<shell>", line: "mission_gh=$(command -v gh) || fail 'GitHub CLI (gh) is required for authenticated downloads. Install its native binary or download the signed DMG from GitHub Releases.'", why: "locates gh; its one call, in `download`, is `api --hostname github.com` on a `repos/@REPO@/...` endpoint" },
  ],
  "scripts/install.sh": [
    { fn: "<shell>", line: "mission_gh=$(command -v gh) || fail 'GitHub CLI (gh) is required for authenticated downloads. Install its native binary or download the signed DMG from GitHub Releases.'", why: "locates gh; its one call, in `download`, is `api --hostname github.com` on a `repos/teamupstart/mission-control/...` endpoint" },
  ],
  "src/server/config.ts": [
    { fn: "ghBin", line: 'return envVar("GH_BIN") || "gh";', why: "`ghBin()` itself; its calls are scanned" },
  ],
  "src/server/executables/catalog.ts": [
    { fn: "<module>", line: 'gh: spec("gh", "GitHub CLI", "gh", "GH_BIN"),', why: "the executable catalog entry" },
  ],
  "src/server/setup/index.ts": [
    { fn: "ghCliStatus", line: 'if (status.state !== "satisfied") return status;', why: "returns the setup status; the only run is the `--version` probe" },
    { fn: "ghCliStatus", line: "evidence: status.evidence,", why: "the resolved path, shown as setup evidence; the only run is the `--version` probe" },
    { fn: "ghCliStatus", line: "return status;", why: "returns the setup status; the only run is the `--version` probe" },
  ],
  "src/shared/executables.ts": [
    { fn: "<module>", line: '"gh",', why: "the executable id" },
  ],
  "src/shared/setup-catalog.ts": [
    { fn: "<module>", line: 'argv: ["brew", "install", "gh"],', why: "the install remedy's package name" },
  ],
  "scripts/distribution-github.mjs": [
    { fn: "githubDistributionTransport", line: "export function githubDistributionTransport({command = 'gh', env = process.env} = {}) {", why: "every call it makes names `BINARY_REPO`: `api` on `repos/${BINARY_REPO}/...` and `release upload --repo BINARY_REPO`" },
  ],
  "scripts/check-pi-desktop-install.mjs": [
    { fn: "<module>", line: 'for (const name of ["git", "gh", "npm"]) writeFileSync(join(bin, name), shim, { mode: 0o755 });', why: "writes a fake gh for the install check" },
    { fn: "<module>", line: 'PATH: `${bin}:${process.env.PATH}`, MISSION_NPM_BIN: join(bin, "npm"), MISSION_GH_BIN: join(bin, "gh"),', why: "points the install check at that fake" },
  ],
};

// ---- the scanner ----

/** Calls whose first argument is the program they run. A `gh` binary there is a call site. */
const RUNNERS = new Set([
  "run",
  "runner",
  "runCommand",
  "capture",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "spawn",
  "spawnSync",
]);

/** Calls that turn a binary name into the binary itself: transparent to the scan. */
const LOOKUPS = new Set(["locateExecutable", "locateExecutableSync", "resolveBinPath", "present"]);

/** A program named by literal that runs its `-c` argument as a shell command line. */
const SHELLS = /^(?:\/(?:usr\/)?bin\/)?(?:sh|bash|zsh|dash)$/;

/**
 * A `gh` that is not the start of a `gh` command: a `${VAR:-gh}` or `${VAR-gh}` default, `$GH`,
 * `"gh"`, a `GH_BIN` or `ghBin`. Only a longer word (`github`, `ghost`) and a `gh-` prefix
 * (`gh-resolved`) are not it; a `-gh` suffix is, since that is how a default is written.
 */
const GH_WORD_RE = /(?<!\w)gh(?![\w-])|gh_?bin/gi;

/** A command that forwards its caller's whole argv (`"$@"`): its real argv is at the callers. */
const FORWARDED_ARGV_RE = /\$(?:[@*]|\{[@*]\})/;

/**
 * One shell command line, read for `gh`: each `gh` command, as its text up to an unquoted `;`,
 * `|`, `)`, `&` or newline, and whether any other `gh` in it names the program in a way that
 * cannot be read as a command - which fails as unread rather than passing. So does a `gh` command
 * that forwards `"$@"`: a shell wrapper whose callers this cannot follow.
 */
function readShellLine(text: string): { commands: string[]; unreadable: boolean } {
  const commands: string[] = [];
  const spans: [number, number][] = [];
  let forwarded = false;
  for (const match of text.matchAll(/(?:^|[\s;&|(!`])gh\s+/g)) {
    const start = match.index + match[0].indexOf("gh");
    let end = start;
    let quote: string | null = null;
    for (; end < text.length; end++) {
      const c = text[end]!;
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (";|)&\n".includes(c)) break;
    }
    spans.push([start, end]);
    const command = text.slice(start, end).trim().replace(/\s+/g, " ");
    if (FORWARDED_ARGV_RE.test(command)) forwarded = true;
    else commands.push(command);
  }
  const unreadable = forwarded || [...text.matchAll(GH_WORD_RE)]
    .some((match) => !spans.some(([start, end]) => match.index >= start && match.index < end));
  return { commands, unreadable };
}

/** A shell line without its comment: an unquoted `#` at the start of a word. */
function stripShellComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "\\" && quote !== "'") i++;
    else if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i);
  }
  return line;
}

interface Site {
  file: string;
  fn: string;
  line: number;
  /** The argv expression, or null when the scanner could not follow the binary to a call. */
  argv: string | null;
  /** The trimmed source line, for a site the scanner could not read. */
  text: string;
}

/**
 * A name that runs `gh` when called, so every reference to it is followed like a `gh` binary.
 *
 * - `binary`: the call returns the gh program (`ghBin`).
 * - `wrapper`: a function or method that runs gh with the argv it was handed at `arg` (`runGh`),
 *   so each caller is a site.
 * - `shell`: a child_process shell-string runner (`exec`, `execSync`) or a binding of one
 *   (`promisify(exec)`), so its first argument is a command line.
 * - `value`: an exported binding that holds the gh program itself
 *   (`export const GH_BIN = process.env.MISSION_GH_BIN || "gh"`). Unlike the others it is reached
 *   only where it is imported - by name, alias, namespace or destructuring - and each read is
 *   placed like a `"gh"` literal.
 *
 * A `method` entry is reached only as a property (`this.gh(...)`); any other is reached by its
 * name, by an import alias, or as a property (`ns.runGh(...)`, `deps.ghBin()`).
 */
interface Entry {
  name: string;
  kind: "binary" | "wrapper" | "shell" | "value";
  arg: number;
  method: boolean;
}

/** The entry every scan starts from; wrappers and exported aliases are found from it. */
const GH_BIN: Entry = { name: "ghBin", kind: "binary", arg: 0, method: false };

function sameEntry(a: Entry, b: Entry): boolean {
  return a.name === b.name && a.kind === b.kind && a.arg === b.arg && a.method === b.method;
}

function codeFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...codeFiles(path));
    else if (/\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name)) files.push(path);
  }
  return files;
}

function shellFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...shellFiles(path));
    else if (/\.(?:sh|bash)$/.test(entry.name)) files.push(path);
  }
  return files;
}

/** One line of argv text, so a reflowed array is the same row. */
function normalize(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/([[(]) /g, "$1")
    .replace(/,? ([\])])/g, "$1");
}

function parse(file: string, source: string): ts.SourceFile {
  const kind = file.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : file.endsWith(".jsx")
      ? ts.ScriptKind.JSX
      : /\.[cm]?js$/.test(file)
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
}

function calleeName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

function enclosingName(node: ts.Node): string {
  for (let n = node.parent; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) {
      const owner = ts.isMethodDeclaration(n) && ts.isClassLike(n.parent) && n.parent.name
        ? `${n.parent.name.text}.`
        : "";
      return `${owner}${n.name.getText()}`;
    }
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
      if (ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name)) return n.parent.name.text;
      if (ts.isPropertyAssignment(n.parent) || ts.isPropertyDeclaration(n.parent)) return n.parent.name.getText();
    }
  }
  return "<module>";
}

/** The function `name` is a parameter of, when `node` sits inside it. */
function parameterOwner(node: ts.Node, name: string): ts.SignatureDeclaration | null {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isFunctionLike(n) && n.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === name)) {
      return n;
    }
  }
  return null;
}

/** How callers reach `fn`, which runs gh with its parameter `param`, or null when it is anonymous. */
function wrapperOf(fn: ts.SignatureDeclaration, param: string): Entry | null {
  const arg = fn.parameters.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === param);
  const entry = (name: string, method: boolean): Entry => ({ name, kind: "wrapper", arg, method });
  if (ts.isFunctionDeclaration(fn) && fn.name) return entry(fn.name.text, false);
  if (ts.isMethodDeclaration(fn) && ts.isIdentifier(fn.name)) return entry(fn.name.text, true);
  if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
    const parent = fn.parent;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return entry(parent.name.text, false);
    if ((ts.isPropertyDeclaration(parent) || ts.isPropertyAssignment(parent)) && ts.isIdentifier(parent.name)) {
      return entry(parent.name.text, true);
    }
  }
  return null;
}

function isDeclarationName(id: ts.Identifier): boolean {
  const parent = id.parent;
  return (
    (ts.isVariableDeclaration(parent) && parent.name === id)
    || (ts.isFunctionDeclaration(parent) && parent.name === id)
    || (ts.isParameter(parent) && parent.name === id)
    || (ts.isPropertyAccessExpression(parent) && parent.name === id)
    || (ts.isPropertyAssignment(parent) && parent.name === id)
    || (ts.isPropertyDeclaration(parent) && parent.name === id)
    || (ts.isMethodDeclaration(parent) && parent.name === id)
    || (ts.isMethodSignature(parent) && parent.name === id)
    || (ts.isPropertySignature(parent) && parent.name === id)
    || ts.isImportSpecifier(parent)
    || ts.isExportSpecifier(parent)
    || ts.isImportClause(parent)
    || ts.isNamespaceImport(parent)
    || (ts.isBindingElement(parent) && (parent.name === id || parent.propertyName === id))
  );
}

function identifiersIn(scope: ts.Node, name: string): ts.Identifier[] {
  const found: ts.Identifier[] = [];
  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node) && node.text === name && !isDeclarationName(node)) found.push(node);
    ts.forEachChild(node, visit);
  }
  visit(scope);
  return found;
}

function propertyReadsIn(scope: ts.Node, name: string): ts.PropertyAccessExpression[] {
  const found: ts.PropertyAccessExpression[] = [];
  function visit(node: ts.Node): void {
    if (ts.isPropertyAccessExpression(node) && node.name.text === name) found.push(node);
    ts.forEachChild(node, visit);
  }
  visit(scope);
  return found;
}

/** Walk up through what does not change which program runs. */
function climb(node: ts.Node, throughProperty: boolean): ts.Node {
  for (;;) {
    const parent = node.parent;
    if (
      ts.isParenthesizedExpression(parent)
      || ts.isAwaitExpression(parent)
      || ts.isNonNullExpression(parent)
      || ts.isAsExpression(parent)
      || (ts.isBinaryExpression(parent)
        && (parent.operatorToken.kind === ts.SyntaxKind.BarBarToken
          || parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken))
      || (ts.isCallExpression(parent) && parent.expression !== node && LOOKUPS.has(calleeName(parent) ?? ""))
      || (throughProperty && ts.isPropertyAccessExpression(parent) && parent.expression === node)
    ) {
      node = parent;
      continue;
    }
    return node;
  }
}

/**
 * A read of a bound `gh` binary that only TESTS it - `!exe`, `if (exe)`, `typeof exe`,
 * `status.state !== "satisfied"` - and so cannot hand it to anything that runs it.
 */
function passive(node: ts.Node): boolean {
  const parent = node.parent;
  if (ts.isBinaryExpression(parent)) {
    return [
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken,
    ].includes(parent.operatorToken.kind);
  }
  return (
    (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken)
    || (ts.isIfStatement(parent) && parent.expression === node)
    || (ts.isConditionalExpression(parent) && parent.condition === node)
    || ts.isTypeOfExpression(parent)
  );
}

/** The local names `node:child_process`'s shell-string runners (`exec`, `execSync`) go by. */
/** `require("child_process")` or `import("node:child_process")`, awaited or not. */
function childProcessLoad(node: ts.Node): boolean {
  while (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node)) node = node.expression;
  if (!ts.isCallExpression(node)) return false;
  const loader = node.expression;
  const isLoader = (ts.isIdentifier(loader) && loader.text === "require") || loader.kind === ts.SyntaxKind.ImportKeyword;
  const from = node.arguments[0];
  return isLoader && !!from && ts.isStringLiteral(from) && (from.text === "child_process" || from.text === "node:child_process");
}

/**
 * The local names `node:child_process`'s shell-string runners (`exec`, `execSync`) go by, the
 * names the module itself is bound to, and `require("child_process").exec`-style reads.
 */
function shellRunnerNames(tree: ts.SourceFile): {
  names: Set<string>;
  namespaces: Set<string>;
  direct: ts.PropertyAccessExpression[];
} {
  const names = new Set<string>();
  const namespaces = new Set<string>();
  const direct: ts.PropertyAccessExpression[] = [];
  const isChildProcess = (text: string): boolean => text === "child_process" || text === "node:child_process";
  function bindFrom(pattern: ts.BindingName): void {
    if (ts.isIdentifier(pattern)) namespaces.add(pattern.text);
    else if (ts.isObjectBindingPattern(pattern)) {
      for (const element of pattern.elements) {
        const imported = element.propertyName?.getText() ?? element.name.getText();
        if ((imported === "exec" || imported === "execSync") && ts.isIdentifier(element.name)) names.add(element.name.text);
      }
    }
  }
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && isChildProcess(node.moduleSpecifier.text)) {
      const clause = node.importClause;
      if (clause?.name) namespaces.add(clause.name.text);
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      else if (bindings) {
        for (const element of bindings.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          if (imported === "exec" || imported === "execSync") names.add(element.name.text);
        }
      }
    }
    if (ts.isVariableDeclaration(node) && node.initializer && childProcessLoad(node.initializer)) bindFrom(node.name);
    if (ts.isPropertyAccessExpression(node) && childProcessLoad(node.expression)
      && (node.name.text === "exec" || node.name.text === "execSync")) {
      direct.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return { names, namespaces, direct };
}

/** Calls that hand back the function they are given, still runnable: `promisify(exec)`. */
const RESHAPERS = new Set(["promisify"]);

/**
 * Every `gh` invocation in one file, as the inventory names it.
 *
 * It starts from the ways a `gh` program appears - a `"gh"` literal, an entry (`ghBin`, a
 * pass-through wrapper such as `runGh`, a child_process shell runner), and a `gh` command in a
 * shell command line - and follows each to the call that runs it: as a runner's first argument,
 * through a `const` binding and any rebinding of it, through an executable lookup, through an
 * import alias or `promisify`, and from a wrapper to each of its callers in any file.
 *
 * One rule holds for every reference it follows, binary or entry: it ends in a call (a site), a
 * pure test of a binary (`!exe`, `status.state !== "x"`), a binding or alias that is followed in
 * turn, or `argv: null` - which no call row matches, so a shape it cannot follow fails until a
 * person reads it and either declares it a mention or rewrites it into one this reads. A shell
 * command line it cannot read as text fails the same way. The boundary: a program reached only
 * through something this never sees as `gh` - a shell whose name is not a literal, or a value
 * produced by code it does not read - is out of a syntax scan's reach, as it is for
 * `test/executable-contracts.test.ts`.
 *
 * `found` is what this file adds to the entries every file follows: wrappers it declares, and
 * bindings or aliases of an entry it exports. `repositorySites` runs to a fixpoint over them.
 */
function ghSites(file: string, source: string, entries: readonly Entry[] = [GH_BIN]): { sites: Site[]; found: Entry[] } {
  const tree = parse(file, source);
  const sites: Site[] = [];
  const found: Entry[] = [];
  const invoked = new Set<ts.Node>();
  const globalNames = new Set(entries.map((e) => e.name));

  function lineOf(node: ts.Node): number {
    return tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
  }
  function unread(node: ts.Node): void {
    const line = lineOf(node);
    if (sites.some((s) => s.argv === null && s.line === line)) return;
    sites.push({ file, fn: enclosingName(node), line, argv: null, text: source.split("\n")[line - 1]!.trim() });
  }
  function site(node: ts.Node, argv: string): void {
    sites.push({ file, fn: enclosingName(node), line: lineOf(node), argv, text: "" });
  }
  function discover(entry: Entry): void {
    if (!found.some((f) => sameEntry(f, entry))) found.push(entry);
  }
  // The argv handed to gh at `index`: a site, or - when it is the caller's own parameter - a new wrapper.
  function argvSite(at: ts.CallExpression, index: number): void {
    const argv = at.arguments[index];
    if (!argv || at.arguments.slice(0, index + 1).some(ts.isSpreadElement)) return unread(at);
    if (ts.isIdentifier(argv)) {
      const owner = parameterOwner(at, argv.text);
      if (owner) {
        const wrapper = wrapperOf(owner, argv.text);
        return wrapper ? discover(wrapper) : unread(at);
      }
    }
    site(at, normalize(argv.getText(tree)));
  }
  function runnerArgument(node: ts.Node): ts.CallExpression | null {
    const parent = node.parent;
    return ts.isCallExpression(parent) && parent.arguments[0] === node && RUNNERS.has(calleeName(parent) ?? "")
      ? parent
      : null;
  }
  function scopeOf(declaration: ts.Node): ts.Node {
    for (let n = declaration.parent; n; n = n.parent) {
      if (ts.isBlock(n) || ts.isSourceFile(n) || ts.isModuleBlock(n)) return n;
    }
    return tree;
  }
  /** The names `name`, declared at `declaration`, is exported under from this file. */
  function exportedAs(declaration: ts.VariableDeclaration, name: string): string[] {
    const names: string[] = [];
    const statement = declaration.parent.parent;
    if (ts.isVariableStatement(statement) && statement.parent === tree
      && statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      names.push(name);
    }
    return [...names, ...exportAliases(name)];
  }
  function exportAliases(name: string): string[] {
    const names: string[] = [];
    for (const statement of tree.statements) {
      if (!ts.isExportDeclaration(statement) || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
      for (const spec of statement.exportClause.elements) {
        if ((spec.propertyName ?? spec.name).getText() === name) names.push(spec.name.text);
      }
    }
    return names;
  }

  // Where a `gh` binary (or a read of a binding holding one) ends up: run, rebound, or unread.
  function place(node: ts.Node, throughProperty: boolean): void {
    const at = climb(node, throughProperty);
    const runner = runnerArgument(at);
    if (runner) {
      if (invoked.has(runner)) return;
      invoked.add(runner);
      return argvSite(runner, 1);
    }
    if (throughProperty && passive(at)) return;
    const parent = at.parent;
    if (ts.isVariableDeclaration(parent) && parent.initializer === at && ts.isIdentifier(parent.name)) {
      // Exported, it is read in files this one never sees: every importer places it in turn.
      for (const alias of exportedAs(parent, parent.name.text)) discover({ name: alias, kind: "value", arg: 0, method: false });
      for (const ref of identifiersIn(scopeOf(parent), parent.name.text)) place(ref, true);
      return;
    }
    unread(at);
  }

  // Calling an entry: a binary is placed, a wrapper's argv is a site, a shell's command is read.
  function invoke(at: ts.CallExpression, entry: Entry): void {
    if (invoked.has(at)) return;
    invoked.add(at);
    if (entry.kind === "binary") return place(at, false);
    if (entry.kind === "shell") return commandLine(at.arguments[0], at);
    argvSite(at, entry.arg);
  }

  /** One reference to an entry: called, carried under its own global name, followed, or unread. */
  function onRef(ref: ts.Identifier | ts.PropertyAccessExpression, entry: Entry): void {
    if (entry.kind === "value") return place(ref, true);
    const parent = ref.parent;
    if (ts.isCallExpression(parent) && parent.expression === ref) return invoke(parent, entry);
    // Carried into an object under a name every file already follows (`{ ghBin }`): its calls
    // are found as that property.
    if (ts.isShorthandPropertyAssignment(parent) && entry.kind !== "shell" && globalNames.has(parent.name.text)) return;
    if (ts.isPropertyAssignment(parent) && parent.initializer === ref && entry.kind !== "shell"
      && globalNames.has(parent.name.getText())) {
      return;
    }
    // Handed to a function in this file: its parameter is the entry there.
    if (ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && !RESHAPERS.has(parent.expression.text)) {
      const index = parent.arguments.indexOf(ref as ts.Expression);
      const target = functionDeclaration(parent.expression.text);
      const param = target?.parameters[index]?.name;
      if (target?.body && param && ts.isIdentifier(param)) {
        for (const use of identifiersIn(target.body, param.text)) onRef(use, { ...entry, name: param.text, method: false });
        return;
      }
    }
    let at: ts.Node = ref;
    for (;;) {
      const up = at.parent;
      if (ts.isParenthesizedExpression(up) || ts.isAwaitExpression(up) || ts.isNonNullExpression(up) || ts.isAsExpression(up)) at = up;
      else if (ts.isCallExpression(up) && up.arguments[0] === at && RESHAPERS.has(calleeName(up) ?? "")) at = up;
      else if (ts.isPropertyAccessExpression(up) && up.expression === at && up.name.text === "bind"
        && ts.isCallExpression(up.parent) && up.parent.expression === up) at = up.parent;
      else break;
    }
    const declaration = at.parent;
    if (ts.isVariableDeclaration(declaration) && declaration.initializer === at && ts.isIdentifier(declaration.name)) {
      const name = declaration.name.text;
      for (const alias of exportedAs(declaration, name)) discover({ ...entry, name: alias, method: false });
      for (const use of identifiersIn(scopeOf(declaration), name)) onRef(use, { ...entry, name, method: false });
      return;
    }
    unread(at);
  }
  function functionDeclaration(name: string): ts.FunctionDeclaration | null {
    let match: ts.FunctionDeclaration | null = null;
    tree.forEachChild(function visit(node) {
      if (ts.isFunctionDeclaration(node) && node.name?.text === name) match = node;
      else if (!match) ts.forEachChild(node, visit);
    });
    return match;
  }

  /** Names bound to a whole module: namespace and default imports, `require(...)`, `await import(...)`. */
  function moduleObjects(): Set<string> {
    const names = new Set<string>();
    tree.forEachChild(function visit(node) {
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        if (clause?.name) names.add(clause.name.text);
        if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) names.add(clause.namedBindings.name.text);
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        let init: ts.Node = node.initializer;
        while (ts.isAwaitExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression;
        if (ts.isCallExpression(init) && ((ts.isIdentifier(init.expression) && init.expression.text === "require")
          || init.expression.kind === ts.SyntaxKind.ImportKeyword)) {
          names.add(node.name.text);
        }
      }
      ts.forEachChild(node, visit);
    });
    return names;
  }
  /** `{ name }` or `{ name: local }` destructured anywhere in this file. */
  function bindingElementsNamed(name: string): ts.BindingElement[] {
    const elements: ts.BindingElement[] = [];
    tree.forEachChild(function visit(node) {
      if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)
        && (node.propertyName ?? node.name).getText() === name) {
        elements.push(node);
      }
      ts.forEachChild(node, visit);
    });
    return elements;
  }
  /** Where a destructured name is visible: its declaration's block, or its function's body. */
  function bindingScope(element: ts.BindingElement): ts.Node | null {
    const holder = element.parent.parent;
    if (ts.isVariableDeclaration(holder)) return scopeOf(holder);
    if (ts.isParameter(holder) && ts.isFunctionLike(holder.parent)) return holder.parent;
    return null;
  }

  // A shell command line: a `gh` command in its text is a site; text it cannot see is unread.
  function commandLine(command: ts.Expression | undefined, at: ts.Node): void {
    if (!command || ts.isSpreadElement(command)) return unread(at);
    const text = ts.isStringLiteral(command) || ts.isNoSubstitutionTemplateLiteral(command)
      ? command.text
      : ts.isTemplateExpression(command)
        ? command.getText(tree).slice(1, -1)
        : null;
    if (text === null) return unread(command);
    const read = readShellLine(text);
    for (const gh of read.commands) site(command, normalize(gh));
    if (read.unreadable) unread(command);
  }
  function shellCall(node: ts.CallExpression): void {
    const program = node.arguments[0];
    const argv = node.arguments[1];
    if (program && (ts.isStringLiteral(program) || ts.isNoSubstitutionTemplateLiteral(program)) && SHELLS.test(program.text)) {
      if (!argv) return;
      if (!ts.isArrayLiteralExpression(argv)) return unread(node);
      const flag = argv.elements.findIndex((e) => ts.isStringLiteral(e) && /^-[a-z]*c$/.test(e.text));
      if (flag !== -1) commandLine(argv.elements[flag + 1], node);
      return;
    }
    // `shell: true` hands the program and its arguments to a shell as one line.
    const options = node.arguments.find(ts.isObjectLiteralExpression);
    const shell = options?.properties.find((p) =>
      (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name.getText() === "shell");
    if (!shell || (ts.isPropertyAssignment(shell) && shell.initializer.kind === ts.SyntaxKind.FalseKeyword)) return;
    if (program && !(ts.isCallExpression(program) && calleeName(program) === "ghBin")) commandLine(program, node);
  }

  function visit(node: ts.Node): void {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === "gh") {
      if (!ts.isImportDeclaration(node.parent) && !ts.isLiteralTypeNode(node.parent)) place(node, false);
    } else if (ts.isCallExpression(node)) {
      shellCall(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);

  // Every entry every file follows: under its own name, an import alias, a namespace, as a
  // property, or destructured. A `value` is a plain binding, so only its imports reach it.
  const modules = moduleObjects();
  for (const entry of entries) {
    if (entry.kind !== "value") {
      if (!entry.method) for (const ref of identifiersIn(tree, entry.name)) onRef(ref, entry);
      for (const read of propertyReadsIn(tree, entry.name)) onRef(read, entry);
    } else {
      for (const read of propertyReadsIn(tree, entry.name)) {
        if (ts.isIdentifier(read.expression) && modules.has(read.expression.text)) onRef(read, entry);
      }
    }
    if (!entry.method) {
      for (const alias of exportAliases(entry.name)) if (alias !== entry.name) discover({ ...entry, name: alias });
    }
    for (const element of bindingElementsNamed(entry.name)) {
      const scope = bindingScope(element);
      if (!scope || !ts.isIdentifier(element.name)) unread(element);
      else for (const ref of identifiersIn(scope, element.name.text)) onRef(ref, { ...entry, name: element.name.text, method: false });
    }
  }
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      const entry = entries.find((e) => !e.method && e.name === imported);
      if (!entry || (entry.kind !== "value" && element.name.text === imported)) continue;
      for (const ref of identifiersIn(tree, element.name.text)) onRef(ref, { ...entry, name: element.name.text });
    }
  }
  // child_process's shell runners, under whatever this file calls them.
  const shellRunners = shellRunnerNames(tree);
  for (const name of shellRunners.names) {
    for (const ref of identifiersIn(tree, name)) onRef(ref, { name, kind: "shell", arg: 0, method: false });
  }
  for (const read of shellRunners.direct) onRef(read, { name: read.name.text, kind: "shell", arg: 0, method: false });
  for (const namespace of shellRunners.namespaces) {
    for (const ref of identifiersIn(tree, namespace)) {
      const parent = ref.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === ref) {
        if (parent.name.text === "exec" || parent.name.text === "execSync") {
          onRef(parent, { name: parent.name.text, kind: "shell", arg: 0, method: false });
        }
      } else {
        unread(ref); // the whole module handed on: its `exec` can no longer be followed
      }
    }
  }
  // Wrappers this file declares are followed here too, so its own callers are not left to the next pass.
  for (const wrapper of found.filter((f) => !entries.some((e) => sameEntry(e, f)))) {
    if (!wrapper.method) for (const ref of identifiersIn(tree, wrapper.name)) onRef(ref, wrapper);
    for (const read of propertyReadsIn(tree, wrapper.name)) onRef(read, wrapper);
  }

  return { sites, found };
}

/**
 * `gh` commands in a shell script: one site per command (`readShellLine`), and an unread report
 * for a line with any other `gh` - `"${GH_CMD:-gh}" issue list`, `"$GH" issue list`.
 */
function shellSites(file: string, source: string): Site[] {
  const sites: Site[] = [];
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index++) {
    // A `\` continuation is one command: read the logical line, reported at its first line.
    const first = index;
    let logical = stripShellComment(lines[index]!);
    while (logical.endsWith("\\") && index + 1 < lines.length) logical = `${logical.slice(0, -1)} ${stripShellComment(lines[++index]!)}`;
    const read = readShellLine(logical);
    for (const gh of read.commands) sites.push({ file, fn: "<shell>", line: first + 1, argv: gh, text: "" });
    if (read.unreadable) sites.push({ file, fn: "<shell>", line: first + 1, argv: null, text: lines[first]!.trim() });
  }
  return sites;
}

/** The sites in `sources`, read to a fixpoint: a wrapper of a wrapper, or an exported alias, is an entry for every file. */
function scanSources(sources: readonly { file: string; source: string }[]): Site[] {
  const entries: Entry[] = [GH_BIN];
  for (;;) {
    const scans = sources.map(({ file, source }) => ghSites(file, source, entries));
    const added = scans.flatMap((scan) => scan.found).filter((f) => !entries.some((e) => sameEntry(e, f)));
    if (added.length === 0) return scans.flatMap((scan) => scan.sites);
    for (const entry of added) if (!entries.some((e) => sameEntry(e, entry))) entries.push(entry);
  }
}

function repositorySites(): Site[] {
  const files = [...codeFiles(join(ROOT, "src")), ...codeFiles(join(ROOT, "scripts"))];
  return [
    ...scanSources(files.map((path) => ({ file: relative(ROOT, path), source: readFileSync(path, "utf8") }))),
    // Skills ship shell assets that agents install and run, so they are read with the scripts.
    ...[...shellFiles(join(ROOT, "scripts")), ...shellFiles(join(ROOT, "skills"))].flatMap((path) =>
      shellSites(relative(ROOT, path), readFileSync(path, "utf8"))),
  ];
}

/** What is wrong with `sites` against the inventory: unclassified, unreadable, stale or misfiled. */
function inventoryProblems(
  sites: readonly Site[],
  calls: Readonly<Record<string, readonly GhCall[]>>,
  mentions: Readonly<Record<string, readonly GhMention[]>>,
): string[] {
  const problems: string[] = [];
  const callRows = Object.entries(calls).flatMap(([file, rows]) => rows.map((row) => ({ file, row, used: false })));
  const mentionRows = Object.entries(mentions).flatMap(([file, rows]) => rows.map((row) => ({ file, row, used: false })));
  for (const site of sites) {
    if (site.argv !== null) {
      const row = callRows.find((r) => !r.used && r.file === site.file && r.row.fn === site.fn && r.row.argv === site.argv);
      if (row) row.used = true;
      else problems.push(`${site.file}:${site.line} unclassified gh call in ${site.fn}: ${site.argv}`);
    } else {
      const row = mentionRows.find((r) => !r.used && r.file === site.file && r.row.fn === site.fn && r.row.line === site.text);
      if (row) row.used = true;
      else problems.push(`${site.file}:${site.line} the scanner cannot read this gh binary in ${site.fn}: ${site.text}`);
    }
  }
  for (const { file, row, used } of callRows) {
    if (!used) problems.push(`${file} ${row.fn}: no gh call reads ${row.argv} any more`);
    const hows = typeof row.how === "string" ? [row.how] : row.how;
    if (hows.includes("none") && !NO_REPOSITORY_ARGV.has(row.argv)) {
      problems.push(`${file} ${row.fn}: ${row.argv} names no repository and is not auth status, --version or api user`);
    }
    if (hows.includes("node-id") && !NODE_ID_ARGV.has(row.argv)) {
      problems.push(`${file} ${row.fn}: ${row.argv} is not a reviewed node-id mutation; name its repository`);
    }
    if (!row.why.trim()) problems.push(`${file} ${row.fn}: ${row.argv} needs a reason`);
  }
  for (const { file, row, used } of mentionRows) {
    if (!used) problems.push(`${file} ${row.fn}: no gh mention reads ${row.line} any more`);
    if (!row.why.trim()) problems.push(`${file} ${row.fn}: ${row.line} needs a reason`);
  }
  return problems;
}

test("every gh call in the daemon, app and scripts names how it targets a repository", () => {
  assert.deepEqual(inventoryProblems(repositorySites(), GH_CALLS, GH_MENTIONS), []);
});

/** Problems in source order, for fixtures whose sites the scan reaches in a different order. */
function byLine(a: string, b: string): number {
  const line = (p: string): number => Number(/:(\d+) /.exec(p)?.[1] ?? 0);
  return line(a) - line(b);
}

test("the scanner follows bindings, lookups and pass-through wrappers to the call", () => {
  const source = [
    'import { execFile } from "node:child_process";',
    "async function runGh(args) {",
    '  const executable = await locateExecutable("gh");',
    "  if (!executable) return null;",
    "  return execFile(executable.path, args);",
    "}",
    "async function latest(run) {",
    '  return run(["release", "list", "--repo", CANONICAL_REPO]);',
    "}",
    "function check() {",
    "  latest(runGh);",
    '  return runGh(["auth", "status"]);',
    "}",
    "function fork(args, repo) {",
    '  const bin = process.env.MISSION_GH_BIN || "gh";',
    '  return execFileSync(bin, [...args, "--repo", repo]);',
    "}",
  ].join("\n");
  const { sites, found } = ghSites("fixture.mjs", source);
  assert.deepEqual(found, [{ name: "runGh", kind: "wrapper", arg: 0, method: false }]);
  assert.deepEqual(
    sites.map(({ fn, argv }) => ({ fn, argv })),
    [
      { fn: "fork", argv: '[...args, "--repo", repo]' },
      { fn: "latest", argv: '["release", "list", "--repo", CANONICAL_REPO]' },
      { fn: "check", argv: '["auth", "status"]' },
    ],
  );
});

test("a bound gh binary read into a call the scanner does not know fails loudly", () => {
  const source = [
    "async function listIssues() {",
    '  const exe = await locateExecutable("gh");',
    "  if (!exe) return null;",
    '  return execFileAsync(exe.path, ["issue", "list"]);',
    "}",
    "function ghPath() {",
    '  const exe = locateExecutableSync("gh");',
    "  return exe.path;",
    "}",
    "async function rebound(cwd) {",
    "  const bin = ghBin();",
    "  const exe = await locateExecutable(bin);",
    '  return execFile(exe.path, ["pr", "list"], { cwd });',
    "}",
  ].join("\n");
  const { sites } = ghSites("src/server/fixture.ts", source);
  assert.deepEqual(inventoryProblems(sites, {}, {}), [
    'src/server/fixture.ts:4 the scanner cannot read this gh binary in listIssues: return execFileAsync(exe.path, ["issue", "list"]);',
    "src/server/fixture.ts:8 the scanner cannot read this gh binary in ghPath: return exe.path;",
    'src/server/fixture.ts:13 unclassified gh call in rebound: ["pr", "list"]',
  ]);
});

test("a pass-through wrapper written as a method makes each of its callers a site", () => {
  const source = [
    "class Issues {",
    "  private gh(args) { return run(ghBin(), args); }",
    "  private runner = (args) => run(ghBin(), args);",
    '  list() { return this.gh(["issue", "list"]); }',
    '  view(url) { return this.runner(["issue", "view", url]); }',
    "  handOff() { return later(this.gh); }",
    "}",
  ].join("\n");
  const { sites, found } = ghSites("src/server/fixture.ts", source);
  assert.deepEqual(found, [
    { name: "gh", kind: "wrapper", arg: 0, method: true },
    { name: "runner", kind: "wrapper", arg: 0, method: true },
  ]);
  assert.deepEqual(inventoryProblems(sites, {}, {}), [
    'src/server/fixture.ts:4 unclassified gh call in Issues.list: ["issue", "list"]',
    "src/server/fixture.ts:6 the scanner cannot read this gh binary in Issues.handOff: handOff() { return later(this.gh); }",
    'src/server/fixture.ts:5 unclassified gh call in Issues.view: ["issue", "view", url]',
  ]);
});

test("a gh command handed to a shell is a site, and a command line the scanner cannot see fails", () => {
  const source = [
    'import { exec, execSync as sh } from "node:child_process";',
    'import * as cp from "node:child_process";',
    "function shellCalls(cmd, n) {",
    '  sh("gh issue list --json number");',
    "  exec(`gh issue view ${n}`);",
    '  cp.execSync("git status");',
    "  exec(cmd);",
    '  spawn("bash", ["-lc", "gh pr checks --watch"]);',
    '  spawn("sh", ["-c", cmd]);',
    '  run("gh pr list", [], { shell: true });',
    "  run(cmd, [], { shell: true });",
    `  sh('"\${GH_CMD:-gh}" issue list');`,
    "  exec(`${GH} issue list`);",
    `  sh('"\${GH_CMD-gh}" issue list');`,
    "}",
  ].join("\n");
  const { sites } = ghSites("scripts/fixture.mjs", source);
  assert.deepEqual(inventoryProblems(sites, {}, {}).sort(byLine), [
    "scripts/fixture.mjs:4 unclassified gh call in shellCalls: gh issue list --json number",
    "scripts/fixture.mjs:5 unclassified gh call in shellCalls: gh issue view ${n}",
    "scripts/fixture.mjs:7 the scanner cannot read this gh binary in shellCalls: exec(cmd);",
    "scripts/fixture.mjs:8 unclassified gh call in shellCalls: gh pr checks --watch",
    'scripts/fixture.mjs:9 the scanner cannot read this gh binary in shellCalls: spawn("sh", ["-c", cmd]);',
    'scripts/fixture.mjs:10 unclassified gh call in shellCalls: gh pr list',
    "scripts/fixture.mjs:11 the scanner cannot read this gh binary in shellCalls: run(cmd, [], { shell: true });",
    `scripts/fixture.mjs:12 the scanner cannot read this gh binary in shellCalls: sh('"\${GH_CMD:-gh}" issue list');`,
    "scripts/fixture.mjs:13 the scanner cannot read this gh binary in shellCalls: exec(`${GH} issue list`);",
    `scripts/fixture.mjs:14 the scanner cannot read this gh binary in shellCalls: sh('"\${GH_CMD-gh}" issue list');`,
  ]);
});

test("a shell runner rebound through promisify or a namespace still has its command read", () => {
  const source = [
    'import { exec } from "node:child_process";',
    'import * as cp from "node:child_process";',
    'import { promisify } from "node:util";',
    "const execAsync = promisify(exec);",
    "const syncRun = promisify(cp.exec);",
    "export async function issues(cmd) {",
    '  await execAsync("gh issue list --json number");',
    '  syncRun("gh pr checks --watch");',
    "  later(exec);",
    "  return execAsync(cmd);",
    "}",
  ].join("\n");
  assert.deepEqual(inventoryProblems(scanSources([{ file: "scripts/fixture.mjs", source }]), {}, {}).sort(byLine), [
    "scripts/fixture.mjs:7 unclassified gh call in issues: gh issue list --json number",
    "scripts/fixture.mjs:8 unclassified gh call in issues: gh pr checks --watch",
    "scripts/fixture.mjs:9 the scanner cannot read this gh binary in issues: later(exec);",
    "scripts/fixture.mjs:10 the scanner cannot read this gh binary in issues: return execAsync(cmd);",
  ]);
});

test("ghBin and wrappers are followed through aliases, namespaces, exports and argv position", () => {
  const sources = [
    {
      file: "src/server/aliases.ts",
      source: [
        'import { ghBin as gh } from "./config.ts";',
        "export const bin = ghBin;",
        "export { runIn as runGhIn };",
        "export function runIn(cwd, args) {",
        "  return run(gh(), args, { cwd });",
        "}",
        "export function issues(cwd) {",
        '  return run(gh(), ["issue", "list"], { cwd });',
        "}",
      ].join("\n"),
    },
    {
      file: "src/server/callers.ts",
      source: [
        'import { bin, runGhIn } from "./aliases.ts";',
        'import * as updater from "../main/updater.ts";',
        "function viaExport(dir) {",
        '  run(bin(), ["pr", "list"]);',
        '  runGhIn(dir, ["pr", "view", "12"]);',
        '  return updater.runGh(["issue", "view", "3"]);',
        "}",
        "function listed(args) {",
        "  return runGhIn(process.cwd(), args);",
        "}",
        "function leaks() {",
        '  listed(["run", "list"]);',
        "  return { bin: ghBin, other: later(ghBin) };",
        "}",
      ].join("\n"),
    },
    {
      file: "src/main/updater.ts",
      source: 'export async function runGh(args) { const exe = await locateExecutable("gh"); return execFile(exe.path, args); }',
    },
  ];
  assert.deepEqual(inventoryProblems(scanSources(sources), {}, {}).sort(), [
    'src/server/aliases.ts:8 unclassified gh call in issues: ["issue", "list"]',
    'src/server/callers.ts:12 unclassified gh call in leaks: ["run", "list"]',
    "src/server/callers.ts:13 the scanner cannot read this gh binary in leaks: return { bin: ghBin, other: later(ghBin) };",
    'src/server/callers.ts:4 unclassified gh call in viaExport: ["pr", "list"]',
    'src/server/callers.ts:5 unclassified gh call in viaExport: ["pr", "view", "12"]',
    'src/server/callers.ts:6 unclassified gh call in viaExport: ["issue", "view", "3"]',
  ]);
});

test("an exported gh binary is placed wherever it is imported", () => {
  const sources = [
    {
      file: "scripts/lib/gh.mjs",
      source: [
        'export const GH_BIN = process.env.MISSION_GH_BIN || "gh";',
        "export const GH = ghBin();",
        'const GH_LITERAL = "gh";',
        "export { GH_LITERAL };",
        'const hidden = "gh";',
        "export default hidden;",
      ].join("\n"),
    },
    {
      file: "scripts/fork-x.mjs",
      source: [
        'import { GH_BIN, GH as G } from "./lib/gh.mjs";',
        'import * as lib from "./lib/gh.mjs";',
        "export async function main() {",
        '  execFileSync(GH_BIN, ["issue", "list"]);',
        '  run(G, ["pr", "list"]);',
        '  spawn(lib.GH_LITERAL, ["issue", "view", "1"]);',
        '  const { GH_BIN: bin } = await import("./lib/gh.mjs");',
        '  spawnSync(bin, ["run", "list"]);',
        "  return later(GH_BIN);",
        "}",
      ].join("\n"),
    },
  ];
  assert.deepEqual(inventoryProblems(scanSources(sources), {}, {}).sort(), [
    "scripts/fork-x.mjs:4 unclassified gh call in main: [\"issue\", \"list\"]",
    "scripts/fork-x.mjs:5 unclassified gh call in main: [\"pr\", \"list\"]",
    "scripts/fork-x.mjs:6 unclassified gh call in main: [\"issue\", \"view\", \"1\"]",
    "scripts/fork-x.mjs:8 unclassified gh call in main: [\"run\", \"list\"]",
    "scripts/fork-x.mjs:9 the scanner cannot read this gh binary in main: return later(GH_BIN);",
    "scripts/lib/gh.mjs:6 the scanner cannot read this gh binary in <module>: export default hidden;",
  ]);
});

test("child_process loaded through require or import(), and a method destructured off this, are followed", () => {
  const source = [
    "class Issues {",
    "  gh(args) { return run(ghBin(), args); }",
    "  list() {",
    "    const { gh } = this;",
    '    return gh(["issue", "list"]);',
    "  }",
    "}",
    "export async function shells() {",
    '  require("child_process").execSync("gh issue list --json number");',
    '  const cp = await import("node:child_process");',
    '  cp.exec("gh pr list");',
    '  const { exec: run2 } = await import("node:child_process");',
    '  run2("gh run list");',
    "}",
  ].join("\n");
  assert.deepEqual(inventoryProblems(scanSources([{ file: "scripts/fixture.mjs", source }]), {}, {}).sort(byLine), [
    'scripts/fixture.mjs:5 unclassified gh call in Issues.list: ["issue", "list"]',
    "scripts/fixture.mjs:9 unclassified gh call in shells: gh issue list --json number",
    "scripts/fixture.mjs:11 unclassified gh call in shells: gh pr list",
    "scripts/fixture.mjs:13 unclassified gh call in shells: gh run list",
  ]);
});

test("a shell script's gh commands are sites, and a gh it cannot read as one fails", () => {
  const source = [
    "#!/bin/sh",
    "# gh in a comment is not a command",
    'if ! out=$(gh api "repos/$REPO/pulls"); then exit 1; fi',
    'GH="${MISSION_GH_BIN:-gh}"',
    '"$GH" issue list',
    'echo "see github.com and gh-resolved"',
    '"${GH_CMD:-gh}" issue list',
    'echo "a # inside quotes is not a comment"; gh pr list',
    '"${GH_CMD-gh}" issue list',
    '"${GH-gh}" issue list',
    "gh issue \\",
    '  list --repo "$REPO"',
    'ghx() { gh api "$@"; }',
    'echo "kebab-gh-not words: ghost github gh-resolved"',
  ].join("\n");
  assert.deepEqual(inventoryProblems(shellSites("scripts/fixture.sh", source), {}, {}), [
    'scripts/fixture.sh:3 unclassified gh call in <shell>: gh api "repos/$REPO/pulls"',
    'scripts/fixture.sh:4 the scanner cannot read this gh binary in <shell>: GH="${MISSION_GH_BIN:-gh}"',
    'scripts/fixture.sh:5 the scanner cannot read this gh binary in <shell>: "$GH" issue list',
    'scripts/fixture.sh:7 the scanner cannot read this gh binary in <shell>: "${GH_CMD:-gh}" issue list',
    "scripts/fixture.sh:8 unclassified gh call in <shell>: gh pr list",
    'scripts/fixture.sh:9 the scanner cannot read this gh binary in <shell>: "${GH_CMD-gh}" issue list',
    'scripts/fixture.sh:10 the scanner cannot read this gh binary in <shell>: "${GH-gh}" issue list',
    'scripts/fixture.sh:11 unclassified gh call in <shell>: gh issue list --repo "$REPO"',
    'scripts/fixture.sh:13 the scanner cannot read this gh binary in <shell>: ghx() { gh api "$@"; }',
  ]);
});

test("an unclassified gh call fails the inventory", () => {
  const source = [
    'import { ghBin } from "./config.ts";',
    "async function listIssues(cwd) {",
    '  return run(ghBin(), ["issue", "list", "--json", "number"], { cwd });',
    "}",
  ].join("\n");
  const { sites } = ghSites("src/server/fixture.ts", source);
  assert.deepEqual(inventoryProblems(sites, {}, {}), [
    'src/server/fixture.ts:3 unclassified gh call in listIssues: ["issue", "list", "--json", "number"]',
  ]);
});

test("a call that names no repository cannot be classified as none", () => {
  const source = 'async function listIssues() { return run(ghBin(), ["issue", "list"]); }';
  const { sites } = ghSites("src/server/fixture.ts", source);
  const calls = { "src/server/fixture.ts": [{ fn: "listIssues", argv: '["issue", "list"]', how: "none" as const, why: "nothing" }] };
  assert.deepEqual(inventoryProblems(sites, calls, {}), [
    'src/server/fixture.ts listIssues: ["issue", "list"] names no repository and is not auth status, --version or api user',
  ]);
});

test("a gh binary the scanner cannot follow fails loudly rather than passing", () => {
  const source = [
    "function listIssues() {",
    '  const argv = [ghBin(), "issue", "list"];',
    "  return spawn(argv[0], argv.slice(1));",
    "}",
    "function viaSpread(args) {",
    "  return run(ghBin(), ...args);",
    "}",
  ].join("\n");
  const { sites } = ghSites("src/server/fixture.ts", source);
  assert.deepEqual(inventoryProblems(sites, {}, {}), [
    'src/server/fixture.ts:2 the scanner cannot read this gh binary in listIssues: const argv = [ghBin(), "issue", "list"];',
    "src/server/fixture.ts:6 the scanner cannot read this gh binary in viaSpread: return run(ghBin(), ...args);",
  ]);
});

test("a node-id row is limited to the reviewed mutation", () => {
  const source = 'async function close(id) { return run(ghBin(), ["api", "graphql", "-F", `id=${id}`]); }';
  const { sites } = ghSites("src/server/fixture.ts", source);
  const calls = { "src/server/fixture.ts": [{ fn: "close", argv: '["api", "graphql", "-F", `id=${id}`]', how: "node-id" as const, why: "an id" }] };
  assert.deepEqual(inventoryProblems(sites, calls, {}), [
    'src/server/fixture.ts close: ["api", "graphql", "-F", `id=${id}`] is not a reviewed node-id mutation; name its repository',
  ]);
});

test("a row no call reads any more fails, so the inventory cannot outlive its calls", () => {
  const calls = { "src/server/gone.ts": [{ fn: "gone", argv: '["issue", "list"]', how: "resolver" as const, why: "removed" }] };
  assert.deepEqual(inventoryProblems([], calls, {}), ['src/server/gone.ts gone: no gh call reads ["issue", "list"] any more']);
});

// ---- part 2: agent instructions ----

/**
 * Agent-facing TypeScript: only its string and template text is read, never its comments,
 * which explain these commands to the next maintainer rather than giving them to an agent.
 */
const AGENT_TEXT_SOURCES = [
  "src/shared/queue.ts",
  "src/server/task-contract.ts",
  "src/server/workflows/feedback.ts",
  "src/server/foreman/review-followup.ts",
  "src/server/skills/pull-request-policy.ts",
  "src/mcp/server.ts",
  "src/shared/stacking.ts",
  "src/server/stacking/lineage.ts",
];

/**
 * Shipped action text is snapshotted by built-in workflow versions and pinned by digest in
 * `test/builtin-workflows.test.ts`, so it cannot change here; it defers to the pull-request skill.
 */
const FROZEN_AGENT_TEXT = new Set(["actions/pull-request.md"]);

function markdownFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(path));
    else if (entry.name.endsWith(".md")) files.push(path);
  }
  return files;
}

/** Every string a TypeScript source can hand an agent, with `+` chains joined into one. */
function agentStrings(file: string, source: string): string[] {
  const tree = parse(file, source);
  const texts: string[] = [];
  function piece(node: ts.Node): string | null {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isTemplateExpression(node)) {
      return node.head.text + node.templateSpans
        .map((span) => `\${${span.expression.getText(tree)}}${span.literal.text}`)
        .join("");
    }
    return null;
  }
  function operands(node: ts.Expression): ts.Expression[] {
    return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken
      ? [...operands(node.left), ...operands(node.right)]
      : [node];
  }
  function visit(node: ts.Node): void {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const parts = operands(node);
      if (parts.some((part) => piece(part) !== null)) {
        texts.push(parts.map((part) => piece(part) ?? `\${${part.getText(tree)}}`).join(""));
        for (const part of parts) {
          if (ts.isTemplateExpression(part)) part.templateSpans.forEach((span) => visit(span.expression));
          else if (piece(part) === null) visit(part);
        }
        return;
      }
    }
    const text = piece(node);
    if (text !== null) {
      texts.push(text);
      if (ts.isTemplateExpression(node)) node.templateSpans.forEach((span) => visit(span.expression));
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return texts;
}

/** A pull request or issue named by URL: literal, `<...url>` placeholder, or a `$...url` variable. */
const URL_TARGET_RE = /^["'(]?(?:https:\/\/github\.com\/|<[\w-]*url>|\$\{?[\w.]*url[\w.]*\}?)/i;
const BY_NUMBER_RE = /(?:^|[\s;&|(`])gh\s+(?:issue|pr)\s+(?:view|checks|comment|edit|close|reopen|merge|diff|review)\b((?:\s+--?[\w-]+(?=\s|$|`))*)(\s+[^\s`]+)?/g;
const PLACEHOLDER_RE = /(?<!\$)\{(?:owner|repo)\}/g;
/**
 * `gh pr create` in any spelling - flags between the words included, wrapped across a line as
 * hard-wrapped markdown does, named in prose or given as a command. At most four words may sit
 * between `gh` and `pr` (`--repo o/r`), so a match stays within a few words. It always reads the
 * fork's parent, so agent text never names it at all: the only place the string belongs is the
 * open-PR recognizer itself (`src/shared/pr-command.mjs`), which is code that detects it, not
 * text an agent reads.
 */
const PR_CREATE_ANY_RE = /(?<![\w-])gh(?:\s+[^\s`;|&]+){0,4}?\s+pr(?:\s+-[^\s`;|&]*)*\s+create(?![\w-])/g;
/**
 * Anything that reads a remote's URL, and any `repo=$(...)` assignment, which is how every
 * instruction sets the repository it names. Each must sit inside an exact copy of
 * `originRepositoryShell`, so no other spelling of the read - `git -C <dir> remote get-url`,
 * `--push`, a quoted `"origin"`, `ls-remote --get-url`, `git config remote.origin.url` - and no
 * other way of filling `$repo` gets past unread.
 */
const ORIGIN_READ_RE = /get-url|ls-remote|remote\s+(?:show|-v)(?![\w-])|remote\.[\w.-]*\.?url|(?<![\w$])repo=\$\(/g;

/** Where `text` lets gh choose the repository, one line per refusal. */
function agentTextProblems(where: string, quoted: string): string[] {
  // Blockquote markers read as spaces, so a command wrapped inside a quote is still one command;
  // same length, so every index and line number still points at the source.
  const text = quoted.replace(/^([ \t]*)(>[ \t>]*)/gm, (_m, lead: string, marks: string) => lead + " ".repeat(marks.length));
  const problems: string[] = [];
  const at = (index: number): string => `${where}:${text.slice(0, index).split("\n").length}`;
  for (const match of text.matchAll(PR_CREATE_ANY_RE)) {
    problems.push(`${at(match.index)} names \`gh pr create\`, which always reads the fork's parent; give openPullRequestCommand`);
  }
  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    problems.push(`${at(match.index)} uses gh's ${match[0]} placeholder; read $repo from origin with originRepositoryShell`);
  }
  for (const match of text.matchAll(BY_NUMBER_RE)) {
    const target = match[2]?.trim() ?? "";
    if (!URL_TARGET_RE.test(target)) {
      problems.push(`${at(match.index)} names ${target ? `"${target}"` : "no pull request or issue"} in "${match[0].trim()}"; name it by URL`);
    }
  }
  // Every read of origin is the exported line, character for character.
  const copies: [number, number][] = [];
  for (let i = text.indexOf(originRepositoryShell); i !== -1; i = text.indexOf(originRepositoryShell, i + 1)) {
    copies.push([i, i + originRepositoryShell.length]);
  }
  const drifted = new Set<string>();
  for (const match of text.matchAll(ORIGIN_READ_RE)) {
    if (!copies.some(([start, end]) => match.index >= start && match.index < end)) drifted.add(at(match.index));
  }
  for (const where of drifted) problems.push(`${where} reads origin with a line that is not originRepositoryShell`);
  return problems;
}

function agentTexts(): { where: string; text: string }[] {
  const markdown = [...markdownFiles(join(ROOT, "skills")), ...markdownFiles(join(ROOT, "actions"))]
    .map((path) => relative(ROOT, path))
    .filter((file) => !FROZEN_AGENT_TEXT.has(file))
    .map((file) => ({ where: file, text: readFileSync(join(ROOT, file), "utf8") }));
  const code = AGENT_TEXT_SOURCES.flatMap((file) =>
    agentStrings(file, readFileSync(join(ROOT, file), "utf8")).map((text) => ({ where: file, text })));
  return [...markdown, ...code];
}

test("agent instructions name their repository and never leave it to gh", () => {
  const texts = agentTexts();
  // The scan reads what it claims to: every skill, and the wrap-up's own command.
  assert.ok(texts.some(({ where }) => where === "skills/pull-request/SKILL.md"));
  assert.ok(texts.some(({ where, text }) => where === "src/shared/queue.ts" && text.includes("gh pr checks <pr-url>")));
  assert.deepEqual(texts.flatMap(({ where, text }) => agentTextProblems(where, text)), []);
});

test("the frozen pull-request action is exempt, not clean", () => {
  // If this stops failing the scan, the exemption is dead weight and should go.
  const text = readFileSync(join(ROOT, "actions/pull-request.md"), "utf8");
  assert.notDeepEqual(agentTextProblems("actions/pull-request.md", text), []);
});

test("agent text that leaves the repository to gh is refused", () => {
  assert.deepEqual(agentTextProblems("fixture.md", "Read it: `gh issue view 12 --comments`."), [
    'fixture.md:1 names "12" in "`gh issue view 12"; name it by URL',
  ]);
  assert.deepEqual(agentTextProblems("fixture.md", "Then\nrun `gh pr checks --watch`."), [
    'fixture.md:2 names no pull request or issue in "`gh pr checks --watch"; name it by URL',
  ]);
  assert.deepEqual(agentTextProblems("fixture.md", "`gh api repos/{owner}/{repo}/branches`"), [
    "fixture.md:1 uses gh's {owner} placeholder; read $repo from origin with originRepositoryShell",
    "fixture.md:1 uses gh's {repo} placeholder; read $repo from origin with originRepositoryShell",
  ]);
  // Every spelling of the open command is refused, named or given: an agent reading "open it
  // with `gh pr create`" runs it.
  for (const pr of [
    "Open it with `gh pr create --fill`.",
    "Open the pull request with `gh pr create`.",
    "```sh\ngh pr create\n```",
    "`gh --repo me/fork pr create --fill`",
    "`gh pr --draft create`",
    "never with `gh pr create`.",
    "Open the pull request with `gh pr\ncreate --fill`.",
    "Open it with `gh\npr create`.",
    "Open it with gh pr\ncreate.",
    "> Open it with `gh pr\n> create --fill`.",
  ]) {
    const line = pr.startsWith("```") ? 2 : 1; // the line `gh` starts on
    assert.deepEqual(agentTextProblems("fixture.md", pr), [
      `fixture.md:${line} names \`gh pr create\`, which always reads the fork's parent; give openPullRequestCommand`,
    ], pr);
  }
  // The names are fine: by URL in every form the instructions use, and `${repo}` is a shell variable.
  for (const ok of [
    "`gh issue view <issue-url> --comments`",
    "`gh pr checks <pr-url> --watch`",
    "`gh pr view https://github.com/me/fork/pull/3`",
    'gh pr comment "$PR_URL" --body-file x',
    "`gh pr view ${pr.url} --comments`",
    '`gh api "repos/${repo}/pulls"`',
    "never with gh's own pull request creation subcommand.",
    "`gh pr view <url>`, then `gh pr checks <url>`; create nothing",
    "`gh pr view <url>`, then\nonce the checks pass, create nothing",
    "Ask gh about it. A pull request can\nbe created later; do not create one.",
  ]) {
    assert.deepEqual(agentTextProblems("fixture.md", ok), [], ok);
  }
});

test("a drifted origin-reading line is refused", () => {
  assert.deepEqual(agentTextProblems("fixture.md", `\`${originRepositoryShell}\``), []);
  const drifted = "`repo=$(git remote get-url origin | sed -E 's#^.*github.com[:/]##; s#.git$##')`";
  assert.deepEqual(agentTextProblems("fixture.md", drifted), [
    "fixture.md:1 reads origin with a line that is not originRepositoryShell",
  ]);
  for (const other of [
    "`git config --get remote.origin.url`",
    `\`repo=$(git -C "$dir" remote get-url origin | sed -E 's#^.*github\\.com[:/]##; s#\\.git$##')\``,
    "`git remote get-url \"origin\"`",
    "`git remote get-url --push origin`",
    "`git ls-remote --get-url origin`",
    "`git remote -v`",
    "`repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner)`",
  ]) {
    assert.deepEqual(agentTextProblems("fixture.md", other), [
      "fixture.md:1 reads origin with a line that is not originRepositoryShell",
    ], other);
  }
  // A copy followed by more of the command is still the copy: the open command starts with one.
  assert.deepEqual(agentTextProblems("fixture.md", `\`${originRepositoryShell} && gh api "repos/$repo"\``), []);
});

test("TypeScript agent text is read through concatenation and templates, not comments", () => {
  const source = [
    "// `gh issue view 12` in a comment is for maintainers",
    'export const A = "Read `gh pr" + " view 12`, then " + `gh pr checks ${url} --watch`;',
  ].join("\n");
  const texts = agentStrings("fixture.ts", source);
  assert.deepEqual(texts, ["Read `gh pr view 12`, then gh pr checks ${url} --watch"]);
  assert.deepEqual(texts.flatMap((text) => agentTextProblems("fixture.ts", text)), [
    'fixture.ts:1 names "12" in "`gh pr view 12"; name it by URL',
  ]);
});
