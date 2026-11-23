import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page, Request } from "@playwright/test";
import { expect, test } from "../fixtures/test.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { INBOX_MESSAGES } from "../../src/shared/inbox.ts";
import type { Stall, StallFacts } from "../../src/shared/stall.ts";
import type { Session, Task } from "../../src/shared/types.ts";

/**
 * What is at stake: every parked-run fix on a Stalled card (`idle-stalled`) does what it says when
 * it is clicked. `stalled-tile-facts.test.ts` proves which controls a card draws; this proves each
 * one's handler sends the request it should and that its effect lands. Tell it to push and
 * Continue put their fixed words in the agent's conversation, Resubmit asks for the run the card
 * names and reports the answer, Open run opens that run, and a failed action shows its error on
 * the card and gives the controls back.
 *
 * `idle-stalled.spec.ts` proves the real detector feeds the section, waiting out its one-minute
 * floor. Here the browser's copy of `/api/away/stalls` is SERVED, as `inbox-stuck-actions.spec.ts`
 * serves it for the Stuck row, so each parked-run case can be put in front of one real, live
 * session in turn. Push and Continue go to the real daemon and the real fake agent. Resubmit's
 * replies are scripted: there is no parked run behind a served stall, so what this proves for it
 * is the request the card sends and what it does with each answer.
 */

const EVIDENCE = artifactsDir("idle-stalled-actions");

async function capture(target: Locator, name: string, page: Page): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await expect(page.locator(".tooltip")).toHaveCount(0, { timeout: 3000 }).catch(() => undefined);
  await target.screenshot({ path: join(EVIDENCE, `${name}.png`) });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/idle-stalled-actions/${name}.png`);
}

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

async function sessionState(daemon: DaemonHandle, id: string): Promise<string | undefined> {
  return (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.id === id)?.state;
}

/** Whether the agent's served transcript holds a user turn containing `text`. */
async function heard(daemon: DaemonHandle, id: string, text: string): Promise<boolean> {
  const served = await api<{ messages: Array<{ role: string; text: string }> }>(
    daemon, `/api/sessions/${encodeURIComponent(id)}/transcript`);
  return served.messages.some((m) => m.role === "user" && m.text.includes(text));
}

function parked(sessionId: string, facts: Partial<Extract<StallFacts, { kind: "workflow-parked" }>>, fingerprint: string): Stall {
  return {
    sessionId, kind: "workflow-parked", forMs: 21 * 60_000, reason: "idle 21m - No-Mistakes Review is parked",
    facts: {
      kind: "workflow-parked", runId: "run-e2e", workflowName: "No-Mistakes Review", status: "waiting_for_session",
      round: 2, resubmittable: false, externalSource: null, unpushedCommits: 0, ...facts,
    },
    fingerprint,
  };
}

test("each parked-run fix on a Stalled card sends its request and lands its effect, and a failure shows on the card", async ({ dashboard: page, daemon }) => {
  test.setTimeout(240_000);
  const flags = await api<{ config: { overrides: Record<string, boolean> } }>(
    daemon, "/api/feature-flags", { kind: "flag", id: "idle-stalled", enabled: true }, "PUT");
  expect(flags.config.overrides["idle-stalled"]).toBe(true);
  const task = await api<Task>(daemon, "/api/tasks", {
    repoRoot: daemon.repo, title: "Fix the parser", intent: "fix the parser", kind: "ship", agent: "claude", runtime: "sdk", workflowId: null,
  });
  let session!: Session;
  await expect.poll(async () => {
    session = (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.task?.id === task.id)!;
    return session?.agentSessionId ? session.state : null;
  }, { timeout: 60_000 }).toBe("idle");
  const id = session.id;

  // The stall list the dashboard polls every five seconds, served from here.
  let served: Stall[] = [];
  await page.route("**/api/away/stalls", (route) => route.fulfill({ json: served }));
  const posts: Array<{ path: string; body: unknown }> = [];
  page.on("request", (request: Request) => {
    if (request.method() !== "POST") return;
    const path = decodeURIComponent(new URL(request.url()).pathname);
    if (path.startsWith("/api/sessions/") || path.startsWith("/api/workflow-runs/")) {
      posts.push({ path, body: request.postDataJSON() });
    }
  });
  const sent = (suffix: string) => posts.filter((p) => p.path.endsWith(suffix));

  // The Board, where a Stalled card carries its facts and fixes. The fixture pins Console.
  const { config } = await api<{ config?: { layout?: string } }>(daemon, "/api/ui/config", { layout: "board" }, "PUT");
  expect(config?.layout).toBe("board");
  await page.reload();
  await expect(page.locator("main.board")).toBeVisible();
  const card = () => page.getByRole("group", { name: `Why ${session.name} stalled` });

  // A previous client persisted the hash of the kind and exact reason for a legacy daemon.
  served = [{ sessionId: id, kind: "workflow-parked", forMs: 60_000,
    reason: "Previous review", workflowRunId: "previous-run" }];
  await expect(card()).toContainText("Previous review", { timeout: 15_000 });
  await api(daemon, "/api/attention/dismissals", {
    items: [{ itemId: `stuck:${id}`, occurrence: "f782ee25", basis: 0 }],
  });
  await expect(card()).toHaveCount(0);

  // Mixed-version daemon: keep the reported reason and run link without assuming a parked step.
  served = [{ sessionId: id, kind: "workflow-parked", forMs: 60_000,
    reason: "Waiting on the review", workflowRunId: "legacy-run" }];
  await expect(card()).toContainText("Waiting on the review", { timeout: 15_000 });
  await expect(card().getByRole("button", { name: "Message…" })).toBeVisible();
  await expect(card().getByRole("button", { name: "Open run" })).toBeVisible();

  await card().getByRole("button", { name: `Dismiss ${session.name} from Stalled` }).click();
  await expect(card()).toHaveCount(0);
  served = [{ ...served[0]!, reason: "Waiting on the review for 2m", forMs: 120_000 }];
  await Promise.all([
    page.waitForResponse(response => response.url().endsWith("/api/away/stalls")),
    page.reload(),
  ]);
  await expect(page.getByRole("button", { name: `Open ${session.name}`, exact: true })).toBeAttached();
  await expect(card()).toHaveCount(0);
  served = [{ ...served[0]!, workflowRunId: "another-run", reason: "Another review" }];
  await expect(card()).toContainText("Another review", { timeout: 15_000 });

  served = [parked(id, { status: "waiting_for_new_head" }, "parked-no-unpushed")];
  await expect(card()).toContainText("a new commit pushed to this branch", { timeout: 15_000 });
  await expect(card().getByRole("button", { name: "Continue" })).toHaveCount(0);
  await expect(card().getByRole("button", { name: "Tell it to push" })).toHaveCount(0);
  await expect(card().getByRole("button", { name: "Open run" })).toBeEnabled();

  await card().getByRole("button", { name: "Message…" }).click();
  await expect(page.getByRole("textbox", { name: /Reply to this session/ })).toBeFocused();
  await page.getByRole("button", { name: "Back to the board" }).click();

  // 1. A run waiting for a pushed head, with unpushed commits: Tell it to push. The fixed words
  //    reach the agent through the real outbox.
  served = [parked(id, { status: "waiting_for_new_head", unpushedCommits: 2 }, "parked-head")];
  await expect(card()).toContainText("No-Mistakes Review round 2 needs a pushed head", { timeout: 15_000 });
  await expect(card()).toContainText("2 commits not pushed");
  await expect(card().getByRole("button", { name: "Resubmit" })).toHaveCount(0);
  await capture(card(), "01-parked-push", page);
  await card().getByRole("button", { name: "Tell it to push", exact: true }).click();
  await expect.poll(() => sent(`/sessions/${id}/inbox-message`).at(-1)?.body).toEqual({ kind: "push" });
  await expect.poll(() => heard(daemon, id, INBOX_MESSAGES.push), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => sessionState(daemon, id), { timeout: 30_000 }).toBe("idle");

  // 2. A round that reopens on the session's own next turn: Continue.
  served = [parked(id, {}, "parked-next-turn")];
  await expect(card()).toContainText("the session's next turn, which reopens No-Mistakes Review round 2.", { timeout: 15_000 });
  await expect(card().getByRole("button", { name: "Tell it to push" })).toHaveCount(0);
  await expect(card().getByRole("button", { name: "Resubmit" })).toHaveCount(0);
  await card().getByRole("button", { name: "Continue", exact: true }).click();
  await expect.poll(() => sent(`/sessions/${id}/inbox-message`).at(-1)?.body).toEqual({ kind: "continue" });
  await expect.poll(() => heard(daemon, id, INBOX_MESSAGES.continue), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => sessionState(daemon, id), { timeout: 30_000 }).toBe("idle");

  // 3. A resubmittable run: Resubmit asks for the run the card names. Its first answer is a
  //    refusal, shown on the card with the controls given back; the retry succeeds and clears it.
  let resubmits = 0;
  await page.route("**/api/workflow-runs/*/resubmit", async (route) => {
    resubmits += 1;
    return resubmits === 1
      ? route.fulfill({ status: 409, json: { error: "The run left waiting_for_session before the resubmission" } })
      : route.fulfill({ status: 200, json: { idempotent: false } });
  });
  served = [parked(id, { resubmittable: true }, "parked-resubmit")];
  await expect(card()).toContainText("a resubmission to reopen No-Mistakes Review round 2.", { timeout: 15_000 });
  const resubmit = card().getByRole("button", { name: "Resubmit", exact: true });
  await resubmit.click();
  await expect(card().getByRole("alert")).toHaveText("The run left waiting_for_session before the resubmission");
  await expect(card().getByRole("status")).toHaveCount(0);
  await expect(resubmit).toBeEnabled();
  await expect(card().getByRole("button", { name: "Open run", exact: true })).toBeEnabled();
  await capture(card(), "02-resubmit-refused", page);
  expect(sent("/workflow-runs/run-e2e/resubmit")).toHaveLength(1);
  await resubmit.click();
  await expect(card().getByRole("status")).toHaveText("Resubmitted the run.");
  await expect(card().getByRole("alert")).toHaveCount(0);
  expect(sent("/workflow-runs/run-e2e/resubmit")).toHaveLength(2);

  // 4. Open run opens the run the card names on the Runs page.
  await card().getByRole("button", { name: "Open run", exact: true }).click();
  await expect.poll(() => new URL(page.url()).hash).toBe("#/runs/run-e2e");
});

test("Mark done on a Stalled card completes the card's task through the daemon", async ({ dashboard: page, daemon }) => {
  test.setTimeout(180_000);
  const flags = await api<{ config: { overrides: Record<string, boolean> } }>(
    daemon, "/api/feature-flags", { kind: "flag", id: "idle-stalled", enabled: true }, "PUT");
  expect(flags.config.overrides["idle-stalled"]).toBe(true);
  const task = await api<Task>(daemon, "/api/tasks", {
    repoRoot: daemon.repo, title: "Tidy the changelog", intent: "tidy the changelog", kind: "ship", agent: "claude", runtime: "sdk", workflowId: null,
  });
  let session!: Session;
  await expect.poll(async () => {
    session = (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.task?.id === task.id)!;
    return session?.agentSessionId ? session.state : null;
  }, { timeout: 60_000 }).toBe("idle");

  // The poll still names a previous assignment until it catches up with the live session.
  let observedTask = { id: "previous-task", title: "Previous assignment" };
  await page.route("**/api/away/stalls", (route) => route.fulfill({ json: [{
    sessionId: session.id, kind: "unfinished-work", forMs: 21 * 60_000, reason: "idle 21m with work unfinished",
    facts: { kind: "unfinished-work", task: observedTask, queueOpen: 0 }, fingerprint: observedTask.id,
  } satisfies Stall] }));
  const completions: unknown[] = [];
  page.on("request", (request: Request) => {
    if (request.method() === "POST" && decodeURIComponent(new URL(request.url()).pathname) === `/api/tasks/${task.id}/complete`) {
      completions.push(request.postDataJSON());
    }
  });

  const { config } = await api<{ config?: { layout?: string } }>(daemon, "/api/ui/config", { layout: "board" }, "PUT");
  expect(config?.layout).toBe("board");
  await Promise.all([
    page.waitForResponse(response => response.url().endsWith("/api/away/stalls")),
    page.reload(),
  ]);
  await expect(page.locator("main.board")).toBeVisible();
  const card = page.getByRole("group", { name: `Why ${session.name} stalled` });
  await expect(page.getByRole("button", { name: `Open ${session.name}`, exact: true })).toBeVisible();
  await expect(card).toHaveCount(0);
  observedTask = { id: task.id, title: task.title };
  await expect(card).toContainText("Tidy the changelog", { timeout: 15_000 });
  expect((await api<Task[]>(daemon, "/api/tasks")).find((t) => t.id === task.id)?.status).not.toBe("done");

  const message = card.getByRole("button", { name: "Message…" });
  await expect(message).toHaveAccessibleDescription("Open the session and focus its message box");
  await message.click();
  await expect(page.getByRole("textbox", { name: /Reply to this session/ })).toBeFocused();
  await page.getByRole("button", { name: "Back to the board" }).click();
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.getByRole("button", { name: "Mark done", exact: true }).click();
  // The card asked to complete exactly its own task, and the daemon completed it.
  await expect.poll(() => completions).toEqual([expect.objectContaining({ outcome: "Marked done from the Stalled section" })]);
  await expect.poll(async () => (await api<Task[]>(daemon, "/api/tasks")).find((t) => t.id === task.id)?.status,
    { timeout: 15_000 }).toBe("done");
  // Completing a worktree task closes its session, so the card leaves the board.
  await expect(card).toHaveCount(0, { timeout: 30_000 });
});

test("in the Console layout the stalled rail row's detail carries the facts, the fixes and Dismiss", async ({ dashboard: page, daemon }) => {
  // Use the approved B viewport to compare the rail summary and the full selected-session sheet.
  await page.setViewportSize({ width: 1500, height: 1000 });
  test.setTimeout(180_000);
  for (const id of ["inbox", "idle-stalled"]) {
    const flags = await api<{ config: { overrides: Record<string, boolean> } }>(
      daemon, "/api/feature-flags", { kind: "flag", id, enabled: true }, "PUT");
    expect(flags.config.overrides[id]).toBe(true);
  }
  const task = await api<Task>(daemon, "/api/tasks", {
    repoRoot: daemon.repo, title: "Fix login redirect loop", intent: "Fix login redirect loop", kind: "ship", agent: "claude", runtime: "sdk", workflowId: null,
  });
  let session!: Session;
  await expect.poll(async () => {
    session = (await api<Session[]>(daemon, "/api/sessions")).find((s) => s.task?.id === task.id)!;
    return session?.agentSessionId ? session.state : null;
  }, { timeout: 60_000 }).toBe("idle");
  const name = "amber-lynx";
  const brief = "Ended its turn asking in prose whether to update the auth snapshot.";
  const sessionPath = `/api/sessions/${encodeURIComponent(session.id)}`;
  await api(daemon, `${sessionPath}/rename`, { name });
  await api(daemon, `${sessionPath}/note`, { brief, disposition: "skipped" }, "PUT");
  const activityStart = async () => {
    const current = (await api<Session[]>(daemon, "/api/sessions")).find(s => s.id === session.id)!;
    return current.lastActivity ?? current.firstSeen;
  };
  let since = await activityStart();
  const facts: StallFacts = { kind: "unfinished-work", task: { id: task.id, title: task.title }, queueOpen: 0 };
  await page.route("**/api/away/stalls", (route) => route.fulfill({ json: [{
    sessionId: session.id, kind: "unfinished-work", forMs: 21 * 60_000, reason: "idle 21m with work unfinished",
    facts, since, fingerprint: `console-open-task-${since}`,
  } satisfies Stall] }));
  await expect(page.locator("main.board")).toHaveCount(0);

  // The rail draws the Stalled rule and the row's mark, and the inbox owes nothing.
  const row = page.getByRole("button", { name, exact: true }).and(page.locator(".rail-row"));
  await expect(row.locator(".rail-stalled")).toHaveText("stalled", { timeout: 15_000 });
  await expect(page.locator(".fleet-section-stalled")).toBeVisible();
  await expect(page.locator("button.pulse-seg", { hasText: "to answer" })).toHaveCount(0);

  // Selecting it opens the detail with the Stalled band: the facts and the fixes.
  await expect(row.locator(".rail-sub")).toHaveText(`Task: ${task.title}`);
  await expect(row).not.toContainText(brief);
  await capture(page.locator(".rail-group.tone-idle").locator(".."), "04-console-rail-fact", page);
  await row.click();
  const band = page.getByRole("region", { name: "Session stalled" });
  await expect(band).toContainText("Idle with work open");
  await expect(band.locator("dt")).toHaveText(["Task", "Last", "Foreman"]);
  await expect(band.locator("dd").first()).toContainText(task.title);
  await expect(band.locator("dd").last()).toHaveText(brief);
  await expect(band.getByRole("button")).toHaveText(["Nudge", "Message…", "Mark done", "Dismiss"]);
  await capture(band, "03-console-stalled-band", page);

  // Nudge reaches the agent through the real outbox.
  await band.getByRole("button", { name: "Nudge", exact: true }).click();
  await expect.poll(() => heard(daemon, session.id, INBOX_MESSAGES.nudge), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => sessionState(daemon, session.id), { timeout: 30_000 }).toBe("idle");
  await expect.poll(activityStart).toBeGreaterThan(since);
  await expect(band).toHaveCount(0);
  await expect(row.locator(".rail-stalled")).toHaveCount(0);

  // Even another poll about the previous episode cannot bring the old fixes back.
  await page.waitForResponse(response => response.url().endsWith("/api/away/stalls"));
  await expect(band).toHaveCount(0);
  since = await activityStart();
  await expect(band).toBeVisible({ timeout: 15_000 });

  // Dismiss returns the row to the rest of Idle: the mark and the band go, and nothing reaches the inbox.
  await page.getByRole("region", { name: "Session stalled" })
    .getByRole("button", { name: `Dismiss ${name} from Stalled` }).click({ timeout: 15_000 });
  await expect(page.getByRole("region", { name: "Session stalled" })).toHaveCount(0);
  await expect(row.locator(".rail-stalled")).toHaveCount(0);
  await expect(page.locator(".fleet-section-stalled")).toHaveCount(0);
  await page.waitForTimeout(6_000); // one stall poll, so a row that was coming would be drawn
  await expect(page.locator("button.pulse-seg", { hasText: "to answer" })).toHaveCount(0);
});
