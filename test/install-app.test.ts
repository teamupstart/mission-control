import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  GH_ARGS,
  REQUIRED_REMOTE_HOST,
  appsDirProblem,
  canonicalRemoteUrl,
  newestStableRelease,
  remoteProblem,
  stagingPaths,
  swapAppBundle,
  packagedVersionProblem,
  parseArgs,
  parseRemote,
  plistVersion,
  receiptReleaseTag,
  resolveInstallRepo,
  resolveTargetRef,
} from "../scripts/install-app.mjs";
import { CANONICAL_REPO } from "../src/shared/install-receipt-schema.mjs";

const FORK = "someone-else/ai-harness";

function ghStub(releases: { tagName: string }[], seen: string[][] = []) {
  return {
    seen,
    run(command: string, args: string[]) {
      assert.equal(command, "gh");
      seen.push(args);
      return { status: 0, stdout: JSON.stringify(releases) };
    },
  };
}

test("the release lookup names the repository and excludes drafts and prereleases", () => {
  const args = GH_ARGS.releaseList();
  assert.deepEqual(args, [
    "release",
    "list",
    "--repo",
    CANONICAL_REPO,
    "--exclude-drafts",
    "--exclude-pre-releases",
    "--order",
    "desc",
    "--limit",
    "1",
    "--json",
    "tagName",
  ]);
  // The trust boundary, asserted on the argv rather than trusted to a comment: without
  // --repo the CLI infers the repository from the checkout it runs in, so a fork checkout
  // would resolve fork-controlled code under the same tag name.
  assert.equal(args[args.indexOf("--repo") + 1], CANONICAL_REPO);
  assert.deepEqual(GH_ARGS.releaseList(FORK).slice(0, 4), ["release", "list", "--repo", FORK]);
});

test("the install script has exactly one place that names the GitHub CLI binary", () => {
  const source = readFileSync(new URL("../scripts/install-app.mjs", import.meta.url), "utf8");
  assert.equal(source.match(/"gh"/g)?.length, 1);
});

test("every release query the install script makes carries the repository", () => {
  const gh = ghStub([{ tagName: "v1.2.3" }]);
  assert.deepEqual(newestStableRelease({ run: gh.run }), { tag: "v1.2.3", problem: null });
  for (const args of gh.seen) assert.ok(args.includes("--repo"));
});

test("a repository with no stable release yields no tag rather than a prerelease", () => {
  // The filtered query returns an empty list on a repository whose only releases are
  // prereleases or drafts, so the caller falls through to the default branch instead of
  // installing one.
  const gh = ghStub([]);
  assert.deepEqual(newestStableRelease({ run: gh.run }), { tag: null, problem: null });
  assert.ok(gh.seen[0]?.includes("--exclude-pre-releases"));
  assert.ok(gh.seen[0]?.includes("--exclude-drafts"));

  assert.deepEqual(resolveTargetRef({ releaseTag: null, defaultBranchRef: "origin/main" }), {
    ref: "origin/main",
    source: "default-branch",
  });
});

test("a failed release lookup is a problem, not an empty release list", () => {
  // The distinction is the whole point: "no stable release yet" may fall back to the default
  // branch, while "GitHub could not be asked" must not, or a transient outage installs
  // unreleased code under a user who asked for a release.
  const failed = newestStableRelease({
    run: () => ({ status: 1, stdout: "", stderr: "HTTP 503: upstream connect error\nmore" }),
  });
  assert.equal(failed.tag, null);
  assert.match(String(failed.problem), /could not list .* releases \(gh exited 1\): HTTP 503/);
  assert.doesNotMatch(String(failed.problem), /more/);

  for (const stdout of ["not json", '{"tagName":"v1.2.3"}', '[{"name":"v1.2.3"}]']) {
    const result = newestStableRelease({ run: () => ({ status: 0, stdout }) });
    assert.equal(result.tag, null, stdout);
    assert.match(String(result.problem), /could not read the release list/, stdout);
  }
});

test("the target ref prefers --ref, then the newest stable release, then the branch tip", () => {
  assert.deepEqual(
    resolveTargetRef({ requestedRef: "v0.9.0", releaseTag: "v1.2.3", defaultBranchRef: "origin/main" }),
    { ref: "v0.9.0", source: "flag" },
  );
  assert.deepEqual(
    resolveTargetRef({ releaseTag: "v1.2.3", defaultBranchRef: "origin/main" }),
    { ref: "v1.2.3", source: "release" },
  );
});

test("the receipt records a release tag only when the installed ref is one", () => {
  assert.equal(receiptReleaseTag({ ref: "v1.2.3", source: "release" }), "v1.2.3");
  assert.equal(receiptReleaseTag({ ref: "v1.2.3", source: "flag" }), "v1.2.3");
  assert.equal(receiptReleaseTag({ ref: "origin/main", source: "default-branch" }), null);
  assert.equal(receiptReleaseTag({ ref: "9f0c1d2", source: "flag" }), null);
});

test("a remote URL yields its host, repository, and transport", () => {
  assert.deepEqual(parseRemote("git@github.com:mancej-cyc/ai-harness.git"), {
    host: REQUIRED_REMOTE_HOST,
    slug: CANONICAL_REPO,
    transport: "ssh",
  });
  assert.deepEqual(parseRemote("ssh://git@github.com/mancej-cyc/ai-harness.git"), {
    host: REQUIRED_REMOTE_HOST,
    slug: CANONICAL_REPO,
    transport: "ssh",
  });
  assert.deepEqual(parseRemote("https://github.com/mancej-cyc/ai-harness"), {
    host: REQUIRED_REMOTE_HOST,
    slug: CANONICAL_REPO,
    transport: "https",
  });
  assert.deepEqual(parseRemote("https://GitHub.com:443/mancej-cyc/ai-harness.git"), {
    host: REQUIRED_REMOTE_HOST,
    slug: CANONICAL_REPO,
    transport: "https",
  });
  assert.equal(parseRemote("https://attacker.example/mancej-cyc/ai-harness.git")?.host, "attacker.example");
  assert.equal(parseRemote(""), null);
  assert.equal(parseRemote("not a remote"), null);
});

test("a remote carrying the right owner and name from the wrong host is refused", () => {
  // The slug is not identity. This remote is about to be fetched and force-checked-out.
  assert.equal(
    remoteProblem({ url: "ssh://git@github.com/mancej-cyc/ai-harness.git", repo: CANONICAL_REPO }),
    null,
  );
  assert.equal(
    remoteProblem({ url: "https://github.com/mancej-cyc/ai-harness", repo: CANONICAL_REPO }),
    null,
  );
  assert.match(
    String(remoteProblem({ url: `https://attacker.example/${CANONICAL_REPO}.git`, repo: CANONICAL_REPO })),
    /hosted at attacker\.example, not github\.com/,
  );
  assert.match(
    String(remoteProblem({ url: `git@attacker.example:${CANONICAL_REPO}.git`, repo: CANONICAL_REPO })),
    /hosted at attacker\.example/,
  );
  assert.match(
    String(remoteProblem({ url: `https://github.com/${FORK}`, repo: CANONICAL_REPO })),
    /is someone-else\/ai-harness, not mancej-cyc\/ai-harness/,
  );
  assert.match(String(remoteProblem({ url: "", repo: CANONICAL_REPO })), /not a git remote URL/);
});

test("the clone keeps the caller's transport and the canonical repository", () => {
  assert.equal(canonicalRemoteUrl("ssh"), `ssh://git@github.com/${CANONICAL_REPO}.git`);
  assert.equal(canonicalRemoteUrl("https"), `https://github.com/${CANONICAL_REPO}.git`);
  assert.equal(canonicalRemoteUrl("ssh", FORK), `ssh://git@github.com/${FORK}.git`);
});

test("a non-canonical origin is refused, and the message names both repositories", () => {
  const { repo, problem } = resolveInstallRepo({ originSlug: FORK, originHost: REQUIRED_REMOTE_HOST });
  assert.equal(repo, null);
  assert.ok(problem?.includes(FORK));
  assert.ok(problem?.includes(CANONICAL_REPO));
  assert.ok(problem?.includes("--from-origin"));
});

test("--from-origin is the only way past the refusal, and the receipt records the fork", () => {
  const host = REQUIRED_REMOTE_HOST;
  assert.deepEqual(resolveInstallRepo({ originSlug: FORK, originHost: host, fromOrigin: true }), {
    repo: FORK,
    problem: null,
  });
  assert.deepEqual(
    resolveInstallRepo({ originSlug: CANONICAL_REPO, originHost: host, fromOrigin: true }),
    { repo: CANONICAL_REPO, problem: null },
  );
  assert.deepEqual(resolveInstallRepo({ originSlug: CANONICAL_REPO, originHost: host }), {
    repo: CANONICAL_REPO,
    problem: null,
  });
});

test("a checkout with no usable origin is refused with the reason", () => {
  const { repo, problem } = resolveInstallRepo({ originSlug: null, originHost: null });
  assert.equal(repo, null);
  assert.match(String(problem), /no usable `origin` remote/);
});

test("an origin on another host is refused, and --from-origin cannot wave it through", () => {
  // `canonicalRemoteUrl` always builds a github.com URL, so accepting another host would install
  // the same-named github.com repository instead of the one the caller is standing in.
  for (const fromOrigin of [false, true]) {
    const { repo, problem } = resolveInstallRepo({
      originSlug: CANONICAL_REPO,
      originHost: "attacker.example",
      fromOrigin,
    });
    assert.equal(repo, null);
    assert.match(String(problem), /hosted at attacker\.example, not github\.com/);
  }
});

test("the packaged app is verified against the source tree before the swap", () => {
  const plist = `<plist><dict>
  <key>CFBundleShortVersionString</key>
  <string>1.2.3</string>
</dict></plist>`;
  assert.equal(plistVersion(plist), "1.2.3");
  assert.equal(plistVersion("<plist></plist>"), null);
  assert.equal(packagedVersionProblem({ packagedVersion: "1.2.3", sourceVersion: "1.2.3" }), null);
  assert.match(
    String(packagedVersionProblem({ packagedVersion: "1.2.2", sourceVersion: "1.2.3" })),
    /packaged app reports version 1\.2\.2 but the source tree is 1\.2\.3/,
  );
  assert.match(
    String(packagedVersionProblem({ packagedVersion: null, sourceVersion: "1.2.3" })),
    /CFBundleShortVersionString/,
  );
});

test("install arguments parse, and an unknown one stops the install", () => {
  assert.deepEqual(parseArgs(["--dry-run", "--ref", "v1.2.3", "--from-origin"]), {
    options: { ref: "v1.2.3", fromOrigin: true, dryRun: true, appsDir: "/Applications" },
    help: false,
    problem: null,
  });
  assert.equal(parseArgs(["--ref"]).problem, "--ref needs a value");
  assert.equal(parseArgs(["--wat"]).problem, "unknown argument: --wat");
  assert.equal(parseArgs(["--help"]).help, true);
  assert.equal(parseArgs(["--apps-dir", "/tmp/apps"]).options.appsDir, "/tmp/apps");
});

test("a missing install directory stops the install before the copy invents one", () => {
  // `cp -R app dir` creates `dir` as the bundle when it does not exist, so a mistyped
  // --apps-dir would otherwise produce an app named after the typo.
  assert.equal(
    appsDirProblem({ appsDir: "/Applications", exists: true, isDirectory: true }),
    null,
  );
  assert.match(
    String(appsDirProblem({ appsDir: "/tmp/nope", exists: false, isDirectory: false })),
    /does not exist/,
  );
  assert.match(
    String(appsDirProblem({ appsDir: "/tmp/file", exists: true, isDirectory: false })),
    /not a directory/,
  );
});

/** A fake filesystem for the swap: records every operation and can fail a chosen one. */
function bundleFs(present: string[], failOn: { copy?: boolean; move?: (from: string) => boolean } = {}) {
  const paths = new Set(present);
  const log: string[] = [];
  return {
    paths,
    log,
    ops: {
      copy(from: string, to: string) {
        log.push(`copy ${from} -> ${to}`);
        if (failOn.copy) throw new Error("No space left on device");
        paths.add(to);
      },
      move(from: string, to: string) {
        log.push(`move ${from} -> ${to}`);
        if (failOn.move?.(from)) throw new Error("Input/output error");
        paths.delete(from);
        paths.add(to);
      },
      remove(path: string) {
        log.push(`remove ${path}`);
        paths.delete(path);
      },
      exists(path: string) {
        return paths.has(path);
      },
    },
  };
}

const SWAP = {
  packagedApp: "/clone/release/mac-arm64/Mission Control.app",
  appPath: "/Applications/Mission Control.app",
  appsDir: "/Applications",
  pid: 4242,
};

test("the staged bundle and the set-aside app are hidden siblings of the destination", () => {
  const { staged, previous } = stagingPaths({ appsDir: "/Applications", pid: 4242 });
  // Same directory, so both moves below are renames on one filesystem rather than a second copy.
  assert.equal(staged, "/Applications/.Mission Control.app.incoming-4242");
  assert.equal(previous, "/Applications/.Mission Control.app.previous-4242");
  assert.notEqual(staged, previous);
});

test("the app is copied to a staging path first and only then swapped in", () => {
  const fs = bundleFs([SWAP.appPath]);
  const { staged, previous } = stagingPaths(SWAP);
  assert.equal(swapAppBundle({ ...SWAP, ops: fs.ops }), null);
  assert.deepEqual(fs.log, [
    `remove ${staged}`,
    `copy ${SWAP.packagedApp} -> ${staged}`,
    `move ${SWAP.appPath} -> ${previous}`,
    `move ${staged} -> ${SWAP.appPath}`,
    `remove ${previous}`,
  ]);
  assert.ok(fs.paths.has(SWAP.appPath));
  assert.ok(!fs.paths.has(staged));
  assert.ok(!fs.paths.has(previous));
});

test("a failed copy leaves the installed app exactly where it was", () => {
  // The finding this closes: removing the app before copying left a user with no app at all
  // when the copy failed on a full disk, which is worse than the failed upgrade they had.
  const fs = bundleFs([SWAP.appPath], { copy: true });
  const problem = swapAppBundle({ ...SWAP, ops: fs.ops });
  assert.match(String(problem), /could not stage the new app/);
  assert.match(String(problem), /No space left on device/);
  assert.match(String(problem), /is unchanged/);
  assert.deepEqual([...fs.paths], [SWAP.appPath]);
});

test("a failed move-aside leaves the installed app in place and cleans the staging path", () => {
  const fs = bundleFs([SWAP.appPath], { move: (from) => from === SWAP.appPath });
  const problem = swapAppBundle({ ...SWAP, ops: fs.ops });
  assert.match(String(problem), /could not move the existing app aside/);
  assert.match(String(problem), /is unchanged/);
  assert.deepEqual([...fs.paths], [SWAP.appPath]);
});

test("a failed final move restores the previous app", () => {
  const { staged } = stagingPaths(SWAP);
  const fs = bundleFs([SWAP.appPath], { move: (from) => from === staged });
  const problem = swapAppBundle({ ...SWAP, ops: fs.ops });
  assert.match(String(problem), /could not put the new app in place/);
  assert.match(String(problem), /previous app was restored/);
  assert.deepEqual([...fs.paths], [SWAP.appPath]);
});

test("a first install needs no previous app, and reports when nothing was installed", () => {
  const fs = bundleFs([]);
  const { staged, previous } = stagingPaths(SWAP);
  assert.equal(swapAppBundle({ ...SWAP, ops: fs.ops }), null);
  assert.ok(!fs.log.includes(`move ${SWAP.appPath} -> ${previous}`));
  assert.ok(fs.paths.has(SWAP.appPath));

  const failing = bundleFs([], { move: (from) => from === staged });
  assert.match(String(swapAppBundle({ ...SWAP, ops: failing.ops })), /Nothing was installed/);
  assert.deepEqual([...failing.paths], []);
});

test("a staging path left by a killed run is cleared before staging", () => {
  const { staged } = stagingPaths(SWAP);
  const fs = bundleFs([SWAP.appPath, staged]);
  assert.equal(swapAppBundle({ ...SWAP, ops: fs.ops }), null);
  assert.equal(fs.log[0], `remove ${staged}`);
});
