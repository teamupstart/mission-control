import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  GH_ARGS,
  canonicalRemoteUrl,
  newestStableReleaseTag,
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
  assert.equal(newestStableReleaseTag({ run: gh.run }), "v1.2.3");
  for (const args of gh.seen) assert.ok(args.includes("--repo"));
});

test("a repository with no stable release yields no tag rather than a prerelease", () => {
  // The filtered query returns an empty list on a repository whose only releases are
  // prereleases or drafts, so the caller falls through to the default branch instead of
  // installing one.
  const gh = ghStub([]);
  assert.equal(newestStableReleaseTag({ run: gh.run }), null);
  assert.ok(gh.seen[0]?.includes("--exclude-pre-releases"));
  assert.ok(gh.seen[0]?.includes("--exclude-drafts"));

  assert.deepEqual(resolveTargetRef({ releaseTag: null, defaultBranchRef: "origin/main" }), {
    ref: "origin/main",
    source: "default-branch",
  });
});

test("a failed or unparseable release lookup yields no tag", () => {
  assert.equal(
    newestStableReleaseTag({ run: () => ({ status: 1, stdout: "" }) }),
    null,
  );
  assert.equal(
    newestStableReleaseTag({ run: () => ({ status: 0, stdout: "not json" }) }),
    null,
  );
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

test("a remote URL yields its repository and transport", () => {
  assert.deepEqual(parseRemote("git@github.com:mancej-cyc/ai-harness.git"), {
    slug: CANONICAL_REPO,
    transport: "ssh",
  });
  assert.deepEqual(parseRemote("ssh://git@github.com/mancej-cyc/ai-harness.git"), {
    slug: CANONICAL_REPO,
    transport: "ssh",
  });
  assert.deepEqual(parseRemote("https://github.com/mancej-cyc/ai-harness"), {
    slug: CANONICAL_REPO,
    transport: "https",
  });
  assert.equal(parseRemote(""), null);
  assert.equal(parseRemote("not a remote"), null);
});

test("the clone keeps the caller's transport and the canonical repository", () => {
  assert.equal(canonicalRemoteUrl("ssh"), `ssh://git@github.com/${CANONICAL_REPO}.git`);
  assert.equal(canonicalRemoteUrl("https"), `https://github.com/${CANONICAL_REPO}.git`);
  assert.equal(canonicalRemoteUrl("ssh", FORK), `ssh://git@github.com/${FORK}.git`);
});

test("a non-canonical origin is refused, and the message names both repositories", () => {
  const { repo, problem } = resolveInstallRepo({ originSlug: FORK });
  assert.equal(repo, null);
  assert.ok(problem?.includes(FORK));
  assert.ok(problem?.includes(CANONICAL_REPO));
  assert.ok(problem?.includes("--from-origin"));
});

test("--from-origin is the only way past the refusal, and the receipt records the fork", () => {
  assert.deepEqual(resolveInstallRepo({ originSlug: FORK, fromOrigin: true }), {
    repo: FORK,
    problem: null,
  });
  assert.deepEqual(resolveInstallRepo({ originSlug: CANONICAL_REPO, fromOrigin: true }), {
    repo: CANONICAL_REPO,
    problem: null,
  });
  assert.deepEqual(resolveInstallRepo({ originSlug: CANONICAL_REPO }), {
    repo: CANONICAL_REPO,
    problem: null,
  });
});

test("a checkout with no usable origin is refused with the reason", () => {
  const { repo, problem } = resolveInstallRepo({ originSlug: null });
  assert.equal(repo, null);
  assert.match(String(problem), /no usable `origin` remote/);
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
