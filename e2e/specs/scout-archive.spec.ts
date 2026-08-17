import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { settled } from "../fixtures/settle.ts";
import { writeScoutBundle } from "../../test/helpers/archive-fixture.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";

// This file seeds one older portable bundle after its isolated daemon has started. Keep the
// real reconciler quick enough for that compatibility proof instead of reaching into its DB.
test.use({ daemonEnv: { MISSION_SCOUT_RECONCILE_MS: "200" } });

/**
 * A scout's answer, from the prompt that demands it to the archive that outlives it.
 *
 * This is the one layer that can prove the claim, because the claim spans four things no
 * single-layer test sees at once: the daemon composes a report requirement into a real
 * dispatch's first prompt, a real agent process reads it and calls the real MCP submission
 * route, the daemon captures real files into a real bundle, and the completion the operator
 * clicks waits for that bundle to exist and verify.
 *
 * Nothing is stubbed on the browser side and nothing inside the daemon. The ONE substitution
 * is the model: `MISSION_CLAUDE_BIN` points at a fake that, on seeing the scout contract in
 * its prompt, writes a static page into its own checkout and POSTs to `/mcp/scouts/submit`
 * with the harness token and the daemon-issued checkout credential. No model API is reached
 * and no tokens are spent - see `e2e/fixtures/fake-claude.mjs`.
 */

const SCOUT_TASK = "find out why a resumed agent lost repository permissions";
const LONG_SCOUT_TASK =
  `${SCOUT_TASK}; inspect terminal and SDK recovery, compare Pi launch-time ` +
  "delivery, and preserve the deliberately long task wording that must never replace the short card title";
const CONTEXT_SCOUT_TASK =
  `${LONG_SCOUT_TASK}; wait for follow-up context before submitting the report`;
const HUMAN_FOLLOW_UP =
  "Also verify the human-only correlation marker at " +
  "/permissions/reconnect/sessions/this-is-one-deliberately-unbroken-token-that-must-wrap-without-widening-the-page.";
const AUTOMATED_INSTRUCTION =
  "Workflow automation says to inspect its private retry ledger before publishing.";
const SUBMIT_STAGED_REPORT = "E2E_SCOUT_SUBMIT_STAGED_REPORT";
const OLDER_TITLE = "Older reconnect archive";
const OLDER_QUESTION = "Why did the older reconnect path lose its grant?";
const OLDER_REPORT = "The older archive report remains readable without prompt metadata.";
const EVIDENCE = artifactsDir("scout-prompt-context");
const RENAME_EVIDENCE = artifactsDir("scout-rename");
/** Visible text that exists ONLY inside the report the fake writes. */
const FINDING = "the resume path never replayed the repository grant";
/** Turns the fake into a scout that writes its page and deliberately never submits it. */
const NO_SUBMIT = "E2E_SCOUT_NO_SUBMIT";
/** Turns the fake into a scout whose page the daemon must refuse. */
const INVALID = "E2E_SCOUT_INVALID_REPORT";

interface ArchiveRow {
  key: string;
  status: string;
  title: string;
  summary: string | null;
  captureStatus: string | null;
  artifactCount: number;
  hasPrimaryReport: boolean;
  missingCount: number;
}

interface FleetSession {
  id: string;
  agentSessionId: string | null;
  name: string;
  runtime: string;
  transcriptPath: string | null;
}

/** One bounded page of the library, straight off the daemon's own API. */
async function archives(daemon: DaemonHandle, query = ""): Promise<ArchiveRow[]> {
  const res = await fetch(`${daemon.baseURL}/api/archives${query}`);
  if (!res.ok) throw new Error(`GET /api/archives -> ${res.status}`);
  return ((await res.json()) as { archives: ArchiveRow[] }).archives;
}

/** Switch the shipped skills off, so the scout contract is provably not coming from one. */
async function disableSkills(daemon: DaemonHandle): Promise<void> {
  const res = await fetch(`${daemon.baseURL}/api/skills/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  expect(res.ok, "the skills panel should accept being switched off").toBeTruthy();
  const view = (await res.json()) as { enabled: boolean; skills: Array<{ id: string; enabled: boolean }> };
  expect(view.enabled, "skills are globally off for this daemon").toBe(false);
  expect(
    view.skills.find((skill) => skill.id === "html-report")?.enabled ?? false,
    "and the HTML Report skill in particular is not what asks for the page",
  ).toBe(false);
}

async function dispatchScout(page: Page, daemon: DaemonHandle, task: string): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(task);
  await dialog.getByLabel("Kind").selectOption("scout");
  // Choosing scout already defaults this to None; selecting it explicitly keeps the spec
  // independent of the machine's configured Workflow default.
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  const go = dialog.getByRole("button", { name: "Dispatch now" });
  await expect(go).toBeEnabled();
  await go.click();
  await expect(dialog).toBeHidden();
}

/** The one embedded session after its fake agent has bound a conversation. */
async function sdkSession(daemon: DaemonHandle): Promise<FleetSession> {
  let found: FleetSession | null = null;
  await expect
    .poll(async () => {
      const res = await fetch(`${daemon.baseURL}/api/sessions`);
      const rows = (await res.json()) as FleetSession[];
      found = rows.find((row) => row.runtime === "sdk" && row.agentSessionId !== null) ?? null;
      return found !== null;
    }, { message: "the scout should bind its fake SDK conversation", timeout: 30_000 })
    .toBe(true);
  return found!;
}

/** Deliver through the route Foreman and Workflow use, carrying durable non-human authorship. */
async function deliverAttributed(
  daemon: DaemonHandle,
  target: FleetSession,
  text: string,
): Promise<void> {
  const res = await fetch(`${daemon.baseURL}/api/sessions/${encodeURIComponent(target.id)}/inject`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, origin: "workflow", buffer: false }),
  });
  expect(res.ok, `POST /inject answered ${res.status}: ${await res.text()}`).toBe(true);
}

/**
 * Install the earlier launch-boundary prerequisite after the fake SDK session has bound.
 *
 * The reader phase deliberately does not change Phase 1's embedded-dispatch timing: a fresh
 * SDK card can be registered before its detached bound event creates a work episode, so the
 * launch-time freezer has no key at that instant. This Phase 3 case starts from the boundary
 * contract promised by the merged phases, then keeps every behavior under test real: composer
 * delivery and authorship journaling, transcript filtering, capture, portable manifest, indexing,
 * API projection, search, and the React reader.
 */
async function establishLaunchPromptContext(
  daemon: DaemonHandle,
  session: FleetSession,
  sessionName: string,
): Promise<void> {
  const scoutId = await taskId(daemon);
  withDaemonDb(daemon, (db) => {
    const binding = db
      .prepare(
        `SELECT episode_id
           FROM task_work_episode_bindings
          WHERE task_id = ? AND session_id = ?`,
      )
      .get(scoutId, session.id) as { episode_id?: string } | undefined;
    if (!binding?.episode_id) throw new Error("the bound scout has no work episode");
    const now = Date.now();
    db.prepare(
      `INSERT INTO scout_prompt_contexts
         (task_id, episode_id, session_id, session_name, transcript_path, transcript_offset,
          truncated, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)`,
    ).run(
      scoutId,
      binding.episode_id,
      session.id,
      sessionName,
      session.transcriptPath,
      now,
      now,
    );
  });
}

/**
 * The card with its conversation open.
 *
 * Expanded rather than read from the card face, because a card shows an ACTIVITY line while
 * a turn runs and drops it when the turn ends - so an assertion on the card would be racing
 * the turn boundary. The conversation is read from the real transcript file by the real SSE
 * stream, and it is where the agent's own account of the submission actually lands.
 */
async function scoutCard(page: Page) {
  const card = page.locator("article.card").first();
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Expand conversation" }).click();
  return card;
}

test("a dispatched scout is told to write a report, and archives it, with skills switched off", async ({
  dashboard,
  daemon,
}) => {
  await disableSkills(daemon);
  await dispatchScout(dashboard, daemon, SCOUT_TASK);

  const card = await scoutCard(dashboard);
  // The fake writes the page and submits it only because the DAEMON's prompt told it to -
  // the spec typed nothing but the question. Its answer is the proof the contract arrived.
  await expect(card).toContainText("Submitted the scout report", { timeout: 30_000 });

  // The page really is in the checkout, at the conventional path.
  await expect
    .poll(() => archives(daemon).then((rows) => rows.length), { timeout: 20_000 })
    .toBe(1);
  const [archive] = await archives(daemon);
  expect(archive.status, "a complete archive is ready, not partial").toBe("ready");
  expect(archive.hasPrimaryReport).toBe(true);
  expect(archive.captureStatus).toBe("complete");
  // The report plus the companion the fake wrote beside it. Nothing else from the checkout.
  expect(archive.artifactCount).toBe(2);
  expect(archive.summary ?? "").toContain("Resume rebuilt the session");

  // Searchable by text that exists only inside the report's HTML, which is the whole point
  // of extracting it at index time.
  await expect
    .poll(() => archives(daemon, `?q=${encodeURIComponent(FINDING)}`).then((r) => r.length), {
      timeout: 20_000,
      message: "the report's visible text should be searchable",
    })
    .toBe(1);
  // And by the companion's path, which is metadata rather than page text.
  expect(await archives(daemon, "?q=evidence.csv")).toHaveLength(1);

  // No pull request was expected or opened: a scout ships an answer, not a change.
  await expect(card).not.toContainText("PR #");
});

test("a scout that has not submitted a report cannot be completed, and keeps its checkout", async ({
  dashboard,
  daemon,
}) => {
  await disableSkills(daemon);
  await dispatchScout(dashboard, daemon, `${NO_SUBMIT} ${SCOUT_TASK}`);

  const card = await scoutCard(dashboard);
  await expect(card).toContainText("deliberately not submitted", { timeout: 30_000 });
  expect(await archives(daemon), "nothing is archived until a scout submits").toHaveLength(0);

  const complete = card.getByRole("button", { name: "Complete" });
  await expect(complete).toBeVisible();
  await settled(complete);
  await complete.click();

  const dialog = dashboard.getByRole("dialog", { name: "Complete task and close session" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Complete & close" }).click();

  // The modal stays open carrying the daemon's own sentence, naming the path and the tool -
  // which is the whole affordance: the operator can see what the agent still owes.
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("docs/reports/<slug>/report.html");
  await expect(dialog).toContainText("submit_scout_artifacts");

  // And nothing was lost to the attempt: the task is still live, on its own worktree, so the
  // agent can still be told to finish the job.
  await dashboard.getByRole("button", { name: "Close" }).first().click();
  await expect(dialog).toBeHidden();
  await expect(card).toContainText("worktree-pools/");
  await expect(card.getByRole("button", { name: "Complete" })).toBeVisible();
});

test("a report the daemon refuses is reported to the scout and archives nothing", async ({
  dashboard,
  daemon,
}) => {
  await disableSkills(daemon);
  await dispatchScout(dashboard, daemon, `${INVALID} ${SCOUT_TASK}`);

  const card = await scoutCard(dashboard);
  // The refusal reaches the AGENT, in its own conversation, with the reason - which is what
  // lets it correct the page rather than sit there believing it finished.
  await expect(card).toContainText("refused the scout submission", { timeout: 30_000 });
  await expect(card).toContainText("not a static report");
  expect(await archives(daemon), "a refused report publishes no archive at all").toHaveLength(0);
});

test("completing a submitted scout closes it, and the archive survives its task", async ({
  dashboard,
  daemon,
}) => {
  await disableSkills(daemon);
  await dispatchScout(dashboard, daemon, SCOUT_TASK);

  const card = await scoutCard(dashboard);
  await expect(card).toContainText("Submitted the scout report", { timeout: 30_000 });
  await expect.poll(() => archives(daemon).then((r) => r.length), { timeout: 20_000 }).toBe(1);
  const [before] = await archives(daemon);

  const complete = card.getByRole("button", { name: "Complete" });
  await expect(complete).toBeVisible();
  await settled(complete);
  await complete.click();
  const dialog = dashboard.getByRole("dialog", { name: "Complete task and close session" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Complete & close" }).click();
  // The archive already exists, so this is a cheap replay rather than a capture - the modal
  // closes on the daemon's answer rather than hanging on one.
  await expect(dialog).toBeHidden({ timeout: 10_000 });

  // Stop tracking the task entirely - the row, its worktree, and its session all go.
  const removed = await fetch(`${daemon.baseURL}/api/tasks/${await taskId(daemon)}`, {
    method: "DELETE",
  });
  expect(removed.ok, await removed.text()).toBeTruthy();

  // The answer is still here, still readable, still complete. That is the whole feature.
  const [after] = await archives(daemon);
  expect(after.key).toBe(before.key);
  expect(after.status).toBe("ready");
  const detail = await fetch(`${daemon.baseURL}/api/archives/${encodeURIComponent(after.key)}`);
  expect(detail.ok).toBeTruthy();
  const body = (await detail.json()) as { bundlePath: string; artifacts: Array<{ id: string }> };
  expect(existsSync(join(body.bundlePath, "report", "report.html"))).toBe(true);
  expect(existsSync(join(body.bundlePath, "manifest.json"))).toBe(true);

  // And the report's bytes are served through the archive's own route, by generated id.
  const report = await fetch(
    `${daemon.baseURL}/api/archives/${encodeURIComponent(after.key)}/artifacts/report`,
  );
  expect(report.ok).toBeTruthy();
  expect(await report.text()).toContain(FINDING);
});

test("reclaiming an unarchived scout keeps the page it had already written", async ({
  dashboard,
  daemon,
}) => {
  await disableSkills(daemon);
  await dispatchScout(dashboard, daemon, `${NO_SUBMIT} ${SCOUT_TASK}`);

  const card = await scoutCard(dashboard);
  await expect(card).toContainText("deliberately not submitted", { timeout: 30_000 });
  expect(await archives(daemon)).toHaveLength(0);

  // Cancel tears the worktree down, which is where an unsubmitted report would be lost. The
  // guard publishes it first, so a scout that did the work but never handed it over still
  // leaves its answer behind.
  const id = await taskId(daemon);
  const cancelled = await fetch(`${daemon.baseURL}/api/tasks/${id}/cancel`, { method: "POST" });
  expect(cancelled.ok, await cancelled.text()).toBeTruthy();

  await expect.poll(() => archives(daemon).then((r) => r.length), { timeout: 20_000 }).toBe(1);
  const [recovered] = await archives(daemon);
  expect(recovered.status, "the report was found and captured, so this is complete").toBe("ready");
  expect(recovered.hasPrimaryReport).toBe(true);
});

/** The one task this daemon has. Read from the API rather than guessed from the DOM. */
async function taskId(daemon: DaemonHandle): Promise<string> {
  const res = await fetch(`${daemon.baseURL}/api/tasks`);
  const tasks = (await res.json()) as Array<{ id: string; kind: string }>;
  const scout = tasks.find((task) => task.kind === "scout");
  if (!scout) throw new Error(`no scout task on this daemon: ${JSON.stringify(tasks)}`);
  return scout.id;
}

/*
 * ---------------------------------------------------------------------------
 * The Scouts page.
 *
 * Everything above proves an archive EXISTS. These prove an operator can find it, read it
 * and remove it - which is the whole point of keeping it. They ride the same real dispatch,
 * so the archive under test was produced by a real agent process calling the real submission
 * route, and no model tokens are spent.
 * ---------------------------------------------------------------------------
 */

/** The Scouts page's own rail, once it is on screen. */
function rail(page: Page) {
  return page.getByRole("complementary", { name: "Scout archives" });
}

async function capturePromptEvidence(page: Page, name: string): Promise<void> {
  if (process.env.MC_E2E_EVIDENCE !== "1") return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({
    path: `${EVIDENCE}${name}.png`,
    animations: "disabled",
  });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/scout-prompt-context/${name}.png`);
}

test("Scouts is reachable from the topbar, its shortcut, and the command palette", async ({
  dashboard,
}) => {
  const scoutsRail = rail(dashboard);

  // 1. The topbar segment. Named, not a bare glyph.
  await dashboard.getByRole("button", { name: /^Scouts/ }).click();
  await expect(scoutsRail).toBeVisible();
  await expect(dashboard).toHaveURL(/#\/scouts/);

  // 2. The global shortcut, from another page, with nothing focused.
  await dashboard.getByRole("button", { name: /^Fleet/ }).click();
  await expect(scoutsRail).toBeHidden();
  await dashboard.keyboard.press("Shift+S");
  await expect(scoutsRail).toBeVisible();

  // 3. The command palette, by a word that is NOT in the page's title - the row exists to be
  //    found by what the page is about.
  await dashboard.getByRole("button", { name: /^Fleet/ }).click();
  await expect(scoutsRail).toBeHidden();
  // `Meta+k`, not `ControlOrMeta`: the chord grammar derives `cmd` from `e.metaKey` alone
  // (`chordFromEvent`), so on Linux CI `ControlOrMeta` sends Control, no chord matches, and
  // the palette never opens. Passed on macOS and failed on CI for exactly that reason. The
  // three other specs that open the palette all press `Meta+k`.
  await dashboard.keyboard.press("Meta+k");
  const palette = dashboard.getByRole("dialog", { name: "Search everything" });
  await expect(palette).toBeVisible();
  // "investigation" is in the row's keywords and in NO page title, so a hit here proves the
  // row is findable by what Scouts is about rather than by what it is called.
  await dashboard.keyboard.type("investigation");
  const row = palette.getByRole("option", { name: /Scouts/ }).first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(scoutsRail).toBeVisible();
});

test("an archived scout renames inline with the session binding and keeps its bundle immutable", async ({
  dashboard,
  daemon,
}) => {
  const originalTitle = "Reconnect archive before rename";
  const renamedTitle = "Reconnect grant finding";
  const written = writeScoutBundle(join(daemon.home, "archives"), { title: originalTitle });
  await expect
    .poll(() => archives(daemon).then((rows) => rows.some((row) => row.key === written.key)), {
      timeout: 20_000,
    })
    .toBe(true);
  const manifestPath = join(written.dir, "manifest.json");
  const manifestBefore = readFileSync(manifestPath, "utf8");

  await dashboard.getByRole("button", { name: /^Scouts/ }).click();
  const reader = dashboard.getByRole("region", { name: "Scout report" });
  const title = reader.getByRole("heading", { level: 1 }).getByRole("button");
  await expect(title).toHaveText(new RegExp(originalTitle));

  // Clicking the heading opens the same interaction sessions use; Escape proves editing is
  // explicit before the keyboard path commits anything.
  await title.click();
  let box = reader.getByLabel("Rename scout");
  await expect(box).toHaveValue(originalTitle);
  await box.fill("discarded scout name");
  await box.press("Escape");
  await expect(box).toBeHidden();
  await expect(title).toHaveText(new RegExp(originalTitle));

  // Rebind the SESSION action and reload the browser cache. Scouts must follow that resolved
  // action rather than keeping a hard-coded Shift+R path of its own.
  const config = await fetch(`${daemon.baseURL}/api/ui/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ keybindings: { rename: "shift+n" } }),
  });
  expect(config.ok, await config.text()).toBeTruthy();
  await dashboard.reload();
  await expect(title).toHaveText(new RegExp(originalTitle));
  await dashboard.keyboard.press("Shift+R");
  await expect(reader.getByLabel("Rename scout")).toHaveCount(0);
  await dashboard.keyboard.press("Shift+N");
  box = reader.getByLabel("Rename scout");
  await expect(box).toHaveValue(originalTitle);
  if (process.env.MC_E2E_EVIDENCE === "1") {
    mkdirSync(RENAME_EVIDENCE, { recursive: true });
    await dashboard.screenshot({
      path: join(RENAME_EVIDENCE, "inline-scout-rename.png"),
      animations: "disabled",
    });
  }
  await box.fill(renamedTitle);
  await box.press("Enter");

  await expect(box).toBeHidden();
  await expect(reader.getByRole("heading", { level: 1 })).toContainText(renamedTitle);
  await expect(rail(dashboard).getByRole("button", { name: new RegExp(renamedTitle) }).first()).toBeVisible();
  await expect
    .poll(() => archives(daemon).then((rows) => rows.find((row) => row.key === written.key)?.title))
    .toBe(renamedTitle);
  expect(readFileSync(manifestPath, "utf8"), "a display rename must not rewrite evidence").toBe(
    manifestBefore,
  );

  const deepLink = dashboard.url();
  await dashboard.reload();
  await expect(dashboard).toHaveURL(deepLink);
  await expect(
    dashboard.getByRole("region", { name: "Scout report" }).getByRole("heading", {
      level: 1,
      name: renamedTitle,
    }),
  ).toBeVisible();
});

test("a finished scout keeps its concise title and ordered human prompt context", async ({
  dashboard,
  daemon,
}) => {
  await disableSkills(daemon);

  // One bundle exactly as an older build wrote it: no kind field and no prompt trail. The
  // daemon's recurring filesystem reconciliation is intentionally slow in production, so
  // seed before the live flow and wait for the real catalog to discover it.
  const older = writeScoutBundle(join(daemon.home, "scouts"), {
    legacyFormat: true,
    title: OLDER_TITLE,
    question: OLDER_QUESTION,
    reportHtml: `<!doctype html><html><body><p>${OLDER_REPORT}</p></body></html>`,
  });
  await expect
    .poll(() => archives(daemon).then((rows) => rows.some((row) => row.key === older.key)), {
      timeout: 20_000,
      message: "the daemon should discover the seeded older bundle",
    })
    .toBe(true);

  await dispatchScout(dashboard, daemon, CONTEXT_SCOUT_TASK);
  const card = await scoutCard(dashboard);
  await expect(card).toContainText("waiting for follow-up context before submission", {
    timeout: 30_000,
  });
  const liveTitle = card.getByRole("heading", { level: 2 }).first();
  await expect(liveTitle, "the live session card has a visible title").toBeVisible();
  const liveTitleText = (await liveTitle.locator(".card-title-name").innerText()).trim();
  const target = await sdkSession(daemon);
  await establishLaunchPromptContext(daemon, target, liveTitleText);

  // The human path is the real composer and pending-turn delivery seam. Wait for the fake's
  // echo, not merely for the text to appear as a queued row, so the accepted turn is durable
  // before the automated instruction follows it.
  const reply = card.getByPlaceholder(/Reply to this session/);
  await reply.fill(HUMAN_FOLLOW_UP);
  await reply.press("Enter");
  await expect(card).toContainText(`Mock reply to: ${HUMAN_FOLLOW_UP}`, { timeout: 30_000 });

  await deliverAttributed(daemon, target, AUTOMATED_INSTRUCTION);
  await expect(card).toContainText(`Mock reply to: ${AUTOMATED_INSTRUCTION}`, { timeout: 30_000 });

  // A second attributed fixture turn makes the fake submit its already-staged report through
  // the real agent-facing route. Both automated turns must be absent from prompt context.
  await deliverAttributed(daemon, target, SUBMIT_STAGED_REPORT);
  await expect(card).toContainText("Submitted the scout report", { timeout: 30_000 });
  await expect
    .poll(() => archives(daemon).then((rows) => rows.find((row) => row.title === liveTitleText) ?? null), {
      timeout: 20_000,
    })
    .not.toBeNull();
  const archived = (await archives(daemon)).find((row) => row.title === liveTitleText);
  expect(archived?.title, "the archive API carries a title").toBeTruthy();
  expect(archived!.title, "the card title stays shorter than the full human prompt").not.toBe(CONTEXT_SCOUT_TASK);
  expect(archived!.title.length).toBeLessThan(CONTEXT_SCOUT_TASK.length);
  await expect(liveTitle, "the archive API keeps the live card title exactly").toHaveAccessibleName(
    archived!.title,
  );
  await capturePromptEvidence(dashboard, "01-live-session-card-title");

  // Complete and remove the live work before reading the archive. The reader must stand on
  // the portable bundle, not on a session, task, worktree, or source transcript that remains.
  const complete = card.getByRole("button", { name: "Complete" });
  await expect(complete).toBeVisible();
  await settled(complete);
  await complete.click();
  const completeDialog = dashboard.getByRole("dialog", { name: "Complete task and close session" });
  await expect(completeDialog).toBeVisible();
  await completeDialog.getByRole("button", { name: "Complete & close" }).click();
  await expect(completeDialog).toBeHidden({ timeout: 10_000 });
  const removed = await fetch(`${daemon.baseURL}/api/tasks/${await taskId(daemon)}`, {
    method: "DELETE",
  });
  expect(removed.ok, await removed.text()).toBeTruthy();
  await expect(card, "the live scout is gone before its archive is read").toBeHidden({
    timeout: 15_000,
  });

  await dashboard.getByRole("button", { name: /^Scouts/ }).click();
  const scoutsRail = rail(dashboard);
  await expect(scoutsRail).toBeVisible();
  const archiveRow = scoutsRail.getByRole("button", { name: archived!.title }).first();
  await expect(archiveRow, "the archive rail keeps the exact title the live card showed").toBeVisible();
  await expect(archiveRow).toContainText(archived!.title);
  await expect(archiveRow).not.toContainText(CONTEXT_SCOUT_TASK);

  // The newest archive opens by itself, and the address bar names it - so the thing on
  // screen is always a link someone else can be sent.
  await expect(dashboard).toHaveURL(/#\/scouts\/[0-9a-f-]+~[0-9a-f-]+/);
  const deepLink = dashboard.url();

  const reader = dashboard.getByRole("region", { name: "Scout report" });
  await expect(reader.getByRole("heading", { level: 1, name: archived!.title })).toBeVisible();
  const promptContext = reader.getByRole("region", { name: "Prompt context" });
  await expect(promptContext).toBeVisible();
  const promptEntries = promptContext.getByRole("listitem");
  await expect(promptEntries).toHaveCount(2);
  await expect(promptEntries.nth(0)).toContainText("Original request");
  await expect(promptEntries.nth(0)).toContainText(CONTEXT_SCOUT_TASK);
  await expect(promptEntries.nth(1)).toContainText("Follow-up");
  await expect(promptEntries.nth(1)).toContainText(HUMAN_FOLLOW_UP);
  await expect(promptEntries.nth(1).locator("time")).toHaveAttribute("datetime");
  await expect(promptContext).not.toContainText(AUTOMATED_INSTRUCTION);
  await expect(promptContext).not.toContainText(SUBMIT_STAGED_REPORT);

  // The report renders INSIDE the sandbox, not as its own source. `FINDING` exists only in
  // report.html, so reading it here proves the bytes came out of the archive and through the
  // preview rather than out of any summary the daemon indexed.
  const report = dashboard.frameLocator('iframe[title^="Report"]');
  await expect(report.getByText(FINDING, { exact: false })).toBeVisible({ timeout: 15_000 });

  // Nothing the report brought with it can execute: the preview grants `allow-scripts` only
  // so its two hashed bridges run, and the CSP allows no other script and no network at all.
  const frame = dashboard.locator('iframe[title^="Report"]');
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  await expect(frame).not.toHaveAttribute("sandbox", /allow-same-origin/);

  // Search over a phrase that exists only in the human follow-up. The result explains that
  // it matched a prompt while preserving the concise title as the row and reader identity.
  const search = scoutsRail.getByPlaceholder("Search titles, prompts, findings, reports, files...");
  await search.fill("human-only correlation marker");
  const promptResult = scoutsRail.getByRole("button").filter({ hasText: liveTitleText }).first();
  await expect(promptResult).toBeVisible({
    timeout: 10_000,
  });
  await expect(promptResult.getByText("prompt", { exact: true })).toBeVisible();
  await expect(promptResult).toContainText("human-only correlation marker");
  await expect(reader.getByRole("heading", { level: 1, name: archived!.title })).toBeVisible();

  // Desktop and narrow visual states under both OS color preferences. Mission Control is
  // intentionally dark-only, so light preference must leave its tokenized dark surface
  // stable rather than introducing an unowned light override.
  await dashboard.setViewportSize({ width: 1440, height: 980 });
  await dashboard.emulateMedia({ colorScheme: "dark" });
  await capturePromptEvidence(dashboard, "02-reader-desktop-dark");
  await dashboard.emulateMedia({ colorScheme: "light" });
  await capturePromptEvidence(dashboard, "03-reader-desktop-light-os");
  await dashboard.setViewportSize({ width: 420, height: 900 });
  await reader.scrollIntoViewIfNeeded();
  await expect
    .poll(() => dashboard.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
    .toBe(true);
  await capturePromptEvidence(dashboard, "04-reader-narrow-light-os");
  await dashboard.emulateMedia({ colorScheme: "dark" });
  await capturePromptEvidence(dashboard, "05-reader-narrow-dark");

  // A word in no archive empties the list HONESTLY - "no match", never "no scouts yet".
  await search.fill("zzz-not-in-any-archive");
  await expect(scoutsRail.getByText("No scout matches")).toBeVisible({ timeout: 10_000 });
  await expect(scoutsRail.getByText("No scouts archived yet")).toBeHidden();

  // The deep link survives a reload, filters and all.
  await dashboard.goto(deepLink);
  await expect(rail(dashboard)).toBeVisible();
  await expect(
    dashboard.frameLocator('iframe[title^="Report"]').getByText(FINDING, { exact: false }),
  ).toBeVisible({ timeout: 15_000 });

  // The bundle directory is on screen and copyable, so the files are reachable without the app.
  await expect(dashboard.getByRole("button", { name: "Copy path" })).toBeVisible();

  // The old bundle has no prompt trail. It keeps its question visible below its concise
  // title, exposes no empty Prompt context section, and still opens its authored report.
  await search.fill("");
  const olderRow = scoutsRail.getByRole("button", { name: new RegExp(OLDER_TITLE) }).first();
  await expect(olderRow).toBeVisible({ timeout: 10_000 });
  await olderRow.click();
  await expect(reader.getByRole("heading", { level: 1, name: OLDER_TITLE })).toBeVisible();
  await expect(reader.getByText(OLDER_QUESTION, { exact: true })).toBeVisible();
  await expect(reader.getByRole("region", { name: "Prompt context" })).toHaveCount(0);
  await expect(
    dashboard.frameLocator('iframe[title^="Report"]').getByText(OLDER_REPORT, { exact: false }),
  ).toBeVisible({ timeout: 15_000 });
});

test("deleting a scout needs the word typed, and takes only that archive", async ({
  dashboard,
  daemon,
}) => {
  await disableSkills(daemon);
  await dispatchScout(dashboard, daemon, SCOUT_TASK);
  await expect(await scoutCard(dashboard)).toContainText("Submitted the scout report", {
    timeout: 30_000,
  });
  await expect.poll(() => archives(daemon).then((r) => r.length), { timeout: 20_000 }).toBe(1);

  await dashboard.getByRole("button", { name: /^Scouts/ }).click();
  await expect(rail(dashboard)).toBeVisible();

  await dashboard.getByRole("button", { name: "Delete scout" }).first().click();
  const dialog = dashboard.getByRole("dialog", { name: /Delete the scout archive/ });
  await expect(dialog).toBeVisible();

  // Armed only by the literal word. The consequence is stated before it can be taken.
  await expect(dialog).toContainText("The task, its session, the repository");
  const confirm = dialog.getByRole("button", { name: "Delete scout" });
  await expect(confirm).toBeDisabled();
  await dialog.getByRole("textbox").fill("delete");
  await expect(confirm, "the confirmation is the exact word, not a near miss").toBeDisabled();
  await dialog.getByRole("textbox").fill("DELETE");
  await expect(confirm).toBeEnabled();
  await confirm.click();

  await expect(dialog).toBeHidden({ timeout: 10_000 });
  // Gone from the daemon, not merely from the list.
  await expect.poll(() => archives(daemon).then((r) => r.length), { timeout: 15_000 }).toBe(0);
  await expect(rail(dashboard).getByText("No scouts archived yet")).toBeVisible({
    timeout: 10_000,
  });
});
