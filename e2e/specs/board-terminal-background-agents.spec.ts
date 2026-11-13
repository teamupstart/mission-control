import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";

import type { Locator } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * A TERMINAL Claude session's background sub-agents, read from its hooks, hang beneath its card.
 *
 * `board-background-agents.spec.ts` proves the Agent SDK half, where the driver reads task
 * frames. A terminal session has no driver: everything the daemon knows about its sub-agents
 * arrives through the hook bridge - `SubagentStart`, the Agent tool's `PostToolUse` with
 * `async_launched`, `SubagentStop`, and the in-flight `background_tasks` list on `Stop`. This
 * spec posts exactly what `hooks/harness-hook.mjs` sends for those events, bound to a real tmux
 * pane the daemon discovered, and reads the board.
 *
 * What a hook cannot say is part of the claim: no token count, tool count or last tool, so each
 * row shows type, description, state and elapsed time and never a placeholder number.
 *
 * The Claude case also opens the session's conversation and finds the same agent in the
 * Background agents tray, which reads the same `Session.subagents` summary as the board.
 *
 * Discovery is on for this file's daemon only, and the spec addresses its own card by the tmux
 * session name it generated, for the reason `session-interrupt-terminal.spec.ts` gives.
 */

test.use({ daemonEnv: { MISSION_POLL_MS: "400" } });

const EVIDENCE = artifactsDir("board-terminal-background-agents");
const DISCOVERY_TIMEOUT = 20_000;

const tmuxMissing = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0;

interface Pane {
  agent: "claude" | "codex";
  session: string;
  /** The pane's working directory, resolved the way discovery reads a process's cwd. */
  cwd: string;
  cleanup(): void;
}

/**
 * A real tmux pane running something the daemon discovers as `agent`, idling forever. argv0's
 * basename is what discovery matches against each harness's `detect.commands`.
 */
function startPane(agent: Pane["agent"] = "claude"): Pane {
  const dir = mkdtempSync(join(tmpdir(), "mc-e2e-subagents-pane-"));
  const bin = join(dir, "fake-bin");
  mkdirSync(bin);
  symlinkSync(execPath, join(bin, agent));
  const script = join(dir, "agent.mjs");
  writeFileSync(script, "setInterval(() => {}, 1 << 30);\n");
  const session = `mc-e2e-${agent}-subagents-${process.pid}-${Date.now()}`;
  execFileSync("tmux", [
    "new-session", "-d", "-s", session, "-x", "120", "-y", "40", "-c", dir, `${join(bin, agent)} ${script}`,
  ]);
  return {
    agent,
    session,
    cwd: realpathSync(dir),
    cleanup: () => {
      spawnSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * POST one hook from the pane's harness, shaped as its bridge shapes it, bound to `pane`.
 *
 * Bound by the pane's own working directory, which is unique to this test, rather than by
 * `TMUX_PANE`. Pane ids are unique only within one tmux server's life: when a parallel test's
 * `kill-session` leaves the default server empty it exits, the next server hands out `%0` again,
 * and this daemon (discovery is machine-wide) can still hold the other test's lingering card
 * for the old `%0` - which a pane-keyed hook would bind to first. The registry's unique-cwd
 * route is the one Herdr and other keyless terminals use, so the binding is still real.
 */
async function hook(daemon: DaemonHandle, pane: Pane, event: string, extra: Record<string, unknown> = {}): Promise<void> {
  const res = await fetch(`${daemon.baseURL}/hooks/${event}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-harness-token": readFileSync(join(daemon.home, "token"), "utf8").trim(),
    },
    body: JSON.stringify({
      agent: pane.agent, event, sessionId: `native-${pane.session}`, cwd: pane.cwd, transcriptPath: null,
      ts: Date.now(), env: {}, ...extra,
    }),
  });
  expect(res.status, `${event} was accepted`).toBe(204);
}

/** What the bridge sends for a backgrounded Agent call. */
function launch(id: string, type: string, description: string): Record<string, unknown> {
  return {
    toolName: "Agent",
    agentTool: { agentId: id, status: "async_launched", subagentType: type, description },
  };
}

function inFlight(...agents: [string, string, string][]): Record<string, unknown> {
  return {
    backgroundTasks: [
      ...agents.map(([id, agentType, description]) => ({ id, type: "subagent", description, agentType })),
      // A background shell is in flight too, and is not an agent.
      { id: "shell-1", type: "shell", description: "npm run watch" },
    ],
  };
}

async function shoot(target: Locator, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await target.page().mouse.move(0, 0);
  await target.screenshot({ path: join(EVIDENCE, `${name}.png`) });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/board-terminal-background-agents/${name}.png`);
}

test.describe("terminal-session background sub-agents", () => {
  test.skip(tmuxMissing, "tmux is not installed on this machine");

  let pane: Pane | undefined;
  test.afterEach(() => {
    pane?.cleanup();
    pane = undefined;
  });

  test("hook-reported agents hang beneath the terminal card as type, state and elapsed rows", async ({
    dashboard,
    daemon,
  }) => {
    pane = startPane();
    const layout = await fetch(`${daemon.baseURL}/api/ui/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ layout: "board" }),
    });
    expect(layout.ok).toBe(true);
    await dashboard.reload();
    await expect(dashboard.locator("main.board")).toBeVisible();

    const tile = dashboard.locator("main.board .tile").filter({ hasText: pane.session });
    await expect(tile).toHaveCount(1, { timeout: DISCOVERY_TIMEOUT });
    // No agents yet: the card is exactly what a terminal card always was.
    await expect(dashboard.getByRole("group", { name: /^Background sub-agents of / })).toHaveCount(0);

    // A turn that launches two background agents and ends with both still running.
    await hook(daemon, pane, "UserPromptSubmit", { prompt: "move the ledger to cursor pagination" });
    await hook(daemon, pane, "SubagentStart", { agentId: "agent-map", agentType: "Explore" });
    await hook(daemon, pane, "PostToolUse", launch("agent-map", "Explore", "Map offset call sites"));
    await hook(daemon, pane, "SubagentStart", { agentId: "agent-billing", agentType: "general-purpose" });
    await hook(daemon, pane, "PostToolUse", launch("agent-billing", "general-purpose", "Convert billing queries"));
    // A foreground agent starts and ends inside the turn; it blocked the parent and never counts.
    await hook(daemon, pane, "SubagentStart", { agentId: "agent-plan", agentType: "Plan" });
    await hook(daemon, pane, "SubagentStop", { agentId: "agent-plan", agentType: "Plan" });
    await hook(daemon, pane, "Stop", inFlight(
      ["agent-map", "Explore", "Map offset call sites"],
      ["agent-billing", "general-purpose", "Convert billing queries"],
    ));

    const idleTile = dashboard.locator("main.board section.board-col.tone-idle .tile").filter({ hasText: pane.session });
    await expect(idleTile).toHaveCount(1);
    await expect(idleTile.locator(".tile-activity")).toHaveText(/idle · 2 agents still running/);

    const tree = dashboard.getByRole("group", { name: /^Background sub-agents of / });
    await expect(tree).toHaveCount(1);
    expect(
      await tree.evaluate((el) => el.previousElementSibling?.textContent ?? ""),
      "the tree hangs beneath its own card",
    ).toContain(pane.session);
    await expect(tree.getByRole("button", { name: "2 sub-agents · 2 running" })).toBeVisible();
    const rows = tree.getByRole("listitem");
    await expect(rows).toHaveCount(2);
    const mapRow = rows.filter({ hasText: "Map offset call sites" });
    await expect(mapRow).toContainText("Explore");
    // Degraded: the elapsed time and nothing a hook does not report - no tools, no last tool.
    await expect(mapRow.locator(".st-detail")).toHaveText(/^\d+s$|^\d+m \d+s$/);
    await expect(tree).not.toContainText("tools");
    // The foreground agent and the shell were on the wire and are nowhere on the board.
    await expect(dashboard.locator("main.board")).not.toContainText("agent-plan");
    await expect(dashboard.locator("main.board")).not.toContainText("npm run watch");
    await shoot(dashboard.locator("main.board section.board-col.tone-idle"), "01-terminal-sub-cards");

    // One agent finishes. Its own stop never re-arms the idle parent, and its row stays, done.
    await hook(daemon, pane, "SubagentStop", {
      agentId: "agent-billing", agentType: "general-purpose",
      ...inFlight(["agent-map", "Explore", "Map offset call sites"], ["agent-billing", "general-purpose", "Convert billing queries"]),
    });
    await expect(tree.getByRole("button", { name: "2 sub-agents · 1 running" })).toBeVisible();
    const billingRow = rows.filter({ hasText: "Convert billing queries" });
    await expect(billingRow).toHaveClass(/is-completed/);
    await expect(billingRow).toContainText("done");
    await expect(idleTile.locator(".tile-activity")).toHaveText(/idle · 1 agent still running/);

    // The operator's next prompt folds the finished agent into a count.
    await hook(daemon, pane, "UserPromptSubmit", { prompt: "carry on" });
    await expect(tree.getByRole("button", { name: "1 sub-agent · 1 running" })).toBeVisible();
    await expect(tree.getByText("1 finished")).toBeVisible();
    await expect(rows.filter({ hasText: "Convert billing queries" })).toHaveCount(0);
    await shoot(tree, "02-terminal-finished-folded");

    // The conversation reads the same summary: opening the terminal session docks the Background
    // agents tray above its reply box, listing the hook-reported agent with no counters. The prompt
    // above moved the card to the working column, so it is opened wherever it now sits.
    await tile.click();
    const tray = dashboard.getByRole("region", { name: "Background agents" });
    await expect(tray).toBeVisible();
    await expect(tray.getByRole("button", { name: "Background agents · 1 running" })).toBeVisible();
    const trayRow = tray.getByRole("listitem").filter({ hasText: "Map offset call sites" });
    await expect(trayRow).toContainText("Explore");
    await expect(tray).not.toContainText("tools");
    await expect(tray).toContainText("1 finished");
    await shoot(tray, "04-terminal-conversation-tray");
  });

  test("a Codex terminal session's children hang beneath its card, from SubagentStart to SubagentStop", async ({
    dashboard,
    daemon,
  }) => {
    pane = startPane("codex");
    const layout = await fetch(`${daemon.baseURL}/api/ui/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ layout: "board" }),
    });
    expect(layout.ok).toBe(true);
    await dashboard.reload();
    await expect(dashboard.locator("main.board")).toBeVisible();

    const tile = dashboard.locator("main.board .tile").filter({ hasText: pane.session });
    await expect(tile).toHaveCount(1, { timeout: DISCOVERY_TIMEOUT });
    await expect(dashboard.getByRole("group", { name: /^Background sub-agents of / })).toHaveCount(0);

    // What `hooks/codex-hook.mjs` sends: the child's id and type, on its own lifecycle events only.
    // Codex gives no launch description, so a row is type, state and elapsed.
    await hook(daemon, pane, "UserPromptSubmit", { prompt: "split the migration across workers" });
    await hook(daemon, pane, "SubagentStart", { agentId: "thread-schema", agentType: "worker" });
    await hook(daemon, pane, "SubagentStart", { agentId: "thread-backfill", agentType: "explorer" });
    await hook(daemon, pane, "Stop");

    const idleTile = dashboard.locator("main.board section.board-col.tone-idle .tile").filter({ hasText: pane.session });
    await expect(idleTile).toHaveCount(1);
    await expect(idleTile.locator(".tile-activity")).toHaveText(/idle · 2 agents still running/);

    const tree = dashboard.getByRole("group", { name: /^Background sub-agents of / });
    await expect(tree).toHaveCount(1);
    expect(
      await tree.evaluate((el) => el.previousElementSibling?.textContent ?? ""),
      "the tree hangs beneath the Codex card",
    ).toContain(pane.session);
    await expect(tree.getByRole("button", { name: "2 sub-agents · 2 running" })).toBeVisible();
    const rows = tree.getByRole("listitem");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0).locator(".st-type")).toHaveText("worker");
    await expect(rows.nth(1).locator(".st-type")).toHaveText("explorer");
    await expect(rows.nth(0).locator(".st-detail")).toHaveText(/^\d+s$|^\d+m \d+s$/);
    await expect(tree).not.toContainText("tools");

    // One child stops. The parent stays idle, and the row stays, done, until the next prompt.
    await hook(daemon, pane, "SubagentStop", { agentId: "thread-schema", agentType: "worker" });
    await expect(tree.getByRole("button", { name: "2 sub-agents · 1 running" })).toBeVisible();
    const done = rows.filter({ has: dashboard.locator(".st-type", { hasText: "worker" }) });
    await expect(done).toHaveClass(/is-completed/);
    await expect(done).toContainText("done");
    await expect(idleTile.locator(".tile-activity")).toHaveText(/idle · 1 agent still running/);
    await shoot(dashboard.locator("main.board section.board-col.tone-idle"), "03-codex-terminal-sub-cards");
  });
});
