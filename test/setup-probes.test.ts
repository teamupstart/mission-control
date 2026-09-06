import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { PipelineProbe } from "../src/shared/pipeline.ts";
import type { TerminalTargetView } from "../src/shared/terminal.ts";
import {
  SETUP_DEPENDENCY_IDS,
  SETUP_DEPENDENCY_INFO,
  SETUP_FAMILY_IDS,
} from "../src/shared/setup-catalog.ts";
import { SETUP_PROBES, setupChecksView } from "../src/server/setup/index.ts";
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
    ghBin: () => "/tools/gh",
    resolveBinPath: async (bin) => bin.startsWith("/tools/") ? bin : null,
    runCommand: async () => stubRun({ stdout: "Logged in to github.com account operator", stderr: "", code: 0 }),
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

test("every dependency probe can report satisfied evidence", async () => {
  for (const id of SETUP_DEPENDENCY_IDS) {
    const status = await SETUP_PROBES[id](deps());
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

test("missing, needs-setup, and unknown stay distinct", async () => {
  assert.deepEqual(
    await SETUP_PROBES["claude-cli"](deps({ resolveBinPath: async () => null })),
    { state: "missing" },
  );
  const auth = await SETUP_PROBES["gh-auth"](deps({
    runCommand: async () => stubRun({ stdout: "", stderr: "not logged in", code: 1 }),
  }));
  assert.equal(auth.state, "needs-setup");
  const timeout = await SETUP_PROBES["gh-auth"](deps({
    runCommand: async () => ({ ...stubRun({ stdout: "", stderr: "timed out", code: null }), outcomeUnknown: true }),
  }));
  assert.equal(timeout.state, "unknown");
  const plugin = await SETUP_PROBES["claude-plugins"](deps({
    installedPlugins: async () => ({ ok: false, missing: false, reason: "EACCES", recordPath: "/record" }),
  }));
  assert.deepEqual(plugin, { state: "unknown", why: "Claude Code's plugin record could not be read.", evidence: "EACCES" });
});

test("an unsupported Herdr host is actionable without probing installation", async () => {
  let installationProbes = 0;
  const status = await SETUP_PROBES.herdr(deps({
    backendUnsupported: (id) => id === "herdr" ? "Herdr integration is supported on macOS and Linux only" : null,
    installedBackend: async () => {
      installationProbes += 1;
      return "/tools/herdr";
    },
  }));
  assert.deepEqual(status, {
    state: "needs-setup",
    why: "Herdr integration is supported on macOS and Linux only",
    evidence: null,
  });
  assert.equal(installationProbes, 0);
});

test("an outdated GitHub CLI reports needs-setup, and a current one stays satisfied", async () => {
  const outdated = await SETUP_PROBES["gh-cli"](deps({
    runCommand: async () => stubRun({ stdout: "gh version 2.4.0 (2021-08-10)\n", stderr: "", code: 0 }),
  }));
  assert.equal(outdated.state, "needs-setup");
  assert.match(outdated.state === "needs-setup" ? outdated.why : "", /2\.100\.0/);

  const current = await SETUP_PROBES["gh-cli"](deps({
    runCommand: async () => stubRun({ stdout: "gh version 2.100.0 (2024-01-01)\n", stderr: "", code: 0 }),
  }));
  assert.deepEqual(current, { state: "satisfied", evidence: "/tools/gh" });

  const unparseable = await SETUP_PROBES["gh-cli"](deps({
    runCommand: async () => ({ ...stubRun({ stdout: "", stderr: "timed out", code: null }), outcomeUnknown: true }),
  }));
  assert.equal(unparseable.state, "satisfied");

  const nonzeroExit = await SETUP_PROBES["gh-cli"](deps({
    runCommand: async () => stubRun({ stdout: "gh version 2.4.0 (2021-08-10)\n", stderr: "some other error", code: 1 }),
  }));
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
  const status = await SETUP_PROBES["ai-conductor"](deps({
    executableDiagnostic: async () => ({ path: "/different/conduct-ts", source: "Login shell" }),
  }));
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
