import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";

/**
 * The retro OFFER: when the dashboard proposes a retrospective, and what one click delivers.
 *
 * Phase 2 already made the retro runnable over HTTP, so nothing shipped in this phase is the
 * retro itself - it is the answer to "is now the moment", and that answer is only checkable
 * here. `test/retro-offer.test.ts` pins the predicate and the markup, but a predicate that is
 * right and never reaches a card is the exact defect this layer exists to catch: the signal
 * has to be computed by the daemon, ride `session_upsert`, condition a control, and that
 * control has to POST to a route that types into a real session.
 *
 * What is real here: the dispatched SDK session, the correction typed into its conversation,
 * the daemon's own transcript scan that notices it, the `prCreated` hook that adopts the pull
 * request, the offer appearing over SSE, the click, the route, and the instruction landing in
 * the conversation the browser is rendering.
 *
 * Stood in for, and only ever the PROVIDER's answer: what the Inspector's poll saw on GitHub.
 * A review ROUND is written straight into the ledger the way the poller would, exactly as
 * `ship-log.spec.ts` and `workflow-pull-request-mismatch.spec.ts` do - e2e reaches no network,
 * and a real review would be a real model call.
 *
 * No model tokens: the session runs against the fake agent.
 */

const EVIDENCE = artifactsDir("retro-offer");
const TASK = "hold a session worth retrospecting";
const CORRECTION = "no - reproduce it in docker first, it never fails on the Mac";

/**
 * Photograph a state this spec has already asserted on.
 *
 * Behind `MC_E2E_EVIDENCE`, like every other capture here: the card carries a relative
 * timestamp and a fresh worktree uuid, so an unconditional shoot would rewrite a binary on
 * every run for no added signal. Inside the regression rather than in a staged capture spec,
 * so the picture is of a run whose assertions passed.
 */
async function shoot(
  target: { screenshot: (options: { path: string }) => Promise<unknown> },
  page: Page,
  name: string,
): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer, and this
  // row is a line of adjacent buttons.
  await page.mouse.move(0, 0);
  await target.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/retro-offer/${name}.png`);
}

/** Say what just held, after it held - so the transcript cannot narrate a step that did not. */
function observed(line: string): void {
  if (!process.env.MC_E2E_EVIDENCE) return;
  // eslint-disable-next-line no-console
  console.log(`OBSERVED ${line}`);
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

interface SessionRow {
  id: string;
  agent: string;
  cwd: string;
  state: string;
  agentSessionId: string | null;
  retro?: { reasons: string[] };
  inspector: { round: number; open: number } | null;
}

const sessions = (daemon: DaemonHandle): Promise<SessionRow[]> =>
  api<SessionRow[]>(daemon, "/api/sessions");

/**
 * Switch the retro skill on BEFORE anything is dispatched, which is not incidental ordering.
 *
 * `requiredSkillCommand` fails closed on a reload watermark: a conversation that started
 * before the current skills generation has to acknowledge a `/reload-skills` before the
 * daemon will type a skill-backed instruction into it. A session launched AFTER the toggle
 * is current by construction, so enabling first is what makes this spec about the offer
 * rather than about the reload it would otherwise be waiting on.
 */
async function enableRetroSkill(daemon: DaemonHandle): Promise<void> {
  const view = await api<{ skills: Array<{ id: string; enabled: boolean }> }>(
    daemon,
    "/api/skills/config",
    { enabled: true, skills: { retro: true } },
    "PUT",
  );
  const retro = view.skills.find((skill) => skill.id === "retro");
  // A build that stopped shipping `skills/retro` would otherwise fail later and obscurely,
  // as a 409 from the route with the offer already on screen.
  expect(retro?.enabled, "the retro skill has to be installable for this spec to mean anything")
    .toBe(true);
}

async function dispatch(page: Page, daemon: DaemonHandle): Promise<SessionRow> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(TASK);
  await dialog.locator("select").filter({ hasText: "finish without a Workflow" }).selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let live: SessionRow | undefined;
  await expect
    .poll(async () => {
      live = (await sessions(daemon)).find((session) => session.state !== "exited");
      return live?.state ?? "";
    }, { timeout: 60_000, message: "the dispatched session should settle before it is driven" })
    .toBe("idle");
  return live!;
}

/** The daemon's own adoption signal: the hook a harness fires when `gh pr create` returns. */
async function announcePullRequest(daemon: DaemonHandle, session: SessionRow, url: string): Promise<void> {
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const response = await fetch(`${daemon.baseURL}/hooks/Stop`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    // The AGENT's session id, not the card's - a hook naming the wrong one lands on no
    // session at all, and this spec would then pass by never adopting anything.
    body: JSON.stringify({
      agent: session.agent,
      sessionId: session.agentSessionId ?? session.id,
      cwd: session.cwd,
      prCreated: true,
      prUrl: url,
    }),
  });
  if (!response.ok) throw new Error(`hook answered ${response.status}: ${await response.text()}`);
}

/**
 * Write the review the Inspector's poll would have recorded: one round, nothing outstanding.
 *
 * The same lever `ship-log.spec.ts` uses for the columns only a `gh` call can fill. A real
 * round is a real model call against a real GitHub, and this suite reaches neither.
 */
function observeCleanReview(daemon: DaemonHandle): void {
  withDaemonDb(daemon, (db) => {
    db.prepare(
      `UPDATE inspector_prs
          SET round = 1, last_reviewed_at = ?, observed_state = 'OPEN', observed_at = ?
        WHERE state = 'open'`,
    ).run(Date.now(), Date.now());
  });
}

/**
 * Make the daemon re-read the ledger it did not write, through a route that already does it.
 *
 * `registry.refreshInspections` is what denormalizes a review round onto every session, and
 * the daemon calls it on adoption and once per Inspector sweep. Neither fires for a row this
 * spec wrote behind its back, so the config route - which re-reads for its own reason, the
 * chip baking `mode` in - is the public trigger. The patch writes the mode back unchanged, so
 * nothing about the daemon's behaviour is altered by the poke.
 */
async function refreshInspections(daemon: DaemonHandle): Promise<void> {
  const config = await api<{ mode: string }>(daemon, "/api/inspector/config");
  await api(daemon, "/api/inspector/config", { mode: config.mode }, "PUT");
}

/**
 * Assert this card's action row is on screen and carries NO retro offer.
 *
 * Two things make this more than `toHaveCount(0)`, and both were found by breaking the
 * predicate on purpose and watching the naive version stay green:
 *
 *  - The row is ANCHORED first. `SessionCard` drops the whole ActionBar once a session
 *    exits, so a card that has merely gone quiet satisfies "no Run retro" trivially - and
 *    the fake agent does exit, about twenty seconds in. Complete is the neighbour the offer
 *    renders beside, so its presence is what makes the absence next to it mean something.
 *  - The count is READ ONCE rather than asserted with a retrying matcher. `toHaveCount(0)`
 *    polls for the whole timeout and passes on the first moment the control is gone, so on a
 *    build that offers the retro wrongly it passes anyway - the moment being the unmount
 *    above. This is trap 6 in e2e/README.md: retry for something becoming true, read once
 *    for something that must never have become true.
 */
async function expectNoRetroOffer(card: ReturnType<Page["locator"]>): Promise<void> {
  await expect(card.getByRole("button", { name: "Complete" })).toBeVisible();
  expect(
    await card.getByRole("button", { name: "Run retro" }).count(),
    "the retro must not be offered here",
  ).toBe(0);
}

test("a corrected session is offered a retro once its review is clean, and one click delivers it", async ({
  dashboard,
  daemon,
}) => {
  await enableRetroSkill(daemon);
  const session = await dispatch(dashboard, daemon);

  const card = dashboard.locator("article.card").first();
  // Nothing yet: one human turn (the dispatched brief) and no pull request. This assertion is
  // the reason the whole spec is not decoration - it establishes that the control is ABSENT
  // before the conditions hold, so its later appearance is caused rather than coincidental.
  await expectNoRetroOffer(card);
  observed("a fresh session's action row carries no Retro");
  await shoot(card, dashboard, "01-no-offer-yet");

  // The correction. A second human turn is what makes this session worth retrospecting, and
  // it is typed through the composer rather than seeded, so the daemon's scan reads the same
  // bytes a person's message would leave.
  await card.getByRole("button", { name: "Expand conversation" }).click();
  const reply = card.getByPlaceholder(/^Reply to this session/);
  await expect(reply).toBeEnabled();
  await reply.fill(CORRECTION);
  await reply.press("Enter");
  await expect(card.getByText(`Mock reply to: ${CORRECTION}`)).toBeVisible();

  // The daemon notices, and says so on the session payload. Polled off the route rather than
  // off the DOM because the offer needs the review too - this is the half that is ready first.
  await expect
    .poll(async () => (await sessions(daemon)).find((s) => s.id === session.id)?.retro?.reasons, {
      timeout: 30_000,
      message: "the transcript scan should see the human turn beyond the opening brief",
    })
    .toEqual(["corrections"]);

  // Worthy, but the moment has not arrived: no pull request, so no offer. The conditioning is
  // two independent halves and this is what proves the second one is load-bearing.
  await expectNoRetroOffer(card);

  await announcePullRequest(daemon, session, "https://github.com/mancej-cyc/ai-harness/pull/477");
  await expect.poll(async () => (await api<unknown[]>(daemon, "/api/inspector/prs")).length).toBe(1);
  observeCleanReview(daemon);
  await refreshInspections(daemon);
  await expect
    .poll(async () => (await sessions(daemon)).find((s) => s.id === session.id)?.inspector?.round)
    .toBe(1);

  // Now. The offer reached the card over SSE with no reload, which is the claim.
  const retro = card.getByRole("button", { name: "Run retro" });
  await expect(retro).toBeVisible();
  // It says what it does and why it is being offered, in the accessible description the
  // tooltip renders - a button that spends a session's turn must not be a bare verb.
  //
  // Located on the PAGE and by the description's own class, not inside the card and not by
  // text: `Tooltip` portals its screen-reader copy to `document.body` (see trap 2 in
  // e2e/README.md), so a card-scoped locator never sees it and a page-scoped `getByText`
  // matches the visible bubble as well.
  await expect(
    dashboard.locator(".tt-desc", { hasText: "Offered because you corrected it during the work" }),
  ).toBeAttached();
  observed("the offer reached the card over SSE, naming the reason it is being made");
  await shoot(card, dashboard, "02-offer-on-the-card");

  await retro.click();

  // The instruction is in the conversation the browser is rendering. This is the whole
  // click-to-route-to-subprocess-to-SSE-to-DOM path in one assertion: the daemon rendered the
  // packet, typed it into a real SDK session, the fake wrote it to a real transcript, and the
  // stream brought it back.
  //
  // `.first()` because the string legitimately appears TWICE: the delivered user turn, and
  // the fake agent's reply, which echoes the prompt it received. That second copy is itself
  // evidence the packet reached the subprocess rather than only the transcript file, so it
  // is narrowed past rather than engineered away.
  await expect(card.getByText("Mission Control session action: Retro").first()).toBeVisible({
    timeout: 30_000,
  });
  // Addressed to THIS session, which is the only way the skill can read its own transcript.
  await expect(card.getByText(`Session: ${session.id}`).first()).toBeVisible();
  observed("one click delivered the retro instruction into the session's own conversation");
  await shoot(card, dashboard, "03-delivered-into-the-conversation");

  // Delivering a retro must not be what makes a session retro-worthy. The packet is a user
  // turn on disk exactly like a person's, so without attribution the offer would re-arm from
  // its own delivery and never go away.
  await expect
    .poll(async () => (await sessions(daemon)).find((s) => s.id === session.id)?.retro?.reasons)
    .toEqual(["corrections"]);

  // The Complete backstop, on a session that HAS earned it. The negative is asserted in the
  // case below; this is the positive, and it is here rather than in its own test because
  // reaching a worthy session is most of the work either would have to do.
  await card.getByRole("button", { name: "Complete" }).click();
  const complete = dashboard.getByRole("dialog", { name: "Complete task and close session" });
  await expect(complete).toBeVisible();
  await expect(complete.getByRole("button", { name: "Run a retro first" })).toBeVisible();
  observed("the Complete dialog offers a retro before completing, beside the completion itself");
  await shoot(complete, dashboard, "05-complete-offers-a-retro-first");
  // Escape, deliberately: pressing the backstop would send a SECOND retro, and the point of
  // the frame is that the offer is there rather than what it does when taken.
  await dashboard.keyboard.press("Escape");
  await expect(complete).toBeHidden();
});

test("a session nobody corrected is never offered a retro, however clean its review", async ({
  dashboard,
  daemon,
}) => {
  await enableRetroSkill(daemon);
  const session = await dispatch(dashboard, daemon);

  await announcePullRequest(daemon, session, "https://github.com/mancej-cyc/ai-harness/pull/478");
  await expect.poll(async () => (await api<unknown[]>(daemon, "/api/inspector/prs")).length).toBe(1);
  observeCleanReview(daemon);
  await refreshInspections(daemon);

  // Wait for the timing half to actually hold, so the absence below is a real refusal rather
  // than a test that finished before the conditions could arrive. Asserting "not there" on a
  // state that never became reachable is the trap `e2e/README.md` names.
  await expect
    .poll(async () => (await sessions(daemon)).find((s) => s.id === session.id)?.inspector?.round)
    .toBe(1);
  const current = (await sessions(daemon)).find((s) => s.id === session.id);
  expect(current?.retro, "an uncorrected session carries no worthiness signal").toBeUndefined();

  const card = dashboard.locator("article.card").first();
  // Wait for the clean review to reach the DOM before asserting the offer did not.
  //
  // This barrier is the whole test, and it was missing: the poll above reads the ROUTE, and a
  // `toHaveCount(0)` evaluated before the matching `session_upsert` has been rendered passes
  // instantly - on a build whose offer ignores worthiness entirely. Verified by breaking the
  // predicate exactly that way: without this line the case stayed green. The chip carries the
  // same push the offer would have ridden, so once it is on screen the absence is a refusal.
  await expect(
    card.getByRole("link", { name: "GitHub Inspector: reviewed, nothing outstanding" }),
  ).toBeVisible({ timeout: 30_000 });
  await expectNoRetroOffer(card);
  // The Complete backstop is conditioned on the same worthiness, so it is absent too - the
  // dialog that offers it is the one place the timing condition is dropped, and dropping the
  // timing condition must not drop the other one with it.
  await card.getByRole("button", { name: "Complete" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Complete task and close session" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Complete & close" })).toBeVisible();
  expect(
    await dialog.getByRole("button", { name: "Run a retro first" }).count(),
    "the Complete backstop keeps the worthiness condition",
  ).toBe(0);
  observed("the Complete dialog offers no retro for a session nobody corrected");
  await shoot(dialog, dashboard, "04-complete-without-a-backstop");
});
