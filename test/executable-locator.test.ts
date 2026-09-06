import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";
import test from "node:test";

import { executableSpec } from "../src/server/executables/catalog.ts";
import {
  EXECUTABLE_REFRESH_COOLDOWN_MS,
  ExecutableLocator,
  probeLoginShellPath,
  type LoginShellResult,
} from "../src/server/executables/locator.ts";

function executable(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
}

function fixture(): { root: string; env: NodeJS.ProcessEnv; clean(): void } {
  const root = mkdtempSync(join(tmpdir(), "mission-executable-locator-"));
  return {
    root,
    env: { HOME: root, PATH: "", SHELL: join(root, "shell") },
    clean: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("async initialization still reads the login shell after a synchronous startup consumer", async () => {
  const f = fixture();
  const loginBin = join(f.root, "login", "bin");
  const pi = executable(join(loginBin, "pi"));
  let probes = 0;
  try {
    const locator = new ExecutableLocator({
      env: f.env,
      probeLoginShell: async () => {
        probes += 1;
        return { path: loginBin, problem: null };
      },
    });
    assert.equal(locator.resolveSync(executableSpec("pi")), null);
    assert.equal((await locator.resolve(executableSpec("pi")))?.path, pi);
    assert.equal(probes, 1);
  } finally {
    f.clean();
  }
});

test("the deterministic path ladder records custom, inherited, login, manager, and OS provenance", async () => {
  const f = fixture();
  const custom = join(f.root, "custom");
  const inherited = join(f.root, "inherited");
  const login = join(f.root, "login");
  const xdg = join(f.root, "xdg");
  executable(join(custom, "git"));
  executable(join(inherited, "codex"));
  executable(join(login, "pi"));
  executable(join(xdg, "mise", "shims", "claude"));
  Object.assign(f.env, {
    MISSION_EXECUTABLE_PATHS: custom,
    PATH: inherited,
    XDG_DATA_HOME: xdg,
  });
  try {
    const locator = new ExecutableLocator({
      env: f.env,
      probeLoginShell: async () => ({ path: login, problem: null }),
    });
    assert.equal((await locator.resolve(executableSpec("git")))?.source, "operator-directory");
    assert.equal((await locator.resolve(executableSpec("codex")))?.source, "inherited-path");
    assert.equal((await locator.resolve(executableSpec("pi")))?.source, "login-shell");
    assert.equal((await locator.resolve(executableSpec("claude")))?.source, "version-manager");
    assert.equal(locator.snapshot().path.split(delimiter)[0], custom);
  } finally {
    f.clean();
  }
});

test("an ad hoc command carries no fabricated built-in identity", async () => {
  const f = fixture();
  const customBin = join(f.root, "custom");
  const command = executable(join(customBin, "repository-check"));
  f.env.PATH = customBin;
  try {
    const locator = new ExecutableLocator({
      env: f.env,
      probeLoginShell: async () => ({ path: null, problem: null }),
    });
    const resolved = await locator.resolveCommand("repository-check");
    assert.equal(resolved?.path, command);
    assert.equal(resolved?.id, null);
    assert.equal(resolved?.source, "inherited-path");
  } finally {
    f.clean();
  }
});

test("PATH lookup skips executable directories and selects an executable file", async () => {
  const f = fixture();
  const first = join(f.root, "first");
  const second = join(f.root, "second");
  mkdirSync(join(first, "pi"), { recursive: true });
  const pi = executable(join(second, "pi"));
  f.env.PATH = [first, second].join(delimiter);
  try {
    const locator = new ExecutableLocator({
      env: f.env,
      probeLoginShell: async () => ({ path: null, problem: null }),
    });
    assert.equal((await locator.resolve(executableSpec("pi")))?.path, pi);
  } finally {
    f.clean();
  }
});

test("every child environment uses the canonical snapshot even from a fresh base object", async () => {
  const f = fixture();
  const inherited = join(f.root, "inherited");
  const login = join(f.root, "login");
  f.env.PATH = inherited;
  try {
    const locator = new ExecutableLocator({
      env: f.env,
      probeLoginShell: async () => ({ path: login, problem: null }),
    });
    const snapshot = await locator.initialize();
    const child = locator.environment({
      ...f.env,
      PATH: join(f.root, "stale"),
      MC_CHILD_MARKER: "kept",
    });
    assert.equal(child.PATH, snapshot.path);
    assert.equal(child.MC_CHILD_MARKER, "kept");
  } finally {
    f.clean();
  }
});

test("prefixed and legacy absolute overrides win and keep one launch environment", async () => {
  const f = fixture();
  const missionCodex = executable(join(f.root, "mission", "codex"));
  const fleetCodex = executable(join(f.root, "fleet", "codex"));
  const rawWezterm = executable(join(f.root, "terminal", "wezterm"));
  Object.assign(f.env, {
    MISSION_CODEX_BIN: missionCodex,
    FLEET_CODEX_BIN: fleetCodex,
    WEZTERM_BIN: rawWezterm,
    WEZTERM_UNIX_SOCKET: "stale",
  });
  try {
    const locator = new ExecutableLocator({
      env: f.env,
      probeLoginShell: async () => ({ path: null, problem: "login shell failed" }),
    });
    const codex = await locator.resolve(executableSpec("codex"));
    const wezterm = await locator.resolve(executableSpec("wezterm"));
    assert.equal(codex?.path, missionCodex);
    assert.equal(codex?.source, "operator-override");
    assert.equal(codex?.sourceDetail, "MISSION_CODEX_BIN");
    assert.equal(codex?.env.PATH, locator.snapshot().path);
    assert.equal(wezterm?.path, rawWezterm);
    assert.equal(wezterm?.sourceDetail, "WEZTERM_BIN");
    assert.equal(wezterm?.env.WEZTERM_UNIX_SOCKET, undefined);
  } finally {
    f.clean();
  }
});

test("a relative per-tool override is rejected instead of depending on daemon cwd", async () => {
  const f = fixture();
  const pi = executable(join(f.root, "custom", "pi"));
  f.env.MISSION_PI_BIN = relative(process.cwd(), pi);
  try {
    const locator = new ExecutableLocator({
      env: f.env,
      probeLoginShell: async () => ({ path: null, problem: null }),
    });
    assert.equal(await locator.resolve(executableSpec("pi")), null);
  } finally {
    f.clean();
  }
});

test("custom per-user terminal app locations are supported without a filesystem scan", async () => {
  const f = fixture();
  const wezterm = executable(join(f.root, "Applications", "WezTerm.app", "Contents", "MacOS", "wezterm"));
  try {
    const locator = new ExecutableLocator({
      env: f.env,
      platform: "darwin",
      probeLoginShell: async () => ({ path: null, problem: null }),
    });
    const resolved = await locator.resolve(executableSpec("wezterm"));
    assert.equal(resolved?.path, wezterm);
    assert.equal(resolved?.source, "supported-location");
  } finally {
    f.clean();
  }
});

test("dead login shells degrade to manager and OS defaults", async () => {
  const f = fixture();
  const asdf = join(f.root, "relocated-asdf");
  const pi = executable(join(asdf, "shims", "pi"));
  f.env.ASDF_DATA_DIR = asdf;
  try {
    const locator = new ExecutableLocator({
      env: f.env,
      probeLoginShell: async () => ({ path: null, problem: "login shell timed out" }),
    });
    const resolved = await locator.resolve(executableSpec("pi"));
    assert.equal(resolved?.path, pi);
    assert.equal(resolved?.source, "version-manager");
    assert.equal(locator.snapshot().loginShellProblem, "login shell timed out");
    assert.equal(locator.snapshot().path.includes("/usr/bin"), true);
  } finally {
    f.clean();
  }
});

test("a login-shell grandchild holding output cannot outlive the discovery deadline", async () => {
  const f = fixture();
  const shell = executable(f.env.SHELL!);
  writeFileSync(
    shell,
    [
      "#!/bin/sh",
      "/bin/sleep 30 &",
      "printf '__MISSION_PATH__/usr/bin__MISSION_PATH__'",
      "",
    ].join("\n"),
  );
  const started = Date.now();
  try {
    assert.deepEqual(await probeLoginShellPath(f.env, 100), {
      path: null,
      problem: "login shell timed out",
    });
    assert.ok(Date.now() - started < 2_000, "the inherited output pipe kept discovery alive");
  } finally {
    f.clean();
  }
});

test("a verbose login shell cannot block PATH discovery on stderr backpressure", async () => {
  const f = fixture();
  const shell = f.env.SHELL!;
  writeFileSync(
    shell,
    [
      `#!${process.execPath}`,
      `process.stderr.write("x".repeat(1024 * 1024), () => {`,
      `  process.stdout.write("__MISSION_PATH__/verbose/bin__MISSION_PATH__");`,
      `});`,
      "",
    ].join("\n"),
  );
  chmodSync(shell, 0o755);
  try {
    assert.deepEqual(await probeLoginShellPath(f.env, 2_000), {
      path: "/verbose/bin",
      problem: null,
    });
  } finally {
    f.clean();
  }
});

test("a first miss refreshes immediately when the login shell exposes a new install", async () => {
  const f = fixture();
  const login = join(f.root, "login");
  const pi = executable(join(login, "pi"));
  let probes = 0;
  try {
    const locator = new ExecutableLocator({
      env: f.env,
      probeLoginShell: async () => {
        probes += 1;
        return probes === 1
          ? { path: null, problem: null }
          : { path: login, problem: null };
      },
    });
    assert.equal((await locator.resolve(executableSpec("pi")))?.path, pi);
    assert.equal(probes, 2);
  } finally {
    f.clean();
  }
});

test("negative caching is shared, expires, and explicit refresh sees an install", async () => {
  const f = fixture();
  const login = join(f.root, "login");
  let now = 1_000;
  let probes = 0;
  let shell: LoginShellResult = { path: null, problem: null };
  try {
    const locator = new ExecutableLocator({
      env: f.env,
      now: () => now,
      probeLoginShell: async () => {
        probes += 1;
        return shell;
      },
    });
    assert.equal(await locator.resolve(executableSpec("pi")), null);
    assert.equal(await locator.resolve(executableSpec("pi")), null);
    assert.equal(probes, 2);

    const pi = executable(join(login, "pi"));
    shell = { path: login, problem: null };
    await locator.refresh({ force: true });
    assert.equal((await locator.resolve(executableSpec("pi")))?.path, pi);
    assert.equal(probes, 3);

    rmSync(pi);
    assert.equal(await locator.resolve(executableSpec("pi")), null);
    now += EXECUTABLE_REFRESH_COOLDOWN_MS + 1;
    assert.equal(await locator.resolve(executableSpec("pi")), null);
    assert.equal(probes, 4);
  } finally {
    f.clean();
  }
});

test("a forced refresh queues behind an in-flight ordinary refresh", async () => {
  const f = fixture();
  let now = 1_000;
  let probes = 0;
  let release = (_value: LoginShellResult): void => {};
  const ordinaryProbe = new Promise<LoginShellResult>((resolve) => { release = resolve; });
  try {
    const locator = new ExecutableLocator({
      env: f.env,
      now: () => now,
      probeLoginShell: async () => {
        probes += 1;
        if (probes === 1) return { path: null, problem: null };
        if (probes === 2) return await ordinaryProbe;
        return { path: "/forced/bin", problem: null };
      },
    });
    await locator.initialize();
    now += EXECUTABLE_REFRESH_COOLDOWN_MS + 1;
    const ordinary = locator.refresh();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(probes, 2);
    const forced = locator.refresh({ force: true });
    release({ path: "/ordinary/bin", problem: null });
    await ordinary;
    const snapshot = await forced;
    assert.equal(probes, 3);
    assert.equal(snapshot.path.split(delimiter).includes("/forced/bin"), true);
  } finally {
    f.clean();
  }
});

test("concurrent forced refreshes coalesce into one bounded shell probe", async () => {
  const f = fixture();
  let release = (_value: LoginShellResult): void => {};
  let probes = 0;
  const pending = new Promise<LoginShellResult>((resolve) => { release = resolve; });
  try {
    const locator = new ExecutableLocator({
      env: f.env,
      probeLoginShell: async () => {
        probes += 1;
        return await pending;
      },
    });
    const reads = [locator.refresh({ force: true }), locator.refresh({ force: true })];
    release({ path: null, problem: null });
    await Promise.all(reads);
    assert.equal(probes, 1);
  } finally {
    f.clean();
  }
});
