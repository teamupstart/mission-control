import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "../../src/shared/types.ts";
import { test, expect } from "../fixtures/test.ts";

test.use({ daemonEnv: {
  MC_E2E_TERMINAL_BOUNDARY: "1", MC_E2E_WEZTERM_BOUNDARY: "1", MISSION_POLL_MS: "100",
} });

test("a stale WezTerm action reports refusal and fresh discovery restores delivery", async ({ dashboard, daemon }) => {
  const directory = mkdtempSync(join(tmpdir(), "mc-wz-"));
  const socket = join(directory, "sock");
  let server: Server;
  let received: string[] = [];
  async function start() {
    received = [];
    server = createServer((client) => client.once("data", (data) => {
      const { args, input } = JSON.parse(data.toString());
      if (args.includes("send-text")) received.push(input);
      client.end(args.includes("list") ? JSON.stringify([
        { pane_id: 1, tab_id: 1, window_id: 1, tty_name: "/dev/ttysfixture", tab_title: "WezTerm owner", cwd: daemon.repo },
      ]) : args.includes("get-text") ? "❯ " : "");
    }));
    await new Promise<void>((resolve) => server.listen(socket, resolve));
  }
  const stop = () => new Promise<void>((resolve) => server.close(() => resolve()));
  await start();
  try {
    const state = { cwd: daemon.repo, requestedTitle: "", tabTitle: "", argv: [], startedAt: Date.now(), socket, freezeDiscovery: false };
    const save = () => writeFileSync(join(daemon.home, "terminal-boundary.json"), JSON.stringify(state));
    save();
    const session = async (): Promise<Session | undefined> =>
      ((await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as Session[]).find((s) => s.pid === 900002);
    await expect.poll(async () => (await session())?.terminals[0]?.incarnation).toBeTruthy();
    const original = (await session())!;
    await dashboard.goto(`${daemon.baseURL}/#/fleet`);
    await dashboard.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row", { hasText: "WezTerm owner" }).click();
    const working = async () => {
      const response = await fetch(`${daemon.baseURL}/hooks/UserPromptSubmit`, {
        method: "POST", headers: { "content-type": "application/json", "x-harness-token": readFileSync(join(daemon.home, "token"), "utf8").trim() },
        body: JSON.stringify({ agent: "claude", cwd: daemon.repo, env: { weztermPane: "1" }, prompt: "fixture work" }),
      });
      expect(response.ok, await response.text()).toBe(true);
      await expect(dashboard.getByRole("button", { name: /^interrupt\b/ })).toBeEnabled();
    };
    await working();
    state.freezeDiscovery = true; save();
    // Allow any already-started observation to settle before replacing the socket.
    await expect.poll(async () => (await session())?.terminals[0]?.incarnation).toBe(original.terminals[0]!.incarnation);
    await stop(); await start();
    const failed = dashboard.waitForResponse((r) => r.url().endsWith("/interrupt") && r.request().method() === "POST");
    await dashboard.getByRole("button", { name: /^interrupt\b/ }).click();
    expect((await failed).ok()).toBe(false);
    await expect(dashboard.getByText("WezTerm pane identity is stale or unavailable; wait for fresh discovery", { exact: true })).toBeVisible();
    expect(received).toEqual([]);
    if (process.env.MC_E2E_EVIDENCE) {
      mkdirSync("e2e/.artifacts/wezterm-incarnation", { recursive: true });
      await dashboard.screenshot({ path: "e2e/.artifacts/wezterm-incarnation/stale-refusal.png" });
    }
    state.freezeDiscovery = false; save();
    await expect.poll(async () => (await session())?.terminals[0]?.incarnation).not.toBe(original.terminals[0]!.incarnation);
    await working();
    const delivered = dashboard.waitForResponse((r) => r.url().endsWith("/interrupt") && r.request().method() === "POST");
    await dashboard.getByRole("button", { name: /^interrupt\b/ }).click();
    expect((await delivered).ok()).toBe(true);
    await expect.poll(() => received).toContain("\x1b");
  } finally {
    await stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
