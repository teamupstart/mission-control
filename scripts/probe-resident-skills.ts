/**
 * Real-installation rejection probe for resident skill isolation. No inference is sent.
 * All fixtures and harness state live under a temporary home, and the Claude API endpoint
 * is unreachable. A counterexample at startup is enough to reject a mechanism; passing
 * this discovery probe would still require the full invocation/resume/settings check.
 *
 * Run: node --import tsx scripts/probe-resident-skills.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { initializeExecutableEnvironment, locateExecutable } from "../src/server/executables/locator.ts";
import { AppServerClient } from "../src/server/harness/codex/app-server/client.ts";
import { spawnAppServer } from "../src/server/harness/codex/sdk-deps.ts";

await initializeExecutableEnvironment();
const claude = await locateExecutable("claude");
const codex = await locateExecutable("codex");
if (!claude || !codex) throw new Error("This probe requires real Claude Code and Codex installations.");
const root = mkdtempSync(join(tmpdir(), "mission-skills-probe-"));
const home = join(root, "home");
const cwd = join(root, "repo");
const overlay = join(root, "overlay");
const plugin = join(root, "snapshot-plugin");
for (const path of [home, cwd, overlay, join(plugin, ".claude-plugin")]) mkdirSync(path, { recursive: true });
function skill(base: string, name: string): void {
  const path = join(base, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: Probe fixture ${name}\n---\nReply with FROZEN_${name}.\n`);
}
for (const [base, name] of [
  [join(home, ".claude/skills"), "native-claude"],
  [join(home, ".agents/skills"), "native-agents"],
  [join(home, ".codex/skills"), "native-codex"],
  [join(cwd, ".claude/skills"), "project-claude"],
  [join(cwd, ".agents/skills"), "project-agents"],
  [join(overlay, "skills"), "snapshot-selected"],
  [join(plugin, "skills"), "snapshot-plugin"],
] as const) skill(base, name);
writeFileSync(join(plugin, ".claude-plugin/plugin.json"), JSON.stringify({ name: "frozen" }));
writeFileSync(join(overlay, "settings.json"), "{}");
const env = {
  PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: overlay, CODEX_HOME: overlay,
  DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  ANTHROPIC_BASE_URL: "http://127.0.0.1:1", ANTHROPIC_API_KEY: "probe-local-only",
};
try {
  for (const [id, executable] of [["claude", claude], ["codex", codex]] as const) {
    console.log(JSON.stringify({ harness: id, version: execFileSync(executable.path, ["--version"], { encoding: "utf8", env, timeout: 10000 }).trim(), executableSha256: createHash("sha256").update(readFileSync(executable.path)).digest("hex") }));
  }
  const claudeCases: Array<{ label: string; options: Partial<Options>; required: string[] }> = [
    { label: "config-overlay", options: {}, required: ["snapshot-selected", "project-claude"] },
    { label: "settings-and-plugin-fallback", options: { settings: { strictPluginOnlyCustomization: ["skills"], disableBundledSkills: true }, plugins: [{ type: "local", path: plugin }] }, required: ["project-claude", "frozen:snapshot-plugin"] },
    { label: "disable-slash-commands", options: { extraArgs: { "disable-slash-commands": null } }, required: [] },
  ];
  for (const probe of claudeCases) {
    let release = (): void => {};
    const prompt = (async function* () {
      await new Promise<void>((resolve) => { release = resolve; });
      yield* []; // End without ever submitting a model turn.
    })();
    const handle = query({ prompt, options: { pathToClaudeCodeExecutable: claude.path, cwd, env, settingSources: ["user", "project", "local"], ...probe.options } });
    const timer = setTimeout(() => handle.close(), 20000);
    try {
      const names = (await handle.supportedCommands()).map((command) => command.name);
      console.log(JSON.stringify({ harness: "claude", mechanism: probe.label, commands: names }));
      for (const name of probe.required) assert.ok(names.includes(name), `${probe.label}: expected ${name}; re-evaluate the capability on this installation`);
      if (!probe.required.length) assert.deepEqual(names, []);
    } finally { clearTimeout(timer); handle.close(); release(); }
  }
  // Build disables for the observed native names, then add a skill outside that set.
  const overrides = [join(cwd, ".agents/skills/project-agents/SKILL.md"), join(home, ".agents/skills/native-agents/SKILL.md")].map((path) => `{path=${JSON.stringify(path)},enabled=false}`).join(",");
  skill(join(cwd, ".agents/skills"), "late-project");
  for (const [label, args] of [
    ["home-overlay", []],
    ["known-path-disables", ["-c", "skills.bundled.enabled=false", "-c", `skills.config=[${overrides}]`]],
  ] as const) {
    const client = new AppServerClient(spawnAppServer(codex.path, args, cwd, env), { request() {}, notification() {} });
    const pumping = client.pump();
    const timer = setTimeout(() => { void client.close(); }, 20000);
    try {
      await client.request("initialize", { clientInfo: { name: "phase4_probe", version: "1" }, capabilities: { experimentalApi: true } });
      const result = await client.request<{ data: Array<{ skills: Array<{ name: string; enabled: boolean; scope: string }> }> }>("skills/list", { cwds: [cwd], forceReload: true });
      const skills = result.data.flatMap((data) => data.skills.map(({ name, enabled, scope }) => ({ name, enabled, scope })));
      console.log(JSON.stringify({ harness: "codex", mechanism: label, skills }));
      assert.ok(skills.some((entry) => entry.name === "late-project" && entry.enabled));
      assert.ok(skills.some((entry) => entry.name === "snapshot-selected" && entry.enabled));
      if (label === "known-path-disables") {
        assert.ok(skills.some((entry) => entry.name === "project-agents" && !entry.enabled));
        assert.ok(!skills.some((entry) => entry.scope === "system" && entry.enabled));
      }
    } finally { clearTimeout(timer); await client.close(); await pumping; }
  }
  console.log("Confirmed counterexamples for both proposed mechanisms. skillSelection remains null. No model calls or native operator-state writes.");
} finally { rmSync(root, { recursive: true, force: true }); }
