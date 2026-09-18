import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as base, expect } from "../fixtures/test.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";

// Exercise the actual Kill dialog, route, discovery and tmux target resolver. The only
// agent is a harmless Node process. All tmux commands use this test's private socket.
class TmuxFixture {
  dir = mkdtempSync(join(tmpdir(), "mc-e2e-kill-"));
  socket = join(this.dir, "tmux.sock");
  name = `kill-${process.pid}-${Date.now()}`;
  constructor() {
    symlinkSync(process.execPath, join(this.dir, "claude"));
    writeFileSync(join(this.dir, "agent.mjs"), "setInterval(() => {}, 1000);\n");
    this.cmd("new-session", "-d", "-s", this.name, "-c", this.dir,
      `${join(this.dir, "claude")} ${join(this.dir, "agent.mjs")}`);
    this.cmd("new-session", "-d", "-s", `${this.name}-other`, "sleep 600");
  }
  cmd(...args: string[]) {
    return execFileSync("tmux", ["-S", this.socket, "-f", "/dev/null", ...args], { encoding: "utf8" }).trim();
  }
  names() { return this.cmd("list-sessions", "-F", "#{session_name}").split("\n").sort(); }
  cleanup() {
    spawnSync("tmux", ["-S", this.socket, "kill-server"], { stdio: "ignore" });
    rmSync(this.dir, { recursive: true, force: true });
  }
}

const test = base.extend<{ terminal: TmuxFixture }>({
  // Playwright requires fixture dependencies to use an object pattern.
  // oxlint-disable-next-line no-empty-pattern
  terminal: async ({}, use) => {
    const fixture = new TmuxFixture();
    try { await use(fixture); } finally { fixture.cleanup(); }
  },
  daemonEnv: async ({ terminal }, use) => {
    await use({
      MISSION_POLL_MS: "400",
      TMUX: `${terminal.socket},${terminal.cmd("display-message", "-p", "#{pid}")},0`,
    });
  },
});

test.describe("Kill in tmux", () => {
  test.skip(spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0, "tmux is not installed");

  for (const shared of [true, false]) {
    test(shared ? "preserves other panes and sessions" : "closes a sole-pane session without killing its name prefix", async ({ dashboard, terminal }) => {
      const sibling = shared
        ? terminal.cmd("split-window", "-d", "-P", "-F", "#{pane_id}", "-t", `=${terminal.name}:`, "sleep 600")
        : null;
      const row = dashboard.getByRole("navigation", { name: "Sessions" })
        .locator("button.rail-row").filter({ hasText: terminal.name });
      await expect(row).toHaveCount(1, { timeout: 20_000 });
      await row.click();
      const detail = dashboard.locator(".console-detail");
      await expect(detail).toContainText(/tmux · %\d+/);
      await detail.getByRole("button", { name: "kill", exact: true }).click();
      const dialog = dashboard.getByRole("dialog", { name: "Kill session" });
      await expectContentClearsBorder(dialog);
      await expect(dialog).toContainText("closes its terminal session only if this is its sole pane and that can be verified");
      await expect(dialog).toContainText("Other panes and windows are preserved");
      const explanation = await dialog.innerText();
      if (process.env.MC_E2E_EVIDENCE && shared) {
        const evidenceDir = "e2e/.artifacts/session-kill-tmux";
        mkdirSync(evidenceDir, { recursive: true });
        await dialog.getByRole("heading", { name: "Kill session", exact: true }).click();
        await expect(dashboard.locator(".tooltip")).toHaveCount(0);
        await dialog.screenshot({ path: `${evidenceDir}/kill-confirmation.png`, animations: "disabled" });
      }
      await dialog.getByRole("button", { name: "Kill", exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(row).toHaveCount(0, { timeout: 20_000 });
      const remainingSessions = terminal.names();
      expect(remainingSessions).toEqual(shared
        ? [terminal.name, `${terminal.name}-other`].sort()
        : [`${terminal.name}-other`]);
      if (sibling) expect(terminal.cmd("display-message", "-p", "-t", sibling, "#{pane_id}")).toBe(sibling);
      if (process.env.MC_E2E_EVIDENCE) {
        console.log("TMUX_KILL_EVIDENCE", JSON.stringify({
          scenario: shared ? "shared pane" : "sole pane",
          selectedSession: terminal.name,
          dialogText: explanation,
          remainingSessions,
          siblingPane: sibling,
          agentCardRemoved: true,
        }));
      }
    });
  }
});
