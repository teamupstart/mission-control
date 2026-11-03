import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { parse as parseToml } from "smol-toml";
import { parse as parseJson } from "jsonc-parser";
import { CLAUDE_MCP_ALLOW, CODEX_MCP_NOT_REGISTERED, CODEX_MCP_UNUSABLE, enableMcpTrust, hasMcpTrust, mcpTrustPath, mcpTrustStatus, withMcpTrust } from "../src/server/setup/mcp-trust.ts";

import { withProcessEnv } from "./helpers/process-env.ts";

const codex = '# keep this\napproval_policy = "on-request"\n[mcp_servers.mission-control]\ncommand = "node"\nargs = ["server.mjs"]\n[mcp_servers.other]\nurl = "https://example.invalid"\n';

test("Claude merges its scoped allow rule, preserves restrictions and is idempotent", () => {
  const original = '{\n // keep this\n "permissions": {"allow": ["Read"], "deny": ["mcp__mission-control__kill_session"], "ask": ["Bash"]}, "env": {"KEEP": "yes"}\n}';
  const result = withMcpTrust("claude", original);
  assert.ok(result.includes("// keep this"));
  const before = parseJson(original);
  before.permissions.allow.push(CLAUDE_MCP_ALLOW);
  assert.deepEqual(parseJson(result), before);
  assert.equal(withMcpTrust("claude", result), result);
  assert.equal(hasMcpTrust("claude", result), true);
  assert.deepEqual(parseJson(withMcpTrust("claude", "")).permissions.allow, [CLAUDE_MCP_ALLOW]);
});

test("Claude appends to an existing allow array without removing its comments", () => {
  for (const allow of ['["Read",\n // keep between entries\n "Bash(git status)"]', '[/* keep empty array comment */]']) {
    const original = `{"permissions":{"allow":${allow}}}`;
    const result = withMcpTrust("claude", original);
    const expected = parseJson(original);
    expected.permissions.allow.push(CLAUDE_MCP_ALLOW);
    assert.deepEqual(parseJson(result), expected);
    const comment = allow.includes("between") ? "// keep between entries" : "/* keep empty array comment */";
    assert.ok(result.includes(comment), `must retain ${comment}`);
    assert.equal(withMcpTrust("claude", result), result);
  }
});

test("symlinked settings refuse repair without recovery files and allow satisfied no-ops", (t) => {
  const root = mkdtempSync(join(tmpdir(), "mcp-trust-symlink-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const agent of ["claude", "codex"] as const) {
    const dir = join(root, agent);
    mkdirSync(dir);
    const path = join(dir, "settings");
    const target = join(dir, "target");
    const original = agent === "claude" ? "{}" : codex;
    writeFileSync(target, original);
    symlinkSync("target", path);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = enableMcpTrust(agent, path);
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /cannot update a symlinked settings file/);
      assert.equal(readFileSync(target, "utf8"), original);
      assert.equal(readlinkSync(path), "target");
      assert.deepEqual(readdirSync(dir).sort(), ["settings", "target"]);
    }
    const trusted = withMcpTrust(agent, original);
    writeFileSync(target, trusted);
    assert.deepEqual(enableMcpTrust(agent, path), { ok: true, outcomeUnknown: false });
    assert.equal(mcpTrustStatus(agent, path).state, "satisfied");
    assert.equal(readFileSync(target, "utf8"), trusted);
    assert.equal(lstatSync(path).isSymbolicLink(), true);
    assert.deepEqual(readdirSync(dir).sort(), ["settings", "target"]);
  }
});

test("Codex changes only the server default, preserving other servers, overrides and comments", () => {
  for (const name of ["mission-control", '"mission-control"', "'mission-control'"]) {
    for (const mode of ["", 'default_tools_approval_mode = "prompt" # retain\n']) {
      const original = codex.replace("[mcp_servers.mission-control]", `[mcp_servers.${name}]`).replace('command =', mode + 'command =') + '\n[mcp_servers.mission-control.tools.kill_session]\napproval_mode = "prompt"\n';
      const result = withMcpTrust("codex", original);
      const expected = parseToml(original);
      (expected.mcp_servers as Record<string, Record<string, unknown>>)["mission-control"]!.default_tools_approval_mode = "approve";
      assert.deepEqual(parseToml(result), expected);
      assert.ok(result.includes("# keep this"));
      if (mode) assert.ok(result.includes("# retain"));
      assert.equal(withMcpTrust("codex", result), result);
      assert.equal(hasMcpTrust("codex", result), true);
    }
  }
});

test("malformed and unsupported configs are refused without modifying the file", (t) => {
  const home = mkdtempSync(join(tmpdir(), "mcp-trust-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const [agent, inputs] of [
    ["claude", ['{broken', '[]', 'null', '{"permissions": []}', '{"permissions":{"allow":"all"}}']],
    ["codex", ['[broken', '', 'mcp_servers.mission-control = { command = "node" }', '[mcp_servers.mission-control]\ncommand = "node"\ndefault_tools_approval_mode = false']],
  ] as const) {
    for (const input of inputs) {
      const path = join(home, "settings");
      writeFileSync(path, input);
      assert.equal(enableMcpTrust(agent, path).ok, false, input);
      assert.equal(readFileSync(path, "utf8"), input);
      assert.deepEqual(readdirSync(home), ["settings"]);
    }
  }
});

test("an unregistered Codex server names the integration install as its prerequisite", (t) => {
  const home = mkdtempSync(join(tmpdir(), "mcp-trust-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "config.toml");
  for (const input of ["", 'approval_policy = "on-request"\n[mcp_servers.other]\nurl = "https://example.invalid"\n']) {
    writeFileSync(path, input);
    const status = mcpTrustStatus("codex", path);
    assert.equal(status.state, "needs-setup", input);
    assert.equal(status.state === "needs-setup" && status.why, CODEX_MCP_NOT_REGISTERED);
    assert.deepEqual(enableMcpTrust("codex", path), {
      ok: false, outcomeUnknown: false, error: CODEX_MCP_NOT_REGISTERED, prerequisite: "mission-integrations",
    });
    assert.equal(readFileSync(path, "utf8"), input);
  }
  // A registered but untrusted server keeps the generic sentence and no prerequisite.
  writeFileSync(path, codex);
  const status = mcpTrustStatus("codex", path);
  assert.equal(status.state === "needs-setup" && status.why, "Mission Control MCP is not allowed by default in this agent's user settings.");
  writeFileSync(path, "[broken");
  assert.equal(enableMcpTrust("codex", path).prerequisite, undefined);
});

test("a disabled Codex server is not a registration trust can satisfy", (t) => {
  const home = mkdtempSync(join(tmpdir(), "mcp-trust-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "config.toml");
  // Codex skips an entry with `enabled = false`, so even an already-approved one must not read
  // as Ready: no session could reach its tools.
  const disabledApproved = '[mcp_servers.mission-control]\ncommand = "node"\nenabled = false\ndefault_tools_approval_mode = "approve"\n';
  assert.equal(hasMcpTrust("codex", disabledApproved), false);
  // The installer preserves any existing table, so a table that cannot launch - disabled, or
  // with no command or url - gets the hand-edit sentence and no install prerequisite.
  for (const text of [disabledApproved, "[mcp_servers.mission-control]\nenabled = true\n"]) {
    writeFileSync(path, text);
    const status = mcpTrustStatus("codex", path);
    assert.equal(status.state === "needs-setup" && status.why, CODEX_MCP_UNUSABLE, text);
    assert.deepEqual(enableMcpTrust("codex", path), { ok: false, outcomeUnknown: false, error: CODEX_MCP_UNUSABLE });
    assert.equal(readFileSync(path, "utf8"), text);
  }
  // Explicitly enabled, or an `enabled` value that is not the literal `false`, still counts,
  // and an odd value never makes the config unreadable.
  for (const enabled of ["true", '"yes"']) {
    const text = `[mcp_servers.mission-control]\ncommand = "node"\nenabled = ${enabled}\ndefault_tools_approval_mode = "approve"\n`;
    assert.equal(hasMcpTrust("codex", text), true, enabled);
  }
});

test("publication retains the original and recheck becomes satisfied without a second write", (t) => {
  const home = mkdtempSync(join(tmpdir(), "mcp-trust-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const agent of ["claude", "codex"] as const) {
    const path = join(home, agent);
    const original = agent === "claude" ? "{}" : codex;
    writeFileSync(path, original);
    assert.equal(mcpTrustStatus(agent, path).state, "needs-setup");
    assert.equal(enableMcpTrust(agent, path).ok, true);
    assert.equal(mcpTrustStatus(agent, path).state, "satisfied");
    const recovery = readdirSync(home).find((name) => name.startsWith(`${agent}.mission-migration-`))!;
    const attempt = readdirSync(join(home, recovery))[0]!;
    assert.equal(readFileSync(join(home, recovery, attempt, "original"), "utf8"), original);
    const before = readdirSync(home);
    assert.equal(enableMcpTrust(agent, path).ok, true);
    assert.deepEqual(readdirSync(home), before);
  }
  const bad = join(home, "bad");
  writeFileSync(bad, '{"permissions":true}');
  assert.equal(mcpTrustStatus("claude", bad).state, "unknown");
});

test("TOML header text inside a multiline string is not edited as configuration", () => {
  const original = 'instructions = """\n[mcp_servers.mission-control]\ncommand = "pretend"\n"""\n' + codex;
  assert.throws(() => withMcpTrust("codex", original));
  const crlf = codex.replaceAll("\n", "\r\n");
  assert.equal(hasMcpTrust("codex", withMcpTrust("codex", crlf)), true);
});


for (const scenario of [
  { name: "Claude explicit settings path wins over config directory and home", agent: "claude", selected: "claude-explicit", explicit: true, configDir: true, codexHome: true },
  { name: "Claude config directory wins over home without an explicit settings path", agent: "claude", selected: "claude-dir", explicit: false, configDir: true, codexHome: true },
  { name: "Claude falls back to its home settings without either override", agent: "claude", selected: "claude-default", explicit: false, configDir: false, codexHome: true },
  { name: "Codex home override wins over the default home and ignores Claude overrides", agent: "codex", selected: "codex-override", explicit: true, configDir: true, codexHome: true },
  { name: "Codex falls back to its home config without CODEX_HOME", agent: "codex", selected: "codex-default", explicit: true, configDir: true, codexHome: false },
] as const) {
  test(scenario.name, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "mcp-trust-paths-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const fixtureHome = join(root, "home");
    // Every candidate is distinct and disposable, including the home fallback. A broken
    // precedence rule must fail this test without ever reaching the operator's settings.
    const paths = {
      "claude-explicit": join(root, "explicit", "custom.json"),
      "claude-dir": join(root, "claude-config", "settings.json"),
      "claude-default": join(fixtureHome, ".claude", "settings.json"),
      "codex-override": join(root, "codex-config", "config.toml"),
      "codex-default": join(fixtureHome, ".codex", "config.toml"),
    };
    const originals = new Map<string, string>();
    for (const [key, path] of Object.entries(paths)) {
      const original = key.startsWith("claude")
        ? JSON.stringify({ permissions: { allow: ["Read"] }, candidate: key })
        : `# candidate: ${key}\n${codex}`;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, original);
      originals.set(path, original);
    }
    await withProcessEnv({
      HOME: fixtureHome,
      CLAUDE_SETTINGS_PATH: scenario.explicit ? paths["claude-explicit"] : undefined,
      CLAUDE_CONFIG_DIR: scenario.configDir ? dirname(paths["claude-dir"]) : undefined,
      CODEX_HOME: scenario.codexHome ? dirname(paths["codex-override"]) : undefined,
    }, () => {
      const selectedPath = paths[scenario.selected];
      assert.equal(mcpTrustPath(scenario.agent), selectedPath);
      assert.equal(mcpTrustStatus(scenario.agent).state, "needs-setup");
      assert.deepEqual(enableMcpTrust(scenario.agent), { ok: true, outcomeUnknown: false });
      assert.equal(hasMcpTrust(scenario.agent, readFileSync(selectedPath, "utf8")), true);
      const status = mcpTrustStatus(scenario.agent);
      assert.equal(status.state, "satisfied");
      assert.ok("evidence" in status && status.evidence?.startsWith(`${selectedPath}:`));
      for (const [path, original] of originals) {
        if (path !== selectedPath) assert.equal(readFileSync(path, "utf8"), original, `must preserve ${path}`);
      }
    });
  });
}

test("Claude repair creates an absent settings file and reports Ready", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "mcp-trust-first-setup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "new-config", "settings.json");
  await withProcessEnv({
    HOME: root,
    CLAUDE_SETTINGS_PATH: path,
    CLAUDE_CONFIG_DIR: join(root, "other-config"),
  }, () => {
    assert.equal(existsSync(dirname(path)), false);
    assert.equal(mcpTrustStatus("claude").state, "needs-setup");
    assert.equal(existsSync(path), false, "checking readiness must not create the file");
    assert.deepEqual(enableMcpTrust("claude"), { ok: true, outcomeUnknown: false });
    assert.deepEqual(parseJson(readFileSync(path, "utf8")), { permissions: { allow: [CLAUDE_MCP_ALLOW] } });
    assert.equal(mcpTrustStatus("claude").state, "satisfied");
    assert.equal(existsSync(join(root, "other-config")), false);
    assert.equal(existsSync(join(root, ".claude")), false);
  });
});
