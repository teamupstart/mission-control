import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, test } from "node:test";

import { stubRun } from "../src/server/util/exec.ts";
import {
  conductorInstallerCandidates,
  conductorInstallerRuntimePreparation,
  conductorInstallerRuntimeReading,
  conductorInstallerTerminalArgv,
  recognizedConductorRemote,
  verifyConductorInstallerCheckout,
} from "../src/server/pipelines/conductor/installer.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "mission-conductor-installer-")));
after(() => rmSync(root, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
}

function checkout(name: string, remote = "https://github.com/mancej/ai-conductor.git"): string {
  const repo = join(root, name);
  mkdirSync(join(repo, "bin"), { recursive: true });
  mkdirSync(join(repo, "src/conductor"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "pipe" });
  if (remote) git(repo, "remote", "add", "origin", remote);
  writeFileSync(join(repo, "bin/install"), "#!/bin/sh\necho ran > installer-ran\n");
  chmodSync(join(repo, "bin/install"), 0o755);
  writeFileSync(
    join(repo, "src/conductor/package.json"),
    JSON.stringify({
      name: "@james-stoup-agents/conductor",
      engines: { node: ">=26.0.0" },
    }),
  );
  writeFileSync(join(repo, "VERSION"), "0.101.1\n");
  git(repo, "add", "-A");
  git(
    repo,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-qm",
    "fixture",
  );
  return repo;
}

test("installer runtime preflight distinguishes unsupported and supported Node versions", async () => {
  assert.deepEqual(conductorInstallerRuntimeReading("v24.19.0"), {
    id: "node",
    label: "Node.js",
    current: "24.19.0",
    requirement: ">=26.0.0",
    supported: false,
    detail:
      "Conductor requires Node.js 26 or newer, but this installer would use Node.js 24.19.0. Activate Node.js 26+ before installing.",
  });
  assert.equal(conductorInstallerRuntimeReading("26.0.0").supported, true);
  assert.equal(conductorInstallerRuntimeReading("v27.1.2").supported, true);
  assert.equal(conductorInstallerRuntimeReading("v26.0.0-nightly").supported, false);

  const runtimeDeps = {
    path: () => ["/daemon/bin", "/usr/bin"].join(delimiter),
    nodeExecPath: async (path: string) => {
      assert.equal(path, ["/daemon/bin", "/usr/bin"].join(delimiter));
      return stubRun({ stdout: "/opt/node-26/bin/node\n", stderr: "", code: 0 });
    },
    realpath: async (path: string) => path,
    nodeVersion: async (nodeBin: string, path: string) => {
      assert.equal(nodeBin, "/opt/node-26/bin/node");
      assert.equal(
        path,
        ["/opt/node-26/bin", "/daemon/bin", "/usr/bin"].join(delimiter),
      );
      return stubRun({ stdout: "v26.7.0\n", stderr: "", code: 0 });
    },
  };
  const prepared = await conductorInstallerRuntimePreparation(runtimeDeps);
  assert.deepEqual(prepared, {
    reading: conductorInstallerRuntimeReading("v26.7.0"),
    terminalEnv: {
      PATH: ["/opt/node-26/bin", "/daemon/bin", "/usr/bin"].join(delimiter),
    },
  });

  const supported = prepared.reading;
  assert.equal(supported.current, "26.7.0");
  assert.equal(supported.supported, true);

  const unavailable = (await conductorInstallerRuntimePreparation({
    path: () => "/daemon/bin",
    nodeExecPath: async () => stubRun({ stdout: "", stderr: "not found", code: 1 }),
  })).reading;
  assert.equal(unavailable.current, null);
  assert.equal(unavailable.supported, false);
  assert.match(unavailable.detail, /could not determine/);
});

test("recognized upstream HTTPS and SSH remotes normalize to one credential-free label", () => {
  for (const remote of [
    "https://github.com/mancej/ai-conductor",
    "https://github.com/mancej/ai-conductor.git",
    "git@github.com:mancej/ai-conductor.git",
    "ssh://git@github.com/mancej/ai-conductor",
    "ssh://git@github.com/mancej/ai-conductor.git",
  ]) {
    assert.equal(recognizedConductorRemote(remote), "github.com/mancej/ai-conductor", remote);
  }
});

test("lookalike hosts, owners, suffixes, forks, ports, and non-SSH/HTTPS schemes are refused", () => {
  for (const remote of [
    "https://github.com.evil/mancej/ai-conductor.git",
    "https://github.com/not-mancej/ai-conductor.git",
    "https://github.com/mancej/ai-conductor-extra.git",
    "https://github.com/mancej/ai-conductor/fork.git",
    "https://github.com:8443/mancej/ai-conductor.git",
    "https://token@github.com/mancej/ai-conductor.git",
    "http://github.com/mancej/ai-conductor.git",
    "ssh://someone@github.com/mancej/ai-conductor.git",
    "ssh://git:secret@github.com/mancej/ai-conductor.git",
    "git@github.com:mancej/not-ai-conductor.git",
  ]) {
    assert.equal(recognizedConductorRemote(remote), null, remote);
  }
});

test("a main checkout needs recognized provenance and every exact marker", async () => {
  const repo = checkout("accepted");
  const verified = await verifyConductorInstallerCheckout(repo);
  assert.equal(verified.ok, true);
  if (!verified.ok) return;
  assert.equal(verified.candidate.checkout, repo);
  assert.equal(verified.candidate.remote, "github.com/mancej/ai-conductor");
  assert.equal(verified.candidate.version, "0.101.1");
  assert.equal(verified.candidate.changes.length, 6);
});

test("missing remotes and malformed or overflowing git output never establish provenance", async () => {
  const repo = checkout("remote-refusals", "");
  assert.equal((await verifyConductorInstallerCheckout(repo)).ok, false);
  assert.equal(
    (
      await verifyConductorInstallerCheckout(repo, {
        gitConfig: async () => stubRun({ code: 0, stdout: "not a remote record\n", stderr: "" }),
      })
    ).ok,
    false,
  );
  assert.equal(
    (
      await verifyConductorInstallerCheckout(repo, {
        gitConfig: async () => ({
          ...stubRun({
            code: 0,
            stdout: "remote.origin.url https://github.com/mancej/ai-conductor.git\n",
            stderr: "",
          }),
          overflowed: true,
        }),
      })
    ).ok,
    false,
  );
});

test("linked worktrees and relocated git directories are not installer roots", async () => {
  const main = checkout("main-owner");
  const linked = join(root, "linked");
  git(main, "worktree", "add", "-q", "-b", "linked", linked);
  const linkedResult = await verifyConductorInstallerCheckout(linked);
  assert.equal(linkedResult.ok, false);
  if (!linkedResult.ok) assert.match(linkedResult.reason, /main git checkout/);

  const relocated = join(root, "relocated");
  const gitDir = join(root, "relocated-git-dir");
  mkdirSync(relocated, { recursive: true });
  execFileSync("git", ["init", "-q", "--separate-git-dir", gitDir, relocated], { stdio: "pipe" });
  mkdirSync(join(relocated, "bin"), { recursive: true });
  mkdirSync(join(relocated, "src/conductor"), { recursive: true });
  writeFileSync(join(relocated, "bin/install"), "#!/bin/sh\n");
  chmodSync(join(relocated, "bin/install"), 0o755);
  writeFileSync(
    join(relocated, "src/conductor/package.json"),
    JSON.stringify({ name: "@james-stoup-agents/conductor" }),
  );
  writeFileSync(join(relocated, "VERSION"), "1.0.0\n");
  git(relocated, "remote", "add", "origin", "https://github.com/mancej/ai-conductor.git");
  assert.equal((await verifyConductorInstallerCheckout(relocated)).ok, false);
});

test("symlink escapes and missing, non-regular, or non-executable installers are refused", async () => {
  const escaped = checkout("escaped-installer");
  const outside = join(root, "outside-install");
  writeFileSync(outside, "#!/bin/sh\n");
  chmodSync(outside, 0o755);
  rmSync(join(escaped, "bin/install"));
  symlinkSync(outside, join(escaped, "bin/install"));
  assert.equal((await verifyConductorInstallerCheckout(escaped)).ok, false);

  const nonExecutable = checkout("non-executable");
  chmodSync(join(nonExecutable, "bin/install"), 0o644);
  assert.equal((await verifyConductorInstallerCheckout(nonExecutable)).ok, false);

  const directory = checkout("directory-installer");
  rmSync(join(directory, "bin/install"));
  mkdirSync(join(directory, "bin/install"));
  assert.equal((await verifyConductorInstallerCheckout(directory)).ok, false);
});

test("package and VERSION markers are bounded, regular, and exact", async () => {
  const wrongPackage = checkout("wrong-package");
  writeFileSync(join(wrongPackage, "src/conductor/package.json"), JSON.stringify({ name: "lookalike" }));
  assert.equal((await verifyConductorInstallerCheckout(wrongPackage)).ok, false);

  const packageEscape = checkout("package-escape");
  const outsidePackage = join(root, "outside-package.json");
  writeFileSync(outsidePackage, JSON.stringify({ name: "@james-stoup-agents/conductor" }));
  rmSync(join(packageEscape, "src/conductor/package.json"));
  symlinkSync(outsidePackage, join(packageEscape, "src/conductor/package.json"));
  assert.equal((await verifyConductorInstallerCheckout(packageEscape)).ok, false);

  const packageDirectory = checkout("package-directory");
  rmSync(join(packageDirectory, "src/conductor/package.json"));
  mkdirSync(join(packageDirectory, "src/conductor/package.json"));
  assert.equal((await verifyConductorInstallerCheckout(packageDirectory)).ok, false);

  const largePackage = checkout("large-package");
  writeFileSync(join(largePackage, "src/conductor/package.json"), " ".repeat(65_537));
  assert.equal((await verifyConductorInstallerCheckout(largePackage)).ok, false);

  const largeVersion = checkout("large-version");
  writeFileSync(join(largeVersion, "VERSION"), "v".repeat(513));
  assert.equal((await verifyConductorInstallerCheckout(largeVersion)).ok, false);

  const malformedVersion = checkout("malformed-version");
  writeFileSync(join(malformedVersion, "VERSION"), "version one\nversion two\n");
  assert.equal((await verifyConductorInstallerCheckout(malformedVersion)).ok, false);

  const missingVersion = checkout("missing-version");
  rmSync(join(missingVersion, "VERSION"));
  assert.equal((await verifyConductorInstallerCheckout(missingVersion)).ok, false);

  const versionDirectory = checkout("version-directory");
  rmSync(join(versionDirectory, "VERSION"));
  mkdirSync(join(versionDirectory, "VERSION"));
  assert.equal((await verifyConductorInstallerCheckout(versionDirectory)).ok, false);
});

test("an unreadable bounded VERSION is reported as unknown without weakening other markers", async () => {
  const repo = checkout("unknown-version");
  const verified = await verifyConductorInstallerCheckout(repo, {
    readFile: async (path) => {
      if (path === join(repo, "VERSION")) throw new Error("fixture refusal");
      return readFile(path, "utf8");
    },
  });
  assert.equal(verified.ok, true);
  if (verified.ok) assert.equal(verified.candidate.version, null);
});

test("discovery deduplicates physical candidates and never executes checkout code", async () => {
  const repo = checkout("never-executed");
  const alias = join(root, "never-executed-alias");
  symlinkSync(repo, alias);
  const candidates = await conductorInstallerCandidates([repo, repo, alias]);
  assert.deepEqual(candidates.map((candidate) => candidate.checkout), [repo]);
  assert.equal(existsSync(join(repo, "installer-ran")), false);
});

test("discovery returns no more than the shared candidate bound", async () => {
  const repos = Array.from({ length: 9 }, (_, index) => checkout(`bounded-${index}`));
  const candidates = await conductorInstallerCandidates(repos);
  assert.equal(candidates.length, 8);
});

test("terminal composition reverifies and returns only the exact executable with no flags", async () => {
  const repo = checkout("terminal-argv");
  const launch = await conductorInstallerTerminalArgv(repo);
  assert.equal("refused" in launch, false);
  if ("refused" in launch) return;
  assert.deepEqual(launch.argv, [join(repo, "bin/install")]);
  assert.equal(launch.cwd, repo);
  assert.equal(launch.title, "ai-conductor installer");

  git(repo, "remote", "set-url", "origin", "https://github.com/someone/fork.git");
  assert.match(
    (await conductorInstallerTerminalArgv(repo) as { refused: string }).refused,
    /no longer a verified/,
  );
});
