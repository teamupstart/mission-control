import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { PipelineProbe } from "../src/shared/pipeline.ts";
import type { TerminalTargetView } from "../src/shared/terminal.ts";
import {
  CMUX_APP_REMEDY,
  CMUX_SOCKET_CONTROL_REMEDY,
  HERDR_SERVER_REMEDY,
  SETUP_DEPENDENCY_IDS,
  SETUP_DEPENDENCY_INFO,
  SETUP_FAMILY_IDS,
  type SetupDependencyId,
} from "../src/shared/setup-catalog.ts";
import { SETUP_PROBES, setupChecksView, setupProbeResult } from "../src/server/setup/index.ts";
import type { SetupDeps } from "../src/server/setup/types.ts";
import { installedPluginsRead } from "../src/server/plugins/installed-plugins.ts";
import { stubRun } from "../src/server/util/exec.ts";

function conductor(found = true): PipelineProbe {
  return {
    provider: "ai-conductor",
    found,
    bin: "conduct-ts",
    binPath: found ? "/tools/conduct-ts" : null,
    version: found ? "1.2.3" : null,
    registryPath: "/home/.ai-conductor/registry.json",
    projects: [],
    error: found ? null : "missing",
    checkedAt: 1,
  };
}

function deps(overrides: Partial<SetupDeps> = {}): SetupDeps {
  return {
    environment: {
      homeDir: "/home/operator",
      readText: async () => ({ ok: false, missing: true, reason: "missing" }),
      subdirectories: async () => [],
    },
    agentBin: (agent) => `/tools/${agent}`,
    installedBackend: async (id) => `/tools/${id}`,
    herdrServer: async () => ({ state: "ready", socket: "/run/herdr.sock", version: "0.9.0" }),
    cmuxControl: async () => ({ state: "ready", accessMode: "allowAll" }),
    ghBin: () => "/tools/gh",
    resolveBinPath: async (bin) => bin === "node" ? "/tools/node" : bin.startsWith("/tools/") ? bin : null,
    runCommand: async (bin) => stubRun({ stdout: bin === "/tools/node" ? "24.0.0" : "Logged in to github.com account operator", stderr: "", code: 0 }),
    installedPlugins: async () => ({
      ok: true,
      plugins: [{ plugin: "one", marketplace: "official", version: "1", installPath: "/plugins/one" }],
      recordPath: "/home/operator/.claude/plugins/installed_plugins.json",
    }),
    skills: () => ({ enabled: true, readable: true, configured: 2, directories: ["/home/operator/.claude/skills"], problems: [] }),
    conductorProbe: async () => conductor(),
    terminalTargets: () => [{ id: "cmux", label: "cmux", glyph: "", blurb: "New workspace.", detail: null, unavailable: null }],
    environmentChecks: async () => [],
    readBannerDismissal: () => ({ firstLaunchAcknowledged: false, acknowledged: [] }),
    writeBannerDismissal: () => {},
    ...overrides,
  };
}

/** One probe, normalized: a probe may answer with a status or with a status and a remedy. */
async function probed(id: SetupDependencyId, overrides: Partial<SetupDeps> = {}) {
  return setupProbeResult(await SETUP_PROBES[id](deps(overrides)));
}

/** The status alone, which is what every probe but Herdr's has to say. */
async function probe(id: SetupDependencyId, overrides: Partial<SetupDeps> = {}) {
  return (await probed(id, overrides)).status;
}

test("every dependency probe can report satisfied evidence", async () => {
  for (const id of SETUP_DEPENDENCY_IDS) {
    const status = await probe(id);
    assert.equal(status.state, "satisfied", id);
    assert.ok("evidence" in status && status.evidence.length > 0, id);
  }
});

test("one fresh PATH snapshot precedes the concurrent Setup probes", async () => {
  let refreshes = 0;
  let refreshed = false;
  await setupChecksView(deps({
    refreshPath: async () => {
      refreshes += 1;
      refreshed = true;
    },
    resolveBinPath: async (bin) => {
      assert.equal(refreshed, true, bin);
      return bin.startsWith("/tools/") ? bin : null;
    },
  }));
  assert.equal(refreshes, 1);
});

test("Setup exposes positive Pi extension readiness for runtime gating", async () => {
  const view = await setupChecksView(deps({
    environmentChecks: async () => [{
      id: "pi-extension",
      label: "Pi extension",
      warning: null,
      detail: null,
      ready: true,
    }],
  }));
  assert.equal(view.piExtensionReady, true);
});

test("Node Setup checks the selected executable, shares the installer floor, and recovers", async () => {
  for (const version of ["18.20.0", "22.0.0", "23.11.0", "24.0.0", "26.0.0"]) {
    const status = await probe("node-runtime", {
      executableDiagnostic: async (id) => {
        assert.equal(id, "node");
        return { path: "/selected/node", source: "operator override" };
      },
      runCommand: async (bin, args) => {
        assert.equal(bin, "/selected/node");
        assert.deepEqual(args, ["-p", "process.versions.node"]);
        return stubRun({ stdout: version, stderr: "", code: 0 });
      },
    });
    if (Number(version.split(".")[0]) < 24) {
      assert.equal(status.state, "needs-setup");
      if (status.state === "needs-setup") {
        assert.ok(status.why.includes(version));
        assert.match(status.why, /requires Node.js 24 or newer/);
        assert.match(status.why, /Re-check/);
        assert.match(status.why, /MISSION_NODE_BIN.*restart Mission Control/);
      }
    } else {
      assert.deepEqual(status, { state: "satisfied", evidence: `/selected/node (Node.js ${version})`, source: "operator override" });
    }
  }
});

test("Node Setup reports missing and unverifiable runtimes without a false Ready", async () => {
  const missing = await probe("node-runtime", {
    resolveBinPath: async () => null,
    runCommand: async () => { throw Error("must not run a missing executable"); },
  });
  assert.equal(missing.state, "needs-setup");
  if (missing.state === "needs-setup") assert.match(missing.why, /could not be found.*requires Homebrew/);
  for (const result of [
    stubRun({ stdout: "not Node", stderr: "", code: 0 }),
    stubRun({ stdout: "24.fake", stderr: "", code: 0 }),
    stubRun({ stdout: "24.0.0", stderr: "failed", code: 1 }),
    { ...stubRun({ stdout: "24.0.0", stderr: "timeout", code: null }), outcomeUnknown: true },
    { ...stubRun({ stdout: "24.0.0", stderr: "overflow", code: 0 }), overflowed: true },
  ]) {
    const status = await probe("node-runtime", { runCommand: async () => result });
    assert.equal(status.state, "unknown");
    if (status.state === "unknown") assert.match(status.why, /could not verify.*Re-check/);
  }
});

test("missing, needs-setup, and unknown stay distinct", async () => {
  assert.deepEqual(
    await probe("claude-cli", { resolveBinPath: async () => null }),
    { state: "missing" },
  );
  const auth = await probe("gh-auth", {
    runCommand: async () => stubRun({ stdout: "", stderr: "not logged in", code: 1 }),
  });
  assert.equal(auth.state, "needs-setup");
  const timeout = await probe("gh-auth", {
    runCommand: async () => ({ ...stubRun({ stdout: "", stderr: "timed out", code: null }), outcomeUnknown: true }),
  });
  assert.equal(timeout.state, "unknown");
  const plugin = await probe("claude-plugins", {
    installedPlugins: async () => ({ ok: false, missing: false, reason: "EACCES", recordPath: "/record" }),
  });
  assert.deepEqual(plugin, { state: "unknown", why: "Claude Code's plugin record could not be read.", evidence: "EACCES" });
});

test("an unsupported Herdr host is actionable without probing installation", async () => {
  let installationProbes = 0;
  const status = await probe("herdr", {
    backendUnsupported: (id) => id === "herdr" ? "Herdr integration is supported on macOS and Linux only" : null,
    installedBackend: async () => {
      installationProbes += 1;
      return "/tools/herdr";
    },
  });
  assert.deepEqual(status, {
    state: "needs-setup",
    why: "Herdr integration is supported on macOS and Linux only",
    evidence: null,
  });
  assert.equal(installationProbes, 0);
});

test("an installed Herdr with a stopped server is needs-setup, and offers the start", async () => {
  const stopped = await probed("herdr", {
    herdrServer: async () => ({ state: "stopped", socket: "/run/herdr.sock" }),
  });
  assert.deepEqual(stopped.status, {
    state: "needs-setup",
    why: "Herdr is installed but its default server is not running. Mission Control cannot list, open, or type into Herdr workspaces until it starts.",
    evidence: "/tools/herdr",
  });
  assert.deepEqual(stopped.remedy, HERDR_SERVER_REMEDY);

  const running = await probed("herdr");
  assert.deepEqual(running.status, { state: "satisfied", evidence: "/tools/herdr (server 0.9.0)" });
  assert.equal(running.remedy, undefined);
});

test("a missing Herdr keeps the catalog install remedy and never probes its server", async () => {
  let serverProbes = 0;
  const missing = await probed("herdr", {
    installedBackend: async () => null,
    herdrServer: async () => {
      serverProbes += 1;
      return { state: "stopped", socket: "/run/herdr.sock" };
    },
  });
  assert.deepEqual(missing.status, { state: "missing" });
  assert.equal(missing.remedy, undefined);
  assert.equal(serverProbes, 0);
});

test("an incompatible Herdr server is not offered a start it cannot be repaired by", async () => {
  const incompatible = await probed("herdr", {
    herdrServer: async () => ({ state: "failed", error: "Herdr server is incompatible.", retryable: false }),
  });
  assert.deepEqual(incompatible.status, {
    state: "needs-setup",
    why: "Herdr server is incompatible.",
    evidence: "/tools/herdr",
  });
  assert.equal(incompatible.remedy, undefined);

  const unreadable = await probed("herdr", {
    herdrServer: async () => ({ state: "failed", error: "Herdr server status did not finish.", retryable: true }),
  });
  assert.deepEqual(unreadable.remedy, HERDR_SERVER_REMEDY);
});

test("an installed cmux that is closed or refusing is needs-setup, with the matching repair", async () => {
  // The reading this row used to give: cmux on PATH, so "satisfied", while every dispatch to
  // it was answered by an empty pane list. Both faults below produce exactly that, and they
  // are told apart because opening a running app and reconfiguring a closed one each repair
  // a fault the operator does not have.
  const closed = await probed("cmux", { cmuxControl: async () => ({ state: "stopped" }) });
  assert.deepEqual(closed.status, {
    state: "needs-setup",
    why: "cmux is installed but not running. Its control socket exists only while the app is open, so Mission Control cannot list, create, or type into cmux workspaces until it is.",
    evidence: "/tools/cmux",
  });
  assert.deepEqual(closed.remedy, CMUX_APP_REMEDY);

  const refused = await probed("cmux", { cmuxControl: async () => ({ state: "refused" }) });
  assert.deepEqual(refused.status, {
    state: "needs-setup",
    why: "cmux is running but its control socket only admits processes started inside cmux. Mission Control's daemon is not one, so every call it makes is denied until automation.socketControlMode is allowAll.",
    evidence: "/tools/cmux",
  });
  assert.deepEqual(refused.remedy, CMUX_SOCKET_CONTROL_REMEDY);

  const ready = await probed("cmux");
  assert.deepEqual(ready.status, {
    state: "satisfied",
    evidence: "/tools/cmux (socket control allowAll)",
  });
  assert.equal(ready.remedy, undefined);
});

test("a missing cmux keeps the catalog install remedy and never probes its socket", async () => {
  let controlProbes = 0;
  const missing = await probed("cmux", {
    installedBackend: async () => null,
    cmuxControl: async () => {
      controlProbes += 1;
      return { state: "stopped" };
    },
  });
  assert.deepEqual(missing.status, { state: "missing" });
  assert.equal(missing.remedy, undefined);
  assert.equal(controlProbes, 0);
});

test("a cmux socket that failed some other way is not offered a repair for a fault it does not have", async () => {
  const other = await probed("cmux", {
    cmuxControl: async () => ({ state: "failed", error: "cmux capabilities failed" }),
  });
  assert.deepEqual(other.status, {
    state: "needs-setup",
    why: "cmux capabilities failed",
    evidence: "/tools/cmux",
  });
  assert.equal(other.remedy, undefined);
});

test("a probe remedy overrides the catalog remedy on the row it repairs", async () => {
  const view = await setupChecksView(deps({
    herdrServer: async () => ({ state: "stopped", socket: "/run/herdr.sock" }),
  }));
  const herdr = view.rows.find((row) => row.rowId.source === "dependency" && row.rowId.id === "herdr");
  assert.deepEqual(herdr?.remedy, HERDR_SERVER_REMEDY);
  const wezterm = view.rows.find((row) => row.rowId.source === "dependency" && row.rowId.id === "wezterm");
  assert.deepEqual(wezterm?.remedy, SETUP_DEPENDENCY_INFO.wezterm.remedy);
});

test("an outdated GitHub CLI reports needs-setup, and a current one stays satisfied", async () => {
  const outdated = await probe("gh-cli", {
    runCommand: async () => stubRun({ stdout: "gh version 2.4.0 (2021-08-10)\n", stderr: "", code: 0 }),
  });
  assert.equal(outdated.state, "needs-setup");
  assert.match(outdated.state === "needs-setup" ? outdated.why : "", /2\.100\.0/);

  const current = await probe("gh-cli", {
    runCommand: async () => stubRun({ stdout: "gh version 2.100.0 (2024-01-01)\n", stderr: "", code: 0 }),
  });
  assert.deepEqual(current, { state: "satisfied", evidence: "/tools/gh" });

  const unparseable = await probe("gh-cli", {
    runCommand: async () => ({ ...stubRun({ stdout: "", stderr: "timed out", code: null }), outcomeUnknown: true }),
  });
  assert.equal(unparseable.state, "satisfied");

  const nonzeroExit = await probe("gh-cli", {
    runCommand: async () => stubRun({ stdout: "gh version 2.4.0 (2021-08-10)\n", stderr: "some other error", code: 1 }),
  });
  assert.deepEqual(nonzeroExit, { state: "satisfied", evidence: "/tools/gh" });
});

test("a schema-invalid Claude plugin record is unknown rather than missing", async () => {
  const pluginsDir = mkdtempSync(join(tmpdir(), "mission-setup-plugins-"));
  try {
    writeFileSync(
      join(pluginsDir, "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: [] }),
      "utf8",
    );
    const reading = await installedPluginsRead(pluginsDir);
    const view = await setupChecksView(deps({ installedPlugins: async () => reading }));
    const row = view.rows.find(
      (candidate) => candidate.rowId.source === "dependency" && candidate.rowId.id === "claude-plugins",
    );

    assert.equal(row?.status.state, "unknown");
    assert.match(row?.status.state === "unknown" ? row.status.evidence ?? "" : "", /unsupported schema/);

    writeFileSync(
      join(pluginsDir, "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: {} }),
      "utf8",
    );
    const empty = await installedPluginsRead(pluginsDir);
    const emptyView = await setupChecksView(deps({ installedPlugins: async () => empty }));
    const emptyRow = emptyView.rows.find(
      (candidate) => candidate.rowId.source === "dependency" && candidate.rowId.id === "claude-plugins",
    );
    assert.equal(emptyRow?.status.state, "missing");
  } finally {
    rmSync(pluginsDir, { recursive: true, force: true });
  }
});

test("one thrown probe becomes its own unknown row", async () => {
  const view = await setupChecksView(deps({
    conductorProbe: async () => { throw new Error("broken probe"); },
  }));
  assert.equal(view.rows.length, SETUP_DEPENDENCY_IDS.length + 1);
  const row = view.rows.find((candidate) => candidate.rowId.source === "dependency" && candidate.rowId.id === "ai-conductor");
  assert.equal(row?.status.state, "unknown");
  assert.match(row?.status.state === "unknown" ? row.status.why : "", /broken probe/);
  assert.equal(view.rows.find((candidate) => candidate.rowId.source === "dependency" && candidate.rowId.id === "claude-cli")?.status.state, "satisfied");
});

test("conductor provenance is reported only for the path that was probed", async () => {
  const status = await probe("ai-conductor", {
    executableDiagnostic: async () => ({ path: "/different/conduct-ts", source: "Login shell" }),
  });
  assert.deepEqual(status, {
    state: "satisfied",
    evidence: "/tools/conduct-ts 1.2.3",
  });
});

test("dependency rows project their catalog requirement without adding a second opinion", async () => {
  const view = await setupChecksView(deps());
  const familyIndexes = view.rows.map((row) => SETUP_FAMILY_IDS.indexOf(row.family));
  assert.deepEqual(familyIndexes, [...familyIndexes].sort((a, b) => a - b), "rendered rows remain family-grouped even though stable ids append");
  for (const id of SETUP_DEPENDENCY_IDS) {
    const row = view.rows.find((candidate) => candidate.rowId.source === "dependency" && candidate.rowId.id === id);
    assert.equal(row?.requirement, SETUP_DEPENDENCY_INFO[id].requirement, id);
  }
});

test("the required terminal pair follows usable composition, not backend presence", async () => {
  const targets: TerminalTargetView[] = [
    { id: "tmux", label: "tmux", glyph: "", blurb: "", detail: null, unavailable: "install a terminal that can show one" },
  ];
  const view = await setupChecksView(deps({ terminalTargets: () => targets }));
  const tmux = view.rows.find((row) => row.rowId.source === "dependency" && row.rowId.id === "tmux");
  const pair = view.rows.find((row) => row.rowId.source === "derived");
  assert.equal(tmux?.status.state, "satisfied");
  assert.equal(pair?.status.state, "missing");
  assert.equal(pair?.requirement, "required");
});
