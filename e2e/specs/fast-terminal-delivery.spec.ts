import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

// Discovery is required for terminal sessions. Address only our unique tmux card,
// never the rest of the fleet discovered on a developer's machine.
test.use({ daemonEnv: { MISSION_POLL_MS: "400", MISSION_RUNTIME_META_POLL_MS: "500" } });
test.skip(spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0, "tmux is required");

// The fake's whole response is one append: a passive read can never catch it working.
// The protocol and pty are real; no agent binary or model API is called.
const AGENT = `
import { openSync, writeSync, appendFileSync } from 'node:fs';
const [rollout, received, id] = process.argv.slice(2);
const fd = openSync(rollout, 'a'); // discovery binds the exact open rollout via lsof
const record = (type, payload, at = Date.now()) => JSON.stringify({
  timestamp: new Date(at).toISOString(), type, payload,
}) + '\\n';
writeSync(fd, record('session_meta', {id, cwd: process.cwd(), source: 'cli', thread_source: 'user'}) +
  record('event_msg', {type: 'task_complete', turn_id: 'initial'}, Date.now() - 5000));
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write('Ready\\n› ');
let input = '';
process.stdin.on('data', chunk => {
  input += chunk.toString().replace(/\\x1b\\[20[01]~/g, '');
  while (/[\\r\\n]/.test(input)) {
    const end = input.search(/[\\r\\n]/);
    const text = input.slice(0, end).trim();
    input = input.slice(end + 1);
    if (!text) continue;
    appendFileSync(received, text + '\\n');
    const at = Date.now(), turn = String(at);
    writeSync(fd,
      record('event_msg', {type: 'task_started', turn_id: turn, started_at: Math.floor(at / 1000)}, at) +
      record('event_msg', {type: 'item_completed', item: {type: 'UserMessage', id: 'u' + turn,
        content: [{type: 'text', text}]}}, at) +
      record('event_msg', {type: 'item_completed', item: {type: 'AgentMessage', id: 'a' + turn,
        phase: 'final_answer', content: [{type: 'Text', text: 'Acknowledged: ' + text}]}}, at + 1) +
      record('event_msg', {type: 'task_complete', turn_id: turn,
        started_at: Math.floor(at / 1000), completed_at: Math.floor(at / 1000)}, at + 1));
    process.stdout.write('Acknowledged: ' + text + '\\n› ');
  }
});
`;

test("fast Codex terminal replies confirm delivery and release the next queued message", async ({ dashboard, daemon }) => {
  const dir = join(daemon.home, "fast-terminal");
  const rolloutDir = join(dir, "sessions", "2026", "09", "18");
  mkdirSync(rolloutDir, { recursive: true });
  const bin = join(dir, "codex");
  symlinkSync(process.execPath, bin);
  const script = join(dir, "agent.mjs");
  const received = join(dir, "received.txt");
  const rollout = join(rolloutDir, `rollout-${randomUUID()}.jsonl`);
  writeFileSync(script, AGENT);
  writeFileSync(received, "");
  const name = `mc-fast-delivery-${process.pid}-${Date.now()}`;
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  execFileSync("tmux", ["new-session", "-d", "-s", name, "-x", "120", "-y", "40", "-c", dir,
    [bin, script, rollout, received, randomUUID()].map(quote).join(" ")]);
  try {
    const row = dashboard.getByRole("navigation", { name: "Sessions" })
      .locator("button.rail-row").filter({ hasText: name });
    await expect(row).toHaveCount(1);
    await expect(row.locator(".rail-state")).toHaveText("idle");
    await row.click();
    const detail = dashboard.locator(".console-detail");
    await expect(detail).toContainText(/tmux · %\d+/);
    const composer = detail.getByPlaceholder(/^Reply to this session/);
    await composer.fill("first fast reply");
    await composer.press("Enter");
    await expect(composer).toHaveValue("");
    await composer.fill("second queued reply");
    await composer.press("Enter");
    await expect(composer).toHaveValue("");
    await expect(detail.locator(".pending-turn").filter({ hasText: "second queued reply" })).toBeVisible();
    await expect(detail.locator(".pending-turn")).not.toHaveCount(0);
    await expect(detail.locator(".turn-assistant").getByText("Acknowledged: first fast reply", { exact: true })).toBeVisible();
    await expect(detail.locator(".turn-assistant").getByText("Acknowledged: second queued reply", { exact: true })).toBeVisible();
    await expect(detail.locator(".pending-turn")).toHaveCount(0);
    expect(readFileSync(received, "utf8").trim().split("\n")).toEqual(["first fast reply", "second queued reply"]);
    if (process.env.MC_E2E_EVIDENCE) {
      const evidence = artifactsDir("sdk-delivery");
      mkdirSync(evidence, { recursive: true });
      await dashboard.mouse.move(0, 0);
      await detail.screenshot({ path: `${evidence}fast-terminal-confirmed.png` });
    }
  } finally {
    spawnSync("tmux", ["kill-session", "-t", `=${name}`], { stdio: "ignore" });
  }
});
