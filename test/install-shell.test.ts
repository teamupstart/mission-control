import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { parseArgs } from "../scripts/install-app.mjs";
import { CANONICAL_REPO, validateReceipt } from "../src/shared/install-receipt-schema.mjs";
import { inspectUpdateRuntime } from "../src/main/update-runtime.ts";

const root = resolve(import.meta.dirname, "..");
const shell = readFileSync(join(root, "scripts/install.sh"), "utf8");
const commit = "a".repeat(40);

// Exercise the real Bash and Node installers and real bundle copy/receipt writes. Only
// external downloads, prerequisite probes, and expensive package production are fixtures.
function fixture(t: test.TestContext, fail = "") {
  const directory = mkdtempSync(join(tmpdir(), "mission-shell-install-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = join(directory, "bin");
  const scratch = join(directory, "temporary files");
  const state = join(directory, "state");
  const apps = join(directory, "Applications with spaces");
  for (const path of [bin, scratch, apps]) mkdirSync(path);
  const log = join(directory, "commands.jsonl");
  const preload = join(directory, "architecture.mjs");
  writeFileSync(preload, 'Object.defineProperty(process, "arch", { value: "arm64" });\n');
  const program = `#!${process.execPath}
import { appendFileSync, cpSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
const tool = basename(process.argv[1]);
const args = process.argv.slice(2);
const failure = process.env.INSTALL_FAIL;
appendFileSync(process.env.INSTALL_LOG, JSON.stringify({ tool, args, cwd: process.cwd() }) + "\\n");
if (tool === "uname") console.log(failure === "platform" ? "Linux" : "Darwin");
else if (tool === "node") {
  const result = spawnSync(${JSON.stringify(process.execPath)}, ["--import", ${JSON.stringify(preload)}, ...args], { stdio: "inherit" });
  process.exit(result.status ?? 1);
} else if (tool === "curl") {
  if (failure === "download") { console.error("curl: (22) GitHub unavailable"); process.exit(22); }
  process.stdout.write(readFileSync(${JSON.stringify(join(root, "scripts/install.sh"))}, "utf8"));
} else if (tool === "gh") {
  if (args[0] === "release") {
    if (failure === "release") process.exit(29);
    console.log('[{"tagName":"v1.2.3"}]');
  }
} else if (tool === "git") {
  if (args[0] === "clone") {
    const target = args.at(-1);
    mkdirSync(join(target, ".git"), { recursive: true });
    if (failure === (args.includes("--depth") ? "bootstrap" : "source")) process.exit(27);
    for (const directory of ["scripts", "src"]) {
      cpSync(join(${JSON.stringify(root)}, directory), join(target, directory), {
        recursive: true, filter: (path) => statSync(path).isDirectory() || path.endsWith(".mjs"),
      });
    }
    if (failure === "graph") {
      const nested = join(target, "scripts", "fixture-dependencies");
      mkdirSync(nested);
      writeFileSync(join(nested, "entry.mjs"), 'export { value } from "./leaf.mjs";\\n');
      writeFileSync(join(nested, "leaf.mjs"), 'export const value = "transitive installer dependency"; console.log(value);\\n');
      appendFileSync(join(target, "scripts", "install-app.mjs"), '\\nexport { value } from "./fixture-dependencies/entry.mjs";\\n');
    }
    writeFileSync(join(target, "package.json"), JSON.stringify({ version: "1.2.3" }));
  } else if (args.includes("get-url")) console.log("https://github.com/${CANONICAL_REPO}.git");
  else if (args.includes("symbolic-ref")) console.log("origin/main");
  else if (args.includes("rev-parse")) console.log(${JSON.stringify(commit)});
} else if (tool === "npm" && args[0] === "run") {
  if (failure === "interrupt") { process.kill(process.ppid, "SIGTERM"); process.exit(143); }
  if (failure === "build") process.exit(31);
  const compiler = join(process.cwd(), "node_modules/.bin/esbuild");
  mkdirSync(join(process.cwd(), "node_modules/.bin"), { recursive: true });
  if (failure === "support-build") writeFileSync(compiler, "#!/bin/sh\\nexit 32\\n", { mode: 0o755 });
  else symlinkSync(${JSON.stringify(join(root, "node_modules/.bin/esbuild"))}, compiler);
  const contents = join(process.cwd(), "release/mac-arm64/Mission Control.app/Contents");
  mkdirSync(join(contents, "Resources/app"), { recursive: true });
  const version = failure === "version" ? "9.9.9" : "1.2.3";
  writeFileSync(join(contents, "Info.plist"), '<plist><dict><key>CFBundleShortVersionString</key><string>' + version + '</string></dict></plist>');
  writeFileSync(join(contents, "Resources/app/package.json"), JSON.stringify({ version, missionCommit: ${JSON.stringify(commit)} }));
}
`;
  for (const tool of ["uname", "node", "git", "gh", "npm", "xcode-select", "curl"]) {
    writeFileSync(join(bin, tool), program, { mode: 0o755 });
  }
  const env = {
    ...process.env,
    PATH: `${bin}:/usr/bin:/bin`,
    TMPDIR: scratch,
    MISSION_HOME: state,
    MISSION_NPM_BIN: join(bin, "npm"),
    INSTALL_FAIL: fail,
    INSTALL_LOG: log,
  };
  function run(args: string[] = [], input = shell) {
    return spawnSync("/bin/bash", ["-s", "--", "--apps-dir", apps, ...args], {
      input, encoding: "utf8", cwd: directory, env, timeout: 30_000,
    });
  }
  function commands(): Array<{ tool: string; args: string[]; cwd: string }> {
    return readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  }
  return { directory, scratch, state, apps, env, run, commands };
}

for (const prerequisite of ["macOS", "git", "node"]) {
  test(`Bash refuses missing ${prerequisite} before creating bootstrap or installation state`, (t) => {
    const f = fixture(t, prerequisite === "macOS" ? "platform" : "");
    const bin = join(f.directory, "bin");
    // Keep host-installed git/node off PATH so a removed fixture is genuinely unavailable.
    f.env.PATH = bin;
    if (prerequisite !== "macOS") rmSync(join(bin, prerequisite));
    // Record any attempt to allocate a bootstrap directory, even if later cleanup removes it.
    writeFileSync(join(bin, "mktemp"), `#!${process.execPath}
import { appendFileSync } from "node:fs";
appendFileSync(process.env.INSTALL_LOG, JSON.stringify({ tool: "mktemp", args: process.argv.slice(2), cwd: process.cwd() }) + "\\n");
process.exit(90);
`, { mode: 0o755 });

    const result = spawnSync("/bin/bash", [join(root, "scripts/install.sh"), "--apps-dir", f.apps], {
      cwd: f.directory, env: f.env, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    if (prerequisite === "macOS") {
      assert.match(result.stderr, /requires macOS on Apple Silicon/);
    } else {
      assert.ok(result.stderr.includes(`${prerequisite} is required.`), result.stderr);
      assert.match(result.stderr, /Install Node.js 24\+ and the Xcode command line tools/);
    }
    assert.deepEqual(f.commands().map(({ tool, args }) => ({ tool, args })), [{ tool: "uname", args: ["-s"] }]);
    assert.deepEqual(readdirSync(f.scratch), []);
    assert.deepEqual(readdirSync(f.apps), []);
    assert.equal(existsSync(f.state), false);
  });
}

test("Bash installs through the shared release, verification, swap and receipt path without retaining a checkout", async (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(readdirSync(f.scratch), [], "both temporary clones were removed");
  assert.equal(existsSync(join(f.state, "app-src")), false);
  const receipt = JSON.parse(readFileSync(join(f.state, "install-receipt.json"), "utf8"));
  assert.equal(validateReceipt(receipt), null);
  assert.equal(receipt.releaseTag, "v1.2.3");
  assert.equal(receipt.installedCommit, commit);
  assert.equal(receipt.appPath, join(f.apps, "Mission Control.app"));
  assert.ok(existsSync(join(receipt.appPath, "Contents/Info.plist")));
  const supportFiles = readdirSync(receipt.sourceClone, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name).slice(receipt.sourceClone.length + 1));
  assert.deepEqual(supportFiles.sort(), [".mission-control-installer", "install-origin", "scripts/install-app.mjs"]);
  const runtime = await inspectUpdateRuntime(
    { path: process.execPath, env: process.env }, { path: "npm" }, receipt.sourceClone,
  );
  assert.equal(runtime.ok, true, JSON.stringify(runtime));
  const commands = f.commands();
  assert.ok(commands.some(({ tool, args }) => tool === "gh" && args.includes("--exclude-pre-releases") && args.includes(CANONICAL_REPO)));
  assert.ok(commands.some(({ tool, args }) => tool === "npm" && args[0] === "ci"));
  assert.ok(commands.some(({ tool, args }) => tool === "git" && args.includes("checkout") && args.includes("v1.2.3")));

  // The updater contract from released apps: invoke the receipt's script with --stage-only,
  // then --from-staged. The retained modules must work after BOTH download trees are gone.
  const script = join(receipt.sourceClone, "scripts/install-app.mjs");
  const update = (args: string[]) => spawnSync(join(f.directory, "bin/node"), [script, ...args], {
    cwd: receipt.sourceClone, env: f.env, encoding: "utf8", timeout: 30_000,
  });
  const staged = update(["--stage-only", "--ref", "v1.2.3"]);
  assert.equal(staged.status, 0, staged.stdout + staged.stderr);
  const bundle = join(f.state, "app-src/release/mac-arm64/Mission Control.app");
  assert.ok(existsSync(bundle));
  const swapped = update(["--from-staged", bundle, "--ref", "v1.2.3"]);
  assert.equal(swapped.status, 0, swapped.stdout + swapped.stderr);
  const updatedReceipt = JSON.parse(readFileSync(join(f.state, "install-receipt.json"), "utf8"));
  assert.equal(updatedReceipt.sourceClone, join(f.state, "app-src"));
  assert.equal(updatedReceipt.appPath, receipt.appPath, "update preserves destination");

  // Retaining an origin instead of .git must not bypass the normal repository trust policy.
  writeFileSync(join(receipt.sourceClone, "install-origin"), `https://untrusted.example/${CANONICAL_REPO}.git`);
  const refused = update(["--dry-run", "--ref", "v1.2.3"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Only github.com repositories can be installed/);
});

for (const failure of ["bootstrap", "source", "release", "build", "version", "interrupt", "support-build"]) {
  test(`failed ${failure} removes temporary sources and preserves the existing app and cache`, (t) => {
    const f = fixture(t, failure);
    const existing = join(f.apps, "Mission Control.app");
    const cache = join(f.state, "app-src");
    mkdirSync(existing);
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(existing, "original"), "keep app");
    writeFileSync(join(cache, "original"), "keep cache");
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.equal(result.error, undefined);
    assert.deepEqual(readdirSync(f.scratch), []);
    assert.equal(readFileSync(join(existing, "original"), "utf8"), "keep app");
    assert.equal(readFileSync(join(cache, "original"), "utf8"), "keep cache");
    assert.equal(existsSync(join(f.state, "install-receipt.json")), false);
  });
}

test("Bash forwards quoted options, and temporary dry runs do not write install state", (t) => {
  const f = fixture(t);
  const result = f.run(["--ref", "v2.3.4", "--dry-run", "--progress"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /v2.3.4 \(requested with --ref\)/);
  assert.match(result.stdout, /dry-run: nothing was changed/);
  assert.deepEqual(readdirSync(f.scratch), []);
  assert.equal(existsSync(f.state), false);
  assert.equal(f.commands().filter(({ tool, args }) => tool === "git" && args[0] === "clone").length, 1);
});

test("make install still uses the same installer and retains its managed build cache", (t) => {
  const f = fixture(t);
  const result = spawnSync("make", ["install", `ARGS=--apps-dir '${f.apps}' --ref v1.2.3`], {
    cwd: root, env: f.env, encoding: "utf8", timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const receipt = JSON.parse(readFileSync(join(f.state, "install-receipt.json"), "utf8"));
  assert.equal(receipt.sourceClone, join(f.state, "app-src"));
  assert.equal(receipt.releaseTag, "v1.2.3");
  assert.equal(existsSync(join(f.state, "app-src/.git")), true);
  assert.equal(existsSync(join(f.state, "installers")), false);
});

test("temporary sources cannot be requested for either half of a staged update", () => {
  for (const args of [["--stage-only"], ["--from-staged", "/tmp/app"]]) {
    assert.match(parseArgs(["--temporary-source", ...args]).problem!, /cannot be combined/);
  }
});

test("the first README code block installs without a caller checkout", (t) => {
  const f = fixture(t);
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const command = /```bash\n([^`]+)```/.exec(readme)?.[1]?.trim();
  assert.ok(command);
  const result = spawnSync("/bin/bash", ["-c", `${command} --apps-dir "$INSTALL_APPS"`], {
    env: { ...f.env, INSTALL_APPS: f.apps }, cwd: f.directory, encoding: "utf8", timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(readdirSync(f.scratch), []);
  assert.ok(existsSync(join(f.apps, "Mission Control.app")));
  assert.ok(f.commands().some(({ tool, args }) => tool === "curl" && args.includes(`https://raw.githubusercontent.com/${CANONICAL_REPO}/main/scripts/install.sh`)));
});

test("the README command propagates a failed download without creating install state", (t) => {
  const f = fixture(t, "download");
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const command = /```bash\n([^`]+)```/.exec(readme)?.[1]?.trim();
  assert.ok(command);
  const result = spawnSync("/bin/bash", ["-c", command], {
    env: f.env, cwd: f.directory, encoding: "utf8", timeout: 30_000,
  });
  assert.equal(result.status, 22, result.stdout + result.stderr);
  assert.match(result.stderr, /GitHub unavailable/);
  assert.deepEqual(f.commands().map(({ tool }) => tool), ["curl"]);
  assert.deepEqual(readdirSync(f.scratch), []);
  assert.deepEqual(readdirSync(f.apps), []);
  assert.equal(existsSync(f.state), false);
});

test("the retained installer includes newly imported transitive modules after both checkouts are removed", (t) => {
  const f = fixture(t, "graph");
  const installed = f.run();
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  assert.deepEqual(readdirSync(f.scratch), []);
  const receipt = JSON.parse(readFileSync(join(f.state, "install-receipt.json"), "utf8"));
  const retained = spawnSync(process.execPath, [join(receipt.sourceClone, "scripts/install-app.mjs"), "--help"], {
    env: f.env, cwd: receipt.sourceClone, encoding: "utf8", timeout: 30_000,
  });
  assert.equal(retained.status, 0, retained.stdout + retained.stderr);
  assert.match(retained.stdout, /transitive installer dependency/);
  assert.match(retained.stdout, /Usage: node scripts\/install-app.mjs/);
});

test("repeated direct installs replace only the superseded owned installer after receipt commitment", (t) => {
  const f = fixture(t);
  const first = f.run();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const receiptFile = join(f.state, "install-receipt.json");
  const before = readFileSync(receiptFile, "utf8");
  const previous = JSON.parse(before).sourceClone;
  const unrelated = join(f.state, "installers", "installer-user-data");
  mkdirSync(unrelated);
  writeFileSync(join(unrelated, "keep"), "unrelated");

  f.env.INSTALL_FAIL = "support-build";
  const failed = f.run();
  assert.equal(failed.status, 1);
  assert.equal(readFileSync(receiptFile, "utf8"), before);
  assert.ok(existsSync(join(previous, "scripts/install-app.mjs")));

  f.env.INSTALL_FAIL = "";
  const second = f.run();
  assert.equal(second.status, 0, second.stdout + second.stderr);
  const current = JSON.parse(readFileSync(receiptFile, "utf8"));
  assert.notEqual(current.sourceClone, previous);
  assert.equal(existsSync(previous), false);
  assert.ok(existsSync(join(current.sourceClone, "scripts/install-app.mjs")));
  assert.deepEqual(readdirSync(join(f.state, "installers")).sort(), [current.sourceClone.split("/").at(-1), "installer-user-data"].sort());
  assert.equal(readFileSync(join(unrelated, "keep"), "utf8"), "unrelated");
});
