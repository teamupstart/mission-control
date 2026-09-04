import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  ADMINISTRATOR_AUTHORIZATION_PROMPT,
  APP_BUNDLE_NAME,
  PRIVILEGED_SWAP_APPLESCRIPT,
  RESTORE_AUTHORIZATION_PROMPT,
  attemptSwapAppBundle,
  bundleOwnerSpec,
  bundleSwapShellCommand,
  directoryIsWritable,
  displacedBundlePid,
  directoryTreeIsWritable,
  privilegedBundleSwapCommand,
  replaceAppBundle,
  sweepDisplacedBundles,
} from "../scripts/app-bundle-swap.mjs";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  GH_ARGS,
  REQUIRED_REMOTE_HOST,
  appsDirProblem,
  canonicalRemoteUrl,
  existingCloneCommands,
  firstUnwritableCloneDirectory,
  newestStableRelease,
  remoteProblem,
  stagingPaths,
  swapAppBundle,
  packagedVersionProblem,
  isolateStagedBundle,
  parseArgs,
  stagedVersionProblem,
  parseRemote,
  plistVersion,
  receiptReleaseTag,
  rebuildUpdaterOwnedClone,
  resolveInstallRepo,
  resolveTargetRef,
} from "../scripts/install-app.mjs";
import { CANONICAL_REPO } from "../src/shared/install-receipt-schema.mjs";
import { stagedBundleRevision } from "../src/shared/staged-bundle.mjs";

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
  assert.deepEqual(parseRemote("git@github.com:teamupstart/mission-control.git"), {
    host: REQUIRED_REMOTE_HOST,
    slug: CANONICAL_REPO,
    transport: "ssh",
  });
  assert.deepEqual(parseRemote("ssh://git@github.com/teamupstart/mission-control.git"), {
    host: REQUIRED_REMOTE_HOST,
    slug: CANONICAL_REPO,
    transport: "ssh",
  });
  assert.deepEqual(parseRemote("https://github.com/teamupstart/mission-control"), {
    host: REQUIRED_REMOTE_HOST,
    slug: CANONICAL_REPO,
    transport: "https",
  });
  assert.deepEqual(parseRemote("https://GitHub.com:443/teamupstart/mission-control.git"), {
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
    remoteProblem({ url: "ssh://git@github.com/teamupstart/mission-control.git", repo: CANONICAL_REPO }),
    null,
  );
  assert.equal(
    remoteProblem({ url: "https://github.com/teamupstart/mission-control", repo: CANONICAL_REPO }),
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
    /is someone-else\/ai-harness, not teamupstart\/mission-control/,
  );
  assert.match(String(remoteProblem({ url: "", repo: CANONICAL_REPO })), /not a git remote URL/);
});

test("the updater-owned clone's former canonical remote is accepted for migration", () => {
  assert.deepEqual(
    existingCloneCommands({
      url: "ssh://git@github.com/mancej-cyc/ai-harness.git",
      repo: CANONICAL_REPO,
      clone: "/state/app-src",
    }),
    {
      problem: null,
      commands: [
        [
          "git",
          [
            "-C",
            "/state/app-src",
            "remote",
            "set-url",
            "origin",
            "ssh://git@github.com/teamupstart/mission-control.git",
          ],
        ],
        ["git", ["-C", "/state/app-src", "fetch", "--tags", "--prune", "origin"]],
      ],
    },
  );
});

test("a privileged updater clone is replaced without depending on permissions inside it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mission-privileged-clone-"));
  const origin = join(root, "origin");
  const clone = join(root, "app-src");
  const locked = join(clone, "src", "server", "setup");
  const preserved = `${clone}.unusable-4242`;
  t.after(() => {
    try { chmodSync(join(preserved, "src", "server", "setup"), 0o755); } catch {}
    rmSync(root, { recursive: true, force: true });
  });

  mkdirSync(join(origin, "src", "server", "setup"), { recursive: true });
  const git = (args: string[], cwd = origin) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  };
  git(["init", "--initial-branch=main"]);
  git(["config", "user.email", "updater-test@example.invalid"]);
  git(["config", "user.name", "Updater Test"]);
  writeFileSync(join(origin, "src", "server", "setup", "index.ts"), "export const version = 1;\n");
  git(["add", "."]);
  git(["commit", "-m", "initial"]);
  const initial = spawnSync("git", ["rev-parse", "HEAD"], { cwd: origin, encoding: "utf8" }).stdout.trim();
  writeFileSync(join(origin, "src", "server", "setup", "index.ts"), "export const version = 2;\n");
  git(["add", "."]);
  git(["commit", "-m", "update"]);
  git(["clone", origin, clone], root);
  git(["checkout", "--force", initial], clone);

  // This is the end-user failure shape from the live updater-owned clone: the clone root is
  // writable, but a nested directory cannot unlink the tracked file Git needs to replace.
  chmodSync(locked, 0o555);
  assert.equal(firstUnwritableCloneDirectory(clone), locked);
  const checkout = spawnSync("git", ["checkout", "--force", "main"], {
    cwd: clone,
    encoding: "utf8",
  });
  assert.notEqual(checkout.status, 0);
  assert.match(checkout.stderr, /unable to unlink old .*src\/server\/setup\/index\.ts/);

  const result = rebuildUpdaterOwnedClone({
    clone,
    remoteUrl: origin,
    pid: 4242,
    run: (command: string, args: string[]) => {
      const child = spawnSync(command, args, { encoding: "utf8" });
      return {
        status: child.status ?? 1,
        stdout: child.stdout ?? "",
        stderr: child.stderr ?? "",
      };
    },
    ops: {
      exists: existsSync,
      move: renameSync,
      remove: (path: string) => rmSync(path, { recursive: true, force: true }),
    },
  });

  assert.deepEqual(result, { problem: null, preserved });
  assert.equal(firstUnwritableCloneDirectory(clone), null);
  assert.equal(readFileSync(join(clone, "src", "server", "setup", "index.ts"), "utf8"), "export const version = 2;\n");
  assert.ok(existsSync(preserved), "the clone that needs privileged cleanup remains recoverable");
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

test("the former canonical origin resolves to the current canonical repository", () => {
  assert.deepEqual(
    resolveInstallRepo({ originSlug: "mancej-cyc/ai-harness", originHost: REQUIRED_REMOTE_HOST }),
    { repo: CANONICAL_REPO, problem: null },
  );
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
    options: {
      ref: "v1.2.3",
      fromOrigin: true,
      dryRun: true,
      appsDir: "/Applications",
      progress: false,
      stageOnly: false,
      fromStaged: null,
      stagedRevision: null,
    },
    help: false,
    problem: null,
  });
  assert.equal(parseArgs(["--ref"]).problem, "--ref needs a value");
  assert.equal(parseArgs(["--wat"]).problem, "unknown argument: --wat");
  assert.equal(parseArgs(["--help"]).help, true);
  assert.equal(parseArgs(["--apps-dir", "/tmp/apps"]).options.appsDir, "/tmp/apps");
});

test("the two halves of an update are selected by flags, and never both at once", () => {
  // The app builds with `--stage-only` while it is still open, and the detached helper
  // installs that bundle with `--from-staged` after it quits. An older install script has
  // neither, and says so in the words `stagingUnsupported` looks for.
  const staged = parseArgs(["--stage-only", "--progress", "--ref", "v1.2.4"]);
  assert.equal(staged.problem, null);
  assert.equal(staged.options.stageOnly, true);
  assert.equal(staged.options.progress, true);
  assert.equal(staged.options.fromStaged, null);

  const install = parseArgs([
    "--from-staged",
    "/state/app-src/release/mac-arm64/Mission Control.app",
    "--staged-revision",
    "8675309-1700000000000",
  ]);
  assert.equal(install.problem, null);
  assert.equal(
    install.options.fromStaged,
    "/state/app-src/release/mac-arm64/Mission Control.app",
  );
  assert.equal(install.options.stageOnly, false);
  // The pin the app took when it verified that bundle, checked again in the instant before the
  // swap because the app cannot look any later than its own quit.
  assert.equal(install.options.stagedRevision, "8675309-1700000000000");
  assert.equal(parseArgs(["--staged-revision"]).problem, "--staged-revision needs a value");
  assert.equal(parseArgs(["--from-staged", "/tmp/a.app"]).options.stagedRevision, null);

  assert.equal(parseArgs(["--from-staged"]).problem, "--from-staged needs a value");
  assert.equal(
    parseArgs(["--stage-only", "--from-staged", "/tmp/a.app"]).problem,
    "--stage-only and --from-staged cannot be combined",
  );
});

test("a staged bundle is refused unless its version is the one the ref names", () => {
  // The second half of an update runs minutes after the first, against a bundle in the shared
  // updater-owned clone. `--from-staged` used to read the bundle's version and install it
  // whatever it was, so a clone rebuilt at another ref in between would be installed under a
  // receipt naming the tag the person actually accepted.
  assert.equal(stagedVersionProblem({ stagedVersion: "1.2.4", ref: "v1.2.4" }), null);
  assert.match(
    String(stagedVersionProblem({ stagedVersion: "1.5.0", ref: "v1.2.4" })),
    /staged app is version 1\.5\.0 but v1\.2\.4 was requested/,
  );
  assert.match(
    String(stagedVersionProblem({ stagedVersion: null, ref: "v1.2.4" })),
    /could not read the staged app's version/,
  );
  // A ref that names no version states no expectation, exactly as `receiptReleaseTag` treats
  // the same refs: a branch or a sha carries no version to compare.
  assert.equal(stagedVersionProblem({ stagedVersion: "1.2.4", ref: "origin/main" }), null);
  assert.equal(stagedVersionProblem({ stagedVersion: "1.2.4", ref: "9f2c1ab" }), null);
  assert.equal(stagedVersionProblem({ stagedVersion: "1.2.4", ref: null }), null);
});

test(
  "the real staged install refuses a bundle replaced after it was pinned",
  // The script refuses a non-Apple-silicon host before it reaches anything this asserts, which
  // is correct - a macOS bundle cannot be installed on a Linux runner - so this one case runs
  // where the product runs. The rules it exercises (`stagedVersionProblem`,
  // `stagedRevisionProblem`) are covered on every platform by the tests above; what only this
  // can prove is that the swap path CALLS them.
  { skip: process.platform !== "darwin" || process.arch !== "arm64" },
  async (t) => {
  // Asserted by running `install-app.mjs` rather than its predicates, because the defect this
  // guards is a missing CALL: the pure rule can be perfect while nothing consults it. The app
  // takes this pin when the build is verified and cannot look again after it quits, so the
  // script is the last reader before the swap.
  const root = await mkdtemp(join(tmpdir(), "mission-staged-pin-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = join(root, "staged", "Mission Control.app");
  const appsDir = join(root, "apps");
  const stateDirectory = join(root, "state");
  await mkdir(join(bundle, "Contents"), { recursive: true });
  await mkdir(appsDir, { recursive: true });
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(
    join(bundle, "Contents", "Info.plist"),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0">',
      "<dict><key>CFBundleShortVersionString</key><string>9.9.9</string></dict>",
      "</plist>",
    ].join("\n"),
  );

  const run = (revision: string): { code: number | null; output: string } => {
    const result = spawnSync(
      process.execPath,
      [
        join(process.cwd(), "scripts", "install-app.mjs"),
        "--from-staged",
        bundle,
        "--ref",
        "v9.9.9",
        "--staged-revision",
        revision,
        "--apps-dir",
        appsDir,
      ],
      { encoding: "utf8", env: { ...process.env, MISSION_HOME: stateDirectory } },
    );
    return { code: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  };

  const pinned = stagedBundleRevision(statSync(bundle));
  assert.ok(pinned, "the staged bundle should have an identity to pin");

  // A pin that does not match what is there - the shape a rebuild of the shared clone leaves,
  // same version and all.
  const refused = run("1-1");
  assert.equal(refused.code, 1);
  assert.match(refused.output, /replaced after it was prepared/);
  assert.deepEqual(readdirSync(appsDir), [], "nothing may reach the apps dir");
  assert.equal(existsSync(join(stateDirectory, "install-receipt.json")), false);

  // The bundle the app actually verified still installs, so the guard is not simply refusing.
  const installed = run(pinned!);
  assert.equal(installed.code, 0, installed.output);
  assert.equal(existsSync(join(appsDir, "Mission Control.app")), true);
  assert.equal(existsSync(join(stateDirectory, "install-receipt.json")), true);
  },
);

test("isolating a verified bundle never damages a build that is not ours", () => {
  // The whole transaction, with its mutations injected, because the case that matters cannot be
  // provoked from outside: another builder replacing the bundle in the microsecond between the
  // pin check and the rename, and then recreating the path so the restore cannot land.
  const bundle = "/state/app-src/release/mac-arm64/Mission Control.app";
  const isolated = "/state/staged-install-4242";
  const moved = `${isolated}/Mission Control.app`;
  const pinned = "42-1700000000000";

  const record = (revisions: Record<string, string | null>, over: Partial<{ move: (from: string, to: string) => void }> = {}) => {
    const acted: string[] = [];
    const ops = {
      revision: (path: string) => revisions[path] ?? null,
      remove: (path: string) => acted.push(`remove:${path}`),
      makeDirectory: (path: string) => acted.push(`mkdir:${path}`),
      move: (from: string, to: string) => {
        acted.push(`move:${from}->${to}`);
        if (over.move) over.move(from, to);
      },
    };
    return { ops, acted };
  };

  // The ordinary case: pin matches, bundle comes out of the clone, and it is ours to clean up.
  {
    const { ops, acted } = record({ [bundle]: pinned, [moved]: pinned });
    const result = isolateStagedBundle({
      bundle,
      isolated,
      expectedRevision: pinned,
      bundleName: "Mission Control.app",
      ops,
    });
    assert.deepEqual(result, {
      sourceBundle: moved,
      problem: null,
      keepIsolated: false,
      rescued: null,
      inPlace: null,
    });
    assert.deepEqual(acted, [`remove:${isolated}`, `mkdir:${isolated}`, `move:${bundle}->${moved}`]);
  }

  // Fails the pin before anything is touched: it is somebody else's build, and it stays put.
  {
    const { ops, acted } = record({ [bundle]: "someone-elses" });
    const result = isolateStagedBundle({
      bundle,
      isolated,
      expectedRevision: pinned,
      bundleName: "Mission Control.app",
      ops,
    });
    assert.equal(result.sourceBundle, null);
    assert.match(String(result.problem), /replaced after it was prepared/);
    assert.equal(result.keepIsolated, false);
    assert.deepEqual(acted, [], "nothing may be moved or removed on this path");
  }

  // The race, recovered: what came across is not what was checked, and it goes back.
  {
    const { ops, acted } = record({ [bundle]: pinned, [moved]: "arrived-mid-rename" });
    const result = isolateStagedBundle({
      bundle,
      isolated,
      expectedRevision: pinned,
      bundleName: "Mission Control.app",
      ops,
    });
    assert.equal(result.sourceBundle, null);
    assert.match(String(result.problem), /replaced after it was prepared/);
    assert.equal(result.keepIsolated, false);
    assert.equal(result.rescued, null);
    assert.ok(acted.includes(`move:${moved}->${bundle}`), acted.join(", "));
  }

  // The race, unrecoverable - the other builder already recreated the path, so the restore
  // cannot land. The moved directory is then the only copy of THEIR build: it is kept, and its
  // location reported, rather than cleaned up.
  {
    const { ops } = record(
      { [bundle]: pinned, [moved]: "arrived-mid-rename" },
      {
        move: (_from, to) => {
          if (to === bundle) throw new Error("ENOTEMPTY: directory not empty");
        },
      },
    );
    const result = isolateStagedBundle({
      bundle,
      isolated,
      expectedRevision: pinned,
      bundleName: "Mission Control.app",
      ops,
    });
    assert.equal(result.sourceBundle, null);
    assert.match(String(result.problem), /replaced after it was prepared/);
    assert.equal(result.keepIsolated, true, "the other build must not be deleted");
    assert.equal(result.rescued, moved, "and a person must be told where it is");
  }

  // A rename that cannot cross filesystems falls back to installing in place, which is what
  // this script always did. The pin was already checked; only the window stays open.
  {
    const { ops, acted } = record(
      { [bundle]: pinned },
      {
        move: () => {
          throw new Error("EXDEV: cross-device link not permitted");
        },
      },
    );
    const result = isolateStagedBundle({
      bundle,
      isolated,
      expectedRevision: pinned,
      bundleName: "Mission Control.app",
      ops,
    });
    assert.equal(result.sourceBundle, bundle);
    assert.equal(result.problem, null);
    assert.equal(result.keepIsolated, false);
    assert.match(String(result.inPlace), /EXDEV/);
    assert.ok(acted.filter((entry) => entry === `remove:${isolated}`).length >= 1);
  }

  // No pin means nobody staged this: a plain `make install` leaves its build in `release/`,
  // where a developer expects to find it.
  {
    const { ops, acted } = record({ [bundle]: pinned });
    const result = isolateStagedBundle({
      bundle,
      isolated,
      expectedRevision: null,
      bundleName: "Mission Control.app",
      ops,
    });
    assert.equal(result.sourceBundle, bundle);
    assert.equal(result.problem, null);
    assert.deepEqual(acted, []);
  }
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
function bundleFs(
  present: string[],
  failOn: {
    copy?: boolean;
    move?: (from: string, to: string) => boolean;
    remove?: (path: string) => boolean;
  } = {},
) {
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
        if (failOn.move?.(from, to)) throw new Error("Input/output error");
        paths.delete(from);
        paths.add(to);
      },
      remove(path: string) {
        log.push(`remove ${path}`);
        if (failOn.remove?.(path)) throw new Error("Operation not permitted");
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
  const { staged, previous, failed } = stagingPaths({ appsDir: "/Applications", pid: 4242 });
  // Same directory, so both moves below are renames on one filesystem rather than a second copy.
  assert.equal(staged, "/Applications/.Mission Control.app.incoming-4242");
  assert.equal(previous, "/Applications/.Mission Control.app.previous-4242");
  assert.equal(failed, "/Applications/.Mission Control.app.failed-update");
  assert.notEqual(staged, previous);
});

test("an unwritable /Applications uses one narrowly scoped administrator transaction", () => {
  const commands: string[] = [];
  const result = replaceAppBundle({
    sourceBundle: "/private/tmp/Mission 'Control.app",
    appPath: "/Applications/Mission Control.app",
    appsDir: "/Applications",
    pid: 4242,
    platform: "darwin",
    appsDirWritable: false,
    runElevated: (command) => commands.push(command),
  });

  assert.deepEqual(result, {
    problem: null,
    elevated: true,
    failedBundle: null,
    stranded: [],
  });
  assert.equal(commands.length, 1);
  assert.match(commands[0]!, /^set -eu\n/);
  assert.match(commands[0]!, /\/bin\/cp -R/);
  assert.match(commands[0]!, /'"'"'/, "a quote in the source path is shell-escaped");
  assert.match(commands[0]!, /\/Applications\/\.Mission Control\.app\.incoming-4242/);
  assert.match(commands[0]!, /\/Applications\/Mission Control\.app/);
  // The transaction, its source path, and now the prompt all arrive only through argv after
  // the path checks above. Nothing a caller supplies is interpolated into the script source.
  assert.doesNotMatch(PRIVILEGED_SWAP_APPLESCRIPT, /private\/tmp|Mission Control\.app/);
  assert.match(PRIVILEGED_SWAP_APPLESCRIPT, /with administrator privileges/);
  assert.match(PRIVILEGED_SWAP_APPLESCRIPT, /with prompt \(item 2 of argv\)/);
  assert.doesNotMatch(PRIVILEGED_SWAP_APPLESCRIPT, /needs administrator permission/);
  assert.equal(
    ADMINISTRATOR_AUTHORIZATION_PROMPT,
    "Mission Control needs administrator permission to install this update in /Applications.",
  );
});

test("the install and the rollback ask for authorization in their own words", () => {
  // One shared prompt meant the panel that UNDOES an update still read "install this update",
  // so the only reading available to the person answering it was that approving it applied the
  // upgrade. The failing update log records exactly that: the install panel was dismissed and
  // the rollback panel authorized, leaving the old app in place and the update reported failed.
  assert.match(ADMINISTRATOR_AUTHORIZATION_PROMPT, /install this update/);
  assert.match(RESTORE_AUTHORIZATION_PROMPT, /restore the previous app/);
  assert.notEqual(ADMINISTRATOR_AUTHORIZATION_PROMPT, RESTORE_AUTHORIZATION_PROMPT);

  const prompts: string[] = [];
  replaceAppBundle({
    sourceBundle: "/private/tmp/Mission Control.app",
    appPath: "/Applications/Mission Control.app",
    appsDir: "/Applications",
    pid: 4242,
    platform: "darwin",
    appsDirWritable: false,
    prompt: RESTORE_AUTHORIZATION_PROMPT,
    runElevated: (_command, prompt) => prompts.push(prompt),
  });
  assert.deepEqual(prompts, [RESTORE_AUTHORIZATION_PROMPT]);
});

test("an elevated install hands the new bundle back to the signed-in account", () => {
  // The ratchet this closes: the privileged `cp` runs as root, so every elevated install left a
  // root-owned bundle - and a root-owned bundle is what sent the NEXT update down the
  // privileged path too. One install needing authorization made all of them need it.
  const commands: string[] = [];
  replaceAppBundle({
    sourceBundle: "/private/tmp/Mission Control.app",
    appPath: "/Applications/Mission Control.app",
    appsDir: "/Applications",
    pid: 4242,
    platform: "darwin",
    appsDirWritable: false,
    owner: "501:20",
    runElevated: (command) => commands.push(command),
  });

  const staged = "/Applications/.Mission Control.app.incoming-4242";
  assert.match(commands[0]!, /\/usr\/sbin\/chown -R '501:20'/);
  // Before the bundle goes live and inside `set -eu`, so a chown that fails fails while the
  // installed app is still untouched rather than after it has been replaced.
  const chownAt = commands[0]!.indexOf("chown");
  const liveAt = commands[0]!.indexOf(`/bin/mv '${staged}' '/Applications/Mission Control.app'`);
  assert.ok(chownAt > 0 && liveAt > chownAt, "the chown precedes the decisive move");
  assert.doesNotMatch(commands[0]!, /chown[^\n]*\|\| true/);
});

test("the privileged transaction refuses a non-numeric owner", () => {
  // Numeric ids only: name lookup is not dependable in this authorization context - authd logs
  // `User not found` for the very account it then matches by uid - and a name is a string the
  // shell transaction would have to trust.
  const plan = privilegedBundleSwapCommand({
    sourceBundle: "/private/tmp/Mission Control.app",
    appPath: "/Applications/Mission Control.app",
    appsDir: "/Applications",
    pid: 4242,
    keepPrevious: false,
    owner: "root:wheel",
  });
  assert.equal(plan.command, null);
  assert.match(String(plan.problem), /numeric uid:gid/);
});

test("a bundle this account cannot rewrite is replaced without asking for authorization", () => {
  // The defect this closes, and the whole reason auto-upgrade kept failing. A previous elevated
  // install leaves a root-owned bundle, and the writability check demanded write access to every
  // directory INSIDE it before it would use the ordinary filesystem path. The transaction never
  // writes into that bundle - it stages a sibling, renames the old bundle aside, and renames the
  // new one in, all of which need `appsDir` alone - so the prompt it forced was never required.
  //
  // Modelled the way the real failure presents: `/Applications` is writable, and the outgoing
  // bundle is not. `move` and `copy` therefore succeed, which is what the filesystem does.
  const fs = bundleFs([SWAP.appPath]);
  const prompts: string[] = [];
  const result = replaceAppBundle({
    sourceBundle: SWAP.packagedApp,
    appPath: SWAP.appPath,
    appsDir: SWAP.appsDir,
    pid: 4242,
    platform: "darwin",
    appsDirWritable: true,
    sweep: () => [],
    ops: fs.ops,
    runElevated: (_command, prompt) => prompts.push(prompt),
  });

  assert.equal(result.problem, null);
  assert.equal(result.elevated, false, "no administrator authorization was requested");
  assert.deepEqual(prompts, [], "no authorization panel was raised");
  assert.ok(fs.paths.has(SWAP.appPath), "the new app is live");
});

test("authorization is requested only after the plain attempt has failed", () => {
  // Attempt, then escalate - rather than predicting which path will work. A move that genuinely
  // cannot be done unprivileged still reaches the administrator transaction, so nothing that
  // used to be installable stops being installable.
  const { staged } = stagingPaths(SWAP);
  const fs = bundleFs([SWAP.appPath], { move: (from) => from === staged });
  const prompts: string[] = [];
  const result = replaceAppBundle({
    sourceBundle: SWAP.packagedApp,
    appPath: SWAP.appPath,
    appsDir: SWAP.appsDir,
    pid: 4242,
    platform: "darwin",
    appsDirWritable: true,
    sweep: () => [],
    ops: fs.ops,
    runElevated: (_command, prompt) => prompts.push(prompt),
  });

  assert.equal(result.problem, null);
  assert.equal(result.elevated, true);
  assert.deepEqual(prompts, [ADMINISTRATOR_AUTHORIZATION_PROMPT]);
});

test("a plain attempt that left the app dismantled is not retried with authorization", () => {
  // The one failure that must NOT escalate: the app was moved aside and could not be moved back,
  // so a privileged retry would stage over a half-dismantled destination. Reported, not retried.
  const { staged, previous } = stagingPaths(SWAP);
  const fs = bundleFs([SWAP.appPath], {
    move: (from) => from === staged || from === previous,
  });
  const prompts: string[] = [];
  const result = replaceAppBundle({
    sourceBundle: SWAP.packagedApp,
    appPath: SWAP.appPath,
    appsDir: SWAP.appsDir,
    pid: 4242,
    platform: "darwin",
    appsDirWritable: true,
    sweep: () => [],
    ops: fs.ops,
    runElevated: (_command, prompt) => prompts.push(prompt),
  });

  assert.match(String(result.problem), /move it back by hand/);
  assert.equal(result.elevated, false);
  assert.deepEqual(prompts, [], "no authorization was requested for an unsafe retry");
});

test("an escalated failure reports why the plain attempt failed as well", () => {
  // "User canceled" on its own reads as the whole story. It is not: an ordinary install was
  // tried first, and why THAT could not finish is what tells anyone reading the log what to fix.
  const { staged } = stagingPaths(SWAP);
  const fs = bundleFs([SWAP.appPath], { move: (from) => from === staged });
  const result = replaceAppBundle({
    sourceBundle: SWAP.packagedApp,
    appPath: SWAP.appPath,
    appsDir: SWAP.appsDir,
    pid: 4242,
    platform: "darwin",
    appsDirWritable: true,
    sweep: () => [],
    ops: fs.ops,
    runElevated: () => {
      throw new Error("execution error: User canceled. (-128)");
    },
  });

  assert.match(String(result.problem), /could not put the new app in place/);
  assert.match(String(result.problem), /User canceled/);
});

test("the attempt reports whether the installed app survived a failure", () => {
  const failedCopy = attemptSwapAppBundle({
    ...SWAP,
    ops: bundleFs([SWAP.appPath], { copy: true }).ops,
  });
  assert.match(String(failedCopy.problem), /could not stage the new app/);
  assert.equal(failedCopy.appIntact, true, "a failed copy leaves the app intact");

  const failedAside = attemptSwapAppBundle({
    ...SWAP,
    ops: bundleFs([SWAP.appPath], { move: (from) => from === SWAP.appPath }).ops,
  });
  assert.match(String(failedAside.problem), /could not move the existing app aside/);
  assert.equal(failedAside.appIntact, true, "a failed move-aside leaves the app intact");

  const { staged, previous } = stagingPaths(SWAP);
  const restored = attemptSwapAppBundle({
    ...SWAP,
    ops: bundleFs([SWAP.appPath], { move: (from) => from === staged }).ops,
  });
  assert.equal(restored.appIntact, true, "a restored rollback leaves the app intact");

  const lost = attemptSwapAppBundle({
    ...SWAP,
    ops: bundleFs([SWAP.appPath], { move: (from) => from === staged || from === previous }).ops,
  });
  assert.equal(lost.appIntact, false, "an unrestorable rollback does not");
});

test("a displaced bundle this run could not delete is reported, not silently left", () => {
  // The run that STRANDS a bundle used to be the one run that never mentioned it. An unprivileged
  // swap over a root-owned predecessor cannot empty the tree it renamed aside, the cleanup error
  // was swallowed, and the pre-swap sweep skips the live transaction's own sibling - so nothing
  // reached the operator until some later update happened to sweep it.
  const { previous } = stagingPaths(SWAP);
  const fs = bundleFs([SWAP.appPath], { remove: (path) => path === previous });

  const result = replaceAppBundle({
    sourceBundle: SWAP.packagedApp,
    appPath: SWAP.appPath,
    appsDir: SWAP.appsDir,
    pid: 4242,
    platform: "darwin",
    appsDirWritable: true,
    sweep: () => [],
    ops: fs.ops,
    runElevated: () => {
      throw new Error("no authorization should be requested");
    },
  });

  assert.equal(result.problem, null, "the install still succeeded");
  assert.equal(result.elevated, false);
  assert.deepEqual(result.stranded, [previous], "and the leftover is named");
  assert.ok(fs.paths.has(previous), "which is true: it is still there");
});

test("a stranded bundle from the sweep and one from this run are both reported", () => {
  const { previous } = stagingPaths(SWAP);
  const older = "/Applications/.Mission Control.app.previous-111";
  const fs = bundleFs([SWAP.appPath], { remove: (path) => path === previous });

  const result = replaceAppBundle({
    sourceBundle: SWAP.packagedApp,
    appPath: SWAP.appPath,
    appsDir: SWAP.appsDir,
    pid: 4242,
    platform: "darwin",
    appsDirWritable: true,
    sweep: () => [older],
    ops: fs.ops,
  });

  assert.equal(result.problem, null);
  assert.deepEqual(result.stranded, [older, previous]);
});

test("retention reports where the displaced bundle actually is, not where it was aimed", () => {
  // Filing into the fixed `failed-update` slot is best-effort, and when it fails the displaced
  // bundle stays at the pid-named sibling. Reporting the slot regardless sent anyone following
  // the path to somewhere empty.
  const { previous, failed } = stagingPaths(SWAP);
  const fs = bundleFs([SWAP.appPath], { move: (_from, to) => to === failed });

  const result = replaceAppBundle({
    sourceBundle: SWAP.packagedApp,
    appPath: SWAP.appPath,
    appsDir: SWAP.appsDir,
    pid: 4242,
    keepPrevious: true,
    platform: "darwin",
    appsDirWritable: true,
    sweep: () => [],
    ops: fs.ops,
  });

  assert.equal(result.problem, null);
  assert.equal(result.failedBundle, previous, "the fallback location, which is where it is");
  assert.ok(fs.paths.has(previous));
  assert.ok(!fs.paths.has(failed));
});

test("an older retained bundle that blocks filing is reported", () => {
  // The reason filing fails: an earlier retained bundle at the fixed slot that this account
  // cannot delete. It stays on disk and nothing else finds it - `sweepDisplacedBundles` scans
  // `previous-*` siblings only and never this fixed path - so if it is not reported here it is
  // not reported at all.
  const { previous, failed } = stagingPaths(SWAP);
  const fs = bundleFs([SWAP.appPath, failed], { remove: (path) => path === failed });

  const result = replaceAppBundle({
    sourceBundle: SWAP.packagedApp,
    appPath: SWAP.appPath,
    appsDir: SWAP.appsDir,
    pid: 4242,
    keepPrevious: true,
    platform: "darwin",
    appsDirWritable: true,
    sweep: () => [],
    ops: fs.ops,
  });

  assert.equal(result.problem, null, "the install still succeeded");
  assert.equal(result.failedBundle, previous, "this run's bundle is at the fallback");
  assert.deepEqual(result.stranded, [failed], "and the blocker is named");
  assert.ok(fs.paths.has(failed), "which is true: it is still there");
});

test("retention reports the fixed slot when filing there succeeds", () => {
  const { failed } = stagingPaths(SWAP);
  const fs = bundleFs([SWAP.appPath]);

  const result = replaceAppBundle({
    sourceBundle: SWAP.packagedApp,
    appPath: SWAP.appPath,
    appsDir: SWAP.appsDir,
    pid: 4242,
    keepPrevious: true,
    platform: "darwin",
    appsDirWritable: true,
    sweep: () => [],
    ops: fs.ops,
  });

  assert.equal(result.failedBundle, failed);
  assert.ok(fs.paths.has(failed));
});

test("bundles displaced by an earlier privileged install are reclaimed, except the live one", () => {
  const removed: string[] = [];
  const stranded = sweepDisplacedBundles({
    appsDir: "/Applications",
    keepPid: 4242,
    readdir: () => [
      "Mission Control.app",
      ".Mission Control.app.previous-111",
      ".Mission Control.app.previous-222",
      ".Mission Control.app.previous-4242",
      ".Mission Control.app.failed-update",
      "Safari.app",
    ],
    // Injected, not inherited: pids 111 and 222 might genuinely be running on the machine this
    // suite happens to execute on, and the sweep asks the real OS by default.
    isRunning: () => false,
    remove: (path) => {
      // A root-owned tree this account can rename but not empty, which is the whole reason
      // these get left behind in the first place.
      if (path.endsWith("previous-222")) throw new Error("Operation not permitted");
      removed.push(path);
    },
  });

  assert.deepEqual(removed, ["/Applications/.Mission Control.app.previous-111"]);
  assert.deepEqual(stranded, ["/Applications/.Mission Control.app.previous-222"]);
});

test("a concurrent transaction's rollback bundle is never swept", () => {
  // The worst defect the sweep could have, and it is not hypothetical: `install-app.mjs` is a
  // supported command anyone can run directly, so a swap can be in flight with no helper claim
  // held. Between "move the installed app aside" and "move the staged app live", that
  // `previous-<pid>` sibling is the ONLY copy of the app. Sweeping it because it is not THIS
  // transaction's pid means that if the other transaction's staged move then fails, its rollback
  // has nothing to restore - and the person is left with no installed app at all.
  const removed: string[] = [];
  const stranded = sweepDisplacedBundles({
    appsDir: "/Applications",
    keepPid: 4242,
    readdir: () => [
      ".Mission Control.app.previous-111",
      ".Mission Control.app.previous-999",
      ".Mission Control.app.previous-4242",
    ],
    // 999 is another swap still running; 111 belongs to a process long gone.
    isRunning: (pid) => pid === 999,
    remove: (path) => removed.push(path),
  });

  assert.deepEqual(removed, ["/Applications/.Mission Control.app.previous-111"]);
  assert.deepEqual(stranded, []);
});

test("only a canonical decimal pid suffix is ever deleted", () => {
  // `Number()` is far too generous to decide what to delete recursively: `123.0`, `0x7b`, `1e3`
  // and whitespace-padded forms all coerce to valid integers, and an unsafe integer survives
  // `Number.isInteger` too. `stagingPaths` only ever writes a canonical decimal pid, so every
  // other spelling names a directory this code could not have created - another tool's, or a
  // person's - and the sweep's whole safety argument is that the filename pins whose it is.
  const removed: string[] = [];
  sweepDisplacedBundles({
    appsDir: "/Applications",
    keepPid: 4242,
    readdir: () => [
      ".Mission Control.app.previous-",
      ".Mission Control.app.previous-not-a-pid",
      ".Mission Control.app.previous-0",
      ".Mission Control.app.previous-123.0",
      ".Mission Control.app.previous-0x7b",
      ".Mission Control.app.previous-1e3",
      ".Mission Control.app.previous- 12 ",
      ".Mission Control.app.previous-+7",
      ".Mission Control.app.previous-99999999999999999999",
      ".Mission Control.app.previous-0123",
      // The one canonical spelling, and the only one that may be removed.
      ".Mission Control.app.previous-777",
    ],
    isRunning: () => false,
    remove: (path) => removed.push(path),
  });
  assert.deepEqual(removed, ["/Applications/.Mission Control.app.previous-777"]);
});

test("a displaced-bundle pid is parsed only in the spelling this code writes", () => {
  assert.equal(displacedBundlePid("777"), 777);
  assert.equal(displacedBundlePid(String(process.pid)), process.pid);
  for (const rejected of [
    "",
    "0",
    "0123",
    "123.0",
    "0x7b",
    "1e3",
    " 12 ",
    "+7",
    "-7",
    "not-a-pid",
    "12abc",
    "99999999999999999999",
  ]) {
    assert.equal(displacedBundlePid(rejected), null, `rejects ${JSON.stringify(rejected)}`);
  }
});

test("the live transaction's own displaced bundle is never swept", () => {
  // It is the retention fallback the swap relies on when it cannot file the displaced bundle,
  // so sweeping it would destroy the only remaining copy of the previous app.
  const removed: string[] = [];
  sweepDisplacedBundles({
    appsDir: "/Applications",
    keepPid: 4242,
    readdir: () => [".Mission Control.app.previous-4242"],
    isRunning: () => false,
    remove: (path) => removed.push(path),
  });
  assert.deepEqual(removed, []);
});

test("an owner spec is produced only from usable numeric ids", () => {
  assert.equal(bundleOwnerSpec(501, 20), "501:20");
  assert.equal(bundleOwnerSpec(0, 0), "0:0");
  // No uid available means no chown rather than a guessed one, and the transaction still runs.
  assert.equal(bundleOwnerSpec(undefined, undefined), null);
  assert.equal(bundleOwnerSpec(-1, 20), null);
  assert.equal(bundleOwnerSpec(501, undefined), null);
});

test("administrator authorization cannot target an arbitrary install directory", () => {
  const plan = privilegedBundleSwapCommand({
    sourceBundle: "/tmp/Mission Control.app",
    appPath: "/tmp/Applications/Mission Control.app",
    appsDir: "/tmp/Applications",
    pid: 4242,
    keepPrevious: false,
  });
  assert.equal(plan.command, null);
  assert.match(String(plan.problem), /restricted to \/Applications\/Mission Control\.app/);
});

test(
  "the administrator AppleScript compiles without requesting authorization when no transaction is supplied",
  { skip: process.platform !== "darwin" },
  () => {
    const result = spawnSync("/usr/bin/osascript", ["-e", PRIVILEGED_SWAP_APPLESCRIPT], {
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /expected one bundle transaction/);
    assert.doesNotMatch(result.stderr, /administrator|privilege|authorization/i);
  },
);

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
    `remove ${stagingPaths(SWAP).failed}`,
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

test("post-swap retention failure cannot turn an installed app into a failed transaction", () => {
  const { previous, failed } = stagingPaths(SWAP);
  const fs = bundleFs([SWAP.appPath], {
    move: (_from, to) => to === failed,
  });

  assert.equal(swapAppBundle({ ...SWAP, keepPrevious: true, ops: fs.ops }), null);
  assert.ok(fs.paths.has(SWAP.appPath), "the new app is live after the decisive move");
  assert.ok(fs.paths.has(previous), "the displaced app remains at the fallback sibling");
  assert.ok(!fs.paths.has(failed), "the failed filing destination was not claimed");
});

test("post-swap deletion failure cannot turn an installed app into a failed transaction", () => {
  const { previous } = stagingPaths(SWAP);
  const fs = bundleFs([SWAP.appPath], {
    remove: (path) => path === previous,
  });

  assert.equal(swapAppBundle({ ...SWAP, ops: fs.ops }), null);
  assert.ok(fs.paths.has(SWAP.appPath), "the new app is live after the decisive move");
  assert.ok(fs.paths.has(previous), "the displaced app remains when cleanup fails");
});

test("the privileged shell transaction tolerates a failed post-swap retention step", async (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("the permission failure requires a non-root test process");
    return;
  }

  const root = await mkdtemp(join(tmpdir(), "mission-bundle-retention-"));
  const sourceBundle = join(root, "source.app");
  const appPath = join(root, "Mission Control.app");
  const staged = join(root, ".incoming");
  const previous = join(root, ".previous");
  const failed = join(root, ".failed-update");
  t.after(() => {
    try { chmodSync(failed, 0o755); } catch {}
    rmSync(root, { recursive: true, force: true });
  });

  mkdirSync(sourceBundle);
  mkdirSync(appPath);
  mkdirSync(failed);
  writeFileSync(join(sourceBundle, "version.txt"), "new\n");
  writeFileSync(join(appPath, "version.txt"), "old\n");
  writeFileSync(join(failed, "locked.txt"), "retained evidence\n");
  chmodSync(failed, 0o555);

  const command = bundleSwapShellCommand({
    sourceBundle,
    appPath,
    staged,
    previous,
    failed,
    keepPrevious: true,
  });
  const result = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(readFileSync(join(appPath, "version.txt"), "utf8"), "new\n");
  assert.equal(readFileSync(join(previous, "version.txt"), "utf8"), "old\n");
  assert.equal(readFileSync(join(failed, "locked.txt"), "utf8"), "retained evidence\n");
});

test("the real writability check does not demand a rewritable outgoing bundle", async (t) => {
  // The regression that made auto-upgrade fail repeatedly, pinned against the DEFAULT check
  // rather than an injected one. The tests above pass `appsDirWritable` explicitly, so they
  // cannot notice `directoryTreeIsWritable` being reinstated in the default - and that
  // reinstatement IS the defect: it requires write access to every directory inside the
  // outgoing bundle, which a bundle left by a previous elevated install does not grant, and
  // which the transaction never needed. Real directories, real permissions, no injection.
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("an unwritable directory does not constrain root");
    return;
  }

  const appsDir = await mkdtemp(join(tmpdir(), "mission-bundle-unwritable-"));
  const sourceBundle = join(appsDir, "source.app");
  const appPath = join(appsDir, APP_BUNDLE_NAME);
  const locked = join(appPath, "Contents");
  const displaced = stagingPaths({ appsDir, pid: process.pid }).previous;
  t.after(() => {
    // The displaced bundle keeps the unwritable directories, which is the whole point: an
    // unprivileged swap can rename a bundle it cannot rewrite out of the way, but it cannot
    // empty one. Teardown has to undo the permissions the test set, or it cannot clean up.
    for (const path of [locked, appPath, displaced, join(displaced, "Contents")]) {
      try { chmodSync(path, 0o755); } catch {}
    }
    rmSync(appsDir, { recursive: true, force: true });
  });

  mkdirSync(sourceBundle);
  writeFileSync(join(sourceBundle, "version.txt"), "new\n");
  mkdirSync(locked, { recursive: true });
  writeFileSync(join(locked, "version.txt"), "old\n");
  // Exactly the shape a root-owned install leaves behind: the parent stays writable, the
  // bundle's own directories do not.
  chmodSync(locked, 0o555);
  chmodSync(appPath, 0o555);

  assert.equal(directoryIsWritable(appsDir), true, "the install directory is writable");
  assert.equal(
    directoryTreeIsWritable(appPath),
    false,
    "the outgoing bundle is not rewritable, which is what used to force a prompt",
  );

  const prompts: string[] = [];
  const result = replaceAppBundle({
    sourceBundle,
    appPath,
    appsDir,
    pid: process.pid,
    platform: "darwin",
    // No `appsDirWritable` and no `ops`: the real predicate and the real filesystem decide.
    runElevated: (_command, prompt) => prompts.push(prompt),
  });

  assert.equal(result.problem, null, `the swap failed: ${result.problem}`);
  assert.equal(result.elevated, false, "no administrator authorization was requested");
  assert.deepEqual(prompts, [], "no authorization panel was raised");
  assert.equal(
    readFileSync(join(appPath, "version.txt"), "utf8"),
    "new\n",
    "the new bundle is live",
  );
});
