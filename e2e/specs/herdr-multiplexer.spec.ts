import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";

import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { recordsIn } from "../fixtures/records.ts";
import { expect, test } from "../fixtures/test.ts";

const EVIDENCE = artifactsDir("herdr-multiplexer");
const TASK = "Exercise the Herdr multiplexer from Mission Control";

interface HerdrRequest {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

interface FleetSession {
  id: string;
  name: string;
  runtime: string;
  cwd: string | null;
  terminals: Array<{
    backend: string;
    kind: string;
    paneId: string;
  }>;
}

async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(TASK);
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

async function openDispatchedSession(page: Page): Promise<ReturnType<Page["locator"]>> {
  const row = page
    .getByRole("navigation", { name: "Sessions" })
    .locator("button.rail-row")
    .filter({ hasText: TASK });
  await expect(row).toBeVisible();
  await row.click();
  return page.locator(".console-detail");
}

function herdrRequests(daemon: DaemonHandle): HerdrRequest[] {
  try {
    return readFileSync(join(daemon.recordDir, "herdr-requests.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as HerdrRequest];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function weztermSpawns(daemon: DaemonHandle): string[][] {
  return recordsIn<{ argv?: unknown }>(daemon.recordDir, (file) => file.startsWith("wezterm-"))
    .map((record) => Array.isArray(record.argv)
      ? record.argv.filter((arg): arg is string => typeof arg === "string")
      : [])
    .filter((argv) => argv.includes("spawn"));
}

async function sessions(daemon: DaemonHandle): Promise<FleetSession[]> {
  return await (await fetch(`${daemon.baseURL}/api/sessions`)).json() as FleetSession[];
}

async function shoot(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: join(EVIDENCE, `${name}.png`), fullPage: true });
  console.log(`CAPTURED e2e/.artifacts/herdr-multiplexer/${name}.png`);
}

test.describe("compatible stable Herdr", () => {
  test.use({ daemonEnv: { MC_E2E_HERDR: "1", MISSION_POLL_MS: "100" } });

  test("launches, discovers, and focuses a default-server Herdr session", async ({
    dashboard,
    daemon,
  }) => {
    await dispatch(dashboard, daemon);
    const card = await openDispatchedSession(dashboard);
    const source = (await sessions(daemon)).find((session) => session.runtime === "sdk");
    expect(source?.cwd).toBeTruthy();

    await card.locator(".conv-launch").getByRole("button", { name: "Terminal", exact: true }).click();
    const menu = card.getByRole("menu", { name: "Open a shell in the worktree with" });
    await expect(menu).toBeVisible();

    const labels = await menu.locator(".launch-label").evaluateAll((elements) =>
      elements.map((element) =>
        [...element.childNodes]
          .find((node) => node.nodeType === Node.TEXT_NODE)
          ?.textContent?.trim() ?? ""),
    );
    expect(labels).toEqual(["tmux", "Herdr", "cmux", "WezTerm", "Ghostty", "iTerm2"]);

    const herdr = menu.getByRole("menuitem").filter({ hasText: "Herdr" });
    await expect(herdr).toBeEnabled();
    await expect(herdr.locator(".launch-note")).toHaveText(
      "Open a shell in Herdr. New session, raised in WezTerm.",
    );
    await shoot(dashboard, "herdr-launch-menu");
    await herdr.click();
    await expect(card.locator(".launch-flash")).toHaveText("Opened in Herdr");

    await expect
      .poll(() => herdrRequests(daemon).some((request) => request.method === "workspace.create"), {
        message: "the launch should create a workspace through the fake default Herdr server",
        timeout: 15_000,
      })
      .toBe(true);
    const create = herdrRequests(daemon).find((request) => request.method === "workspace.create")!;
    // Dispatch may author in a managed task worktree rather than the repository's source
    // checkout. The launcher must preserve the selected session's actual cwd either way.
    expect(create.params?.cwd).toBe(source!.cwd);
    expect(create.params?.focus).toBe(true);

    await expect
      .poll(() => herdrRequests(daemon).some((request) => request.method === "pane.send_input"), {
        message: "the launch should deliver its command through bracket-aware input",
      })
      .toBe(true);
    const delivery = herdrRequests(daemon).find((request) => request.method === "pane.send_input")!;
    // The paste carries NO keys. Herdr's `pane.send_input` can take the text and its Enter in
    // one call, and that is the bug this whole path was rewritten for: at the size a real
    // dispatch produces, the Enter lands inside the bracketed paste the shell is still
    // consuming and becomes a literal newline, so the command sits at the prompt and nothing
    // starts. The dispatcher then reported "agent session never appeared" thirty seconds
    // later. Only this layer can see the two writes arrive as two writes.
    expect(delivery?.params?.keys).toEqual([]);
    expect(String(delivery?.params?.text)).toContain("/bin/");
    // And it is SHORT - the environment and the agent argv ride in the wrapper script rather
    // than in what gets typed. A real dispatch used to deliver ~3,546 bytes here.
    expect(String(delivery?.params?.text).length).toBeLessThan(300);

    // The Enter is its own write, and it comes after the paste.
    const methods = herdrRequests(daemon).map((request) => request.method);
    await expect
      .poll(() => herdrRequests(daemon).some((request) => request.method === "pane.send_keys"), {
        message: "the Enter should be delivered as a separate key write",
        timeout: 15_000,
      })
      .toBe(true);
    const submit = herdrRequests(daemon).find((request) => request.method === "pane.send_keys")!;
    expect(submit?.params?.keys).toEqual(["enter"]);
    expect(methods.indexOf("pane.send_input")).toBeLessThan(
      herdrRequests(daemon).map((request) => request.method).indexOf("pane.send_keys"),
    );

    // And the launch is not reported as one until the pane is observed running something
    // other than its login shell. Before this, `ok` meant "the bytes were accepted".
    await expect
      .poll(() => herdrRequests(daemon).some((request) => request.method === "pane.process_info"), {
        message: "the launch should verify the agent actually started",
        timeout: 15_000,
      })
      .toBe(true);

    let terminalSession: FleetSession | null = null;
    await expect
      .poll(async () => {
        terminalSession = (await sessions(daemon)).find((session) =>
          session.runtime === "terminal" &&
          session.terminals.some((handle) =>
            handle.backend === "herdr" && handle.kind === "multiplexer")) ?? null;
        return terminalSession !== null;
      }, {
        message: "PID ancestry should adopt the fake agent under its Herdr pane",
        timeout: 30_000,
      })
      .toBe(true);

    const terminalRow = dashboard
      .getByRole("navigation", { name: "Sessions" })
      .locator("button.rail-row")
      .filter({ hasText: terminalSession!.name });
    await expect(terminalRow).toBeVisible();
    await terminalRow.click();
    const terminalCard = dashboard.locator(".console-detail");
    const focus = terminalCard.locator(".conv-launch").getByRole("button", { name: /Claude Code/ });
    await expect(focus).not.toHaveAttribute("aria-haspopup", "menu");

    const raisedAtLaunch = weztermSpawns(daemon).length;
    expect(raisedAtLaunch).toBe(1);
    await focus.click();
    await focus.click();
    await expect
      .poll(() => herdrRequests(daemon).filter((request) => request.method === "agent.focus").length, {
        message: "each focus click should select the Herdr agent internally",
      })
      .toBe(2);
    await expect
      .poll(() => weztermSpawns(daemon).length, {
        message: "each focus click should open the ordinary full Herdr client in WezTerm",
      })
      .toBe(raisedAtLaunch + 2);

    for (const argv of weztermSpawns(daemon)) {
      expect(argv).toContain(join(daemon.home, "fake-bin", "fake-herdr"));
      expect(argv).not.toContain("attach");
      expect(argv).not.toContain("--takeover");
    }
    await shoot(dashboard, "herdr-session-focused");
  });
});

test.describe("incompatible stable Herdr", () => {
  test.use({
    daemonEnv: {
      MC_E2E_HERDR: "1",
      MC_E2E_HERDR_MODE: "incompatible",
      MISSION_POLL_MS: "0",
    },
  });

  test("shows the actionable compatibility refusal without starting a server", async ({
    dashboard,
    daemon,
  }) => {
    await dispatch(dashboard, daemon);
    const card = await openDispatchedSession(dashboard);
    await card.locator(".conv-launch").getByRole("button", { name: "Terminal", exact: true }).click();
    const menu = card.getByRole("menu", { name: "Open a shell in the worktree with" });
    await menu.getByRole("menuitem").filter({ hasText: "Herdr" }).click();

    await expect(card.locator(".launch-flash.is-error")).toContainText(
      "requires Herdr 0.8.2 or newer on protocol 20",
    );
    expect(herdrRequests(daemon)).toEqual([]);
    await shoot(dashboard, "herdr-incompatible-refusal");
  });
});

/**
 * The launch Herdr accepts and never runs, which is the defect this whole path was rewritten
 * for and the only arm of it a person reads.
 *
 * `pane.send_input` answering `ok` means the bytes were accepted, not that the command ran -
 * and for every dispatch before this, it had not: the Enter was delivered inside the bracketed
 * paste the shell was still consuming, so the command sat at the prompt. The launch was
 * reported as a success, and the failure surfaced thirty seconds later as the dispatcher's own
 * timeout, blaming the agent for exiting. Two things have to be true now, and only this layer
 * can see both: the operator is told what actually happened, in a sentence they can act on,
 * and the workspace that was opened for the launch does not survive it.
 */
test.describe("a Herdr launch the shell never runs", () => {
  test.use({
    daemonEnv: { MC_E2E_HERDR: "1", MC_E2E_HERDR_MODE: "stuck", MISSION_POLL_MS: "0" },
  });

  test("says the shell never ran it, and takes its workspace back", async ({ dashboard, daemon }) => {
    await dispatch(dashboard, daemon);
    const card = await openDispatchedSession(dashboard);
    await card.locator(".conv-launch").getByRole("button", { name: "Terminal", exact: true }).click();
    const menu = card.getByRole("menu", { name: "Open a shell in the worktree with" });
    await menu.getByRole("menuitem").filter({ hasText: "Herdr" }).click();

    // Named for what happened, at the moment it happened - not "Opened in Herdr" now and a
    // timeout blaming the agent half a minute later.
    await expect(card.locator(".launch-flash.is-error")).toContainText("never ran it");

    // The command really was delivered and submitted; what did not happen is the shell
    // running it, which is what the pane's own process report says.
    const methods = herdrRequests(daemon).map((request) => request.method);
    expect(methods).toContain("pane.send_input");
    expect(methods).toContain("pane.send_keys");
    expect(methods).toContain("pane.process_info");

    // And every workspace opened for the launch is closed again. Stated as the invariant
    // rather than as a count, because a refused launch is retried under a unique name and
    // each attempt has its own workspace to take back. Left open, a failed dispatch leaks one
    // per attempt - which is how this machine came to be holding 42 of them.
    await expect
      .poll(() => {
        const requests = herdrRequests(daemon);
        const opened = requests.filter((request) => request.method === "workspace.create").length;
        const closed = requests.filter((request) => request.method === "workspace.close").length;
        return opened > 0 && closed === opened;
      }, {
        message: "every workspace a failed launch opened should be taken back",
        timeout: 15_000,
      })
      .toBe(true);
    await shoot(dashboard, "herdr-launch-never-ran");
  });
});

/**
 * Protocol 22, the generation stable Herdr 0.9.0 actually serves. The launch path reaches the
 * server through `probe`, and discovery reaches it again through `session.snapshot`, which
 * carries its own generation number and had its own equality check. Both are floors now, so
 * a newer Herdr opens a workspace and is adopted like any other.
 */
test.describe("stable Herdr on a newer protocol generation", () => {
  test.use({
    daemonEnv: { MC_E2E_HERDR: "1", MC_E2E_HERDR_MODE: "newer", MISSION_POLL_MS: "100" },
  });

  test("opens a workspace and adopts the discovered pane", async ({ dashboard, daemon }) => {
    await dispatch(dashboard, daemon);
    const card = await openDispatchedSession(dashboard);
    await card.locator(".conv-launch").getByRole("button", { name: "Terminal", exact: true }).click();
    const menu = card.getByRole("menu", { name: "Open a shell in the worktree with" });
    await menu.getByRole("menuitem").filter({ hasText: "Herdr" }).click();

    await expect(card.locator(".launch-flash")).toHaveText("Opened in Herdr");
    await expect(card.locator(".launch-flash.is-error")).toHaveCount(0);
    await expect
      .poll(() => herdrRequests(daemon).some((request) => request.method === "workspace.create"), {
        message: "a protocol 22 server should still be sent a workspace creation",
        timeout: 15_000,
      })
      .toBe(true);

    await expect
      .poll(async () => (await sessions(daemon)).some((session) =>
        session.runtime === "terminal" &&
        session.terminals.some((handle) =>
          handle.backend === "herdr" && handle.kind === "multiplexer")), {
        message: "the protocol 22 session snapshot should be read, not refused",
        timeout: 30_000,
      })
      .toBe(true);
    await shoot(dashboard, "herdr-newer-protocol-session");
  });
});
