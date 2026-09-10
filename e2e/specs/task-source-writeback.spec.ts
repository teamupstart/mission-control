import { mkdirSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import { writeGhWritebackScript } from "../fixtures/fake-agents.ts";
import { recordsIn } from "../fixtures/records.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * Turning write-back on for a task source, watching what it delivered, and repairing what
 * it did not - in the panel an operator actually uses.
 *
 * Until this surface existed, every one of those was reachable only by hand-writing the
 * source's config through the API, which meant the feature was real and unusable.
 *
 * What only this layer can prove. `test/task-sources-panel.test.ts` pins the block's markup
 * and its disabled states, and `test/task-source-writeback-http.test.ts` pins the two routes
 * without a browser - but the editor those controls live in is gated on an effect that picks
 * a selection, and `renderToStaticMarkup` runs no effects, so no other layer can see them at
 * all. This is also the only place where a click reaches a route, the daemon stores it, the
 * WORKER reads it back and spends it, and the panel reports what happened.
 *
 * Driven against a **GitHub Issues** source throughout. That is not a shortcut: it is the
 * one kind whose write-back verbs this build implements, and pinning either of the other
 * kind's capability booleans would make this spec a hostage to a change that makes the
 * product strictly better. The disabled-with-a-reason rendering is asserted against a
 * synthetic capability in the markup test instead, where it costs milliseconds.
 *
 * No model tokens: nothing here dispatches an agent. Nothing is published either: the two
 * write-back verbs go through the same faked `gh` (`MISSION_GH_BIN`) as every other spec,
 * which is what stops a run on a signed-in developer machine from commenting on a real
 * issue and closing it.
 */

// The worker's own cadence, sped up to its floor. Per file rather than in the shared daemon
// env: every override there runs in all four workers' daemons for every spec in the suite,
// and a poller sped up for one spec is background work the other fifty pay for.
test.use({ daemonEnv: { MISSION_TASK_SOURCE_WRITEBACK_TICK_MS: "5000" } });

const EVIDENCE = artifactsDir("task-source-writeback");

/**
 * Photograph a state this spec has already asserted on.
 *
 * Behind `MC_E2E_EVIDENCE`, like the Jira task-source spec's: an ordinary run would rewrite
 * the binaries for no added signal. Inside the regression rather than a staged capture spec,
 * so each frame is of a run whose assertions passed.
 */
async function shoot(page: Page, name: string, anchor?: Locator): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // The source editor is taller than the viewport and this block is at the bottom of it, so
  // a frame of the card's top is a photograph of the sweep filters. Scrolled to whatever the
  // caller's assertion was about - unless a modal is up, since the confirm is centred and
  // the panel behind it must not move.
  if ((await page.getByRole("dialog").count()) === 0) {
    // Centred rather than `scrollIntoViewIfNeeded`, which scrolls the minimum distance and
    // therefore parks the thing being photographed hard against the bottom edge - where a
    // one-line sentence ends up half cut off, which is the one part of the frame a reviewer
    // needs to read.
    await (
      anchor ??
      // The paragraph, not the panel blurb that also names the block.
      page.getByRole("paragraph").filter({ hasText: /^Writing back to the item$/ })
    ).evaluate((el: HTMLElement) => el.scrollIntoView({ block: "center" }));
  }
  // Off every control, pointer AND focus: `Tooltip` opens on either, and a bubble over the
  // switches would be the one thing in the frame that is not what the spec is about.
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  // oxlint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/task-source-writeback/${name}.png`);
}

/** The item a delivery is owed to, in the `owner/repo#number` shape a sweep records. */
const ISSUE = "acme/demo-repo#123";
const PR_URL = "https://github.com/acme/demo-repo/pull/9";

/** One recorded `gh` invocation, as `FAKE_GH` writes it. */
interface GhRecord {
  argv: string[];
  cwd: string;
}

/** Configure one GitHub Issues source with the write-back switches this test needs. */
async function configureSource(
  page: Page,
  daemon: DaemonHandle,
  writeback: { onPrOpened: boolean; onCompleted: boolean; resolve: boolean },
): Promise<void> {
  const res = await page.request.put(`${daemon.baseURL}/api/task-sources/config`, {
    data: {
      sources: [
        {
          id: "src-writeback",
          kind: "github-issues",
          label: "demo issues",
          enabled: false,
          repoRoot: daemon.repo,
          writeback,
          config: {},
        },
      ],
    },
  });
  expect(res.ok(), "the daemon should accept the seeded source").toBe(true);
}

/**
 * Owe one delivery, as if a pull request had just been linked to a swept task.
 *
 * Seeded into the ledger rather than produced by dispatching an agent and merging its pull
 * request, and the line is drawn deliberately. The TRIGGER - `acceptPrForEpisode` observing
 * a first association and enqueuing this exact row - is pinned in-process by
 * `test/task-source-writeback.test.ts`, where it costs milliseconds and needs no model. What
 * only a browser can prove starts one step later, and every step from here on is the real
 * one: the real worker claims the row, re-reads the source's live consent, runs the real
 * `gh` argv against the fake binary, settles the real ledger state, and the real panel reads
 * it back.
 *
 * `attempts` is seeded one short of the limit so a single refusal exhausts the row rather
 * than backing it off for a minute - which is the state **Retry** exists to clear, and the
 * only way to reach it inside a spec's lifetime.
 */
function oweOneDelivery(daemon: DaemonHandle, attempts: number): void {
  withDaemonDb(daemon, (db) => {
    const notice = {
      signal: "pr-opened",
      action: "annotate",
      externalId: ISSUE,
      externalUrl: `https://github.com/acme/demo-repo/issues/123`,
      taskTitle: "Fix the parser",
      prUrl: PR_URL,
      repoRoot: daemon.repo,
      outcome: null,
      observedAt: Date.now(),
    };
    db.prepare(
      `INSERT INTO task_source_writeback
         (source_id, external_id, signal, action, dedupe_key, task_id, payload,
          state, attempts, next_at, created_at, updated_at)
       VALUES (?, ?, 'pr-opened', 'annotate', ?, NULL, ?, 'pending', ?, 0, ?, ?)`,
    ).run(
      "src-writeback",
      ISSUE,
      `pr:${PR_URL}`,
      JSON.stringify(notice),
      attempts,
      Date.now(),
      Date.now(),
    );
  });
}

/** This source's queue, as the panel's own GET reports it. */
async function queue(
  page: Page,
  daemon: DaemonHandle,
): Promise<Record<string, unknown> | undefined> {
  const res = await page.request.get(`${daemon.baseURL}/api/task-sources/config`);
  const body = (await res.json()) as { writeback?: Record<string, unknown>[] };
  return body.writeback?.[0];
}

test("the write-back switches arrive off, gate each other, and survive a reload", async ({
  page,
  daemon,
}) => {
  await page.goto(`${daemon.baseURL}/#/settings/task-sources`);
  const add = page.getByRole("button", { name: "Add source" });
  await expect(add).toBeVisible();
  await add.click();
  // Escape closes the combobox's portalled list, which otherwise covers the Add button.
  await page.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Add", exact: true }).click();

  const onPr = page.getByRole("checkbox", { name: /when a pull request opens/ });
  const onDone = page.getByRole("checkbox", { name: /^Comment on items from .* when the task completes$/ });
  const resolve = page.getByRole("checkbox", { name: /^Resolve items from .* when the task completes$/ });

  // The claim the block rests on, and the one a switch cannot make by itself: what is above
  // it reads somebody else's tracker, and what is in it writes to it.
  await expect(page.getByText(/Everything above only reads the upstream/)).toBeVisible();

  // All three off, for the reason a source itself arrives off: adding a source is
  // configuration, and writing onto somebody else's tracker is consent.
  await expect(onPr).not.toBeChecked();
  await expect(onDone).not.toBeChecked();
  await expect(resolve).not.toBeChecked();

  // A resolve with nothing to trigger it would read ON while nothing ever resolved, so the
  // panel refuses exactly what the stored schema refuses - and says which it is, rather
  // than hiding the switch and leaving somebody hunting for a setting.
  await expect(resolve).toBeDisabled();
  await expect(page.getByText(/Turn on the completion comment first/)).toBeVisible();
  await shoot(page, "writeback-switches-off");

  await onPr.check();
  await onDone.check();
  await expect(resolve).toBeEnabled();
  await resolve.check();

  // The kind's own write-back setting, beside the switches that make it matter.
  await page.getByLabel("How a resolved GitHub issue is closed").selectOption("not-planned");

  // Asserted against the daemon's own config rather than assumed: reloading straight after
  // a click cancels the in-flight write, which is what makes a spec like this pass alone
  // and fail under a loaded suite.
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`${daemon.baseURL}/api/task-sources/config`);
        const body = (await res.json()) as {
          sources?: { writeback?: unknown; config?: { closeReason?: string } }[];
        };
        return {
          writeback: body.sources?.[0]?.writeback,
          closeReason: body.sources?.[0]?.config?.closeReason,
        };
      },
      { message: "the daemon should have stored the write-back consent the panel accepted" },
    )
    .toEqual({
      writeback: { onPrOpened: true, onCompleted: true, resolve: true },
      closeReason: "not-planned",
    });

  // And it survives a fresh page, which is what proves the consent reached the daemon
  // rather than living in component state - the claim no other layer can make.
  await page.reload();
  await expect(page.getByRole("checkbox", { name: /when a pull request opens/ })).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: /^Comment on items from .* when the task completes$/ }),
  ).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: /^Resolve items from .* when the task completes$/ }),
  ).toBeChecked();
  await expect(page.getByLabel("How a resolved GitHub issue is closed")).toHaveValue("not-planned");
  await shoot(page, "writeback-switches-on");

  // Turning the trigger off takes the resolve with it, because the stored shape refuses a
  // resolve with nothing to fire it. Dropped in the panel rather than composed and then
  // explained, so the two refuse the same thing.
  await page.getByRole("checkbox", { name: /^Comment on items from .* when the task completes$/ }).uncheck();
  await expect(
    page.getByRole("checkbox", { name: /^Resolve items from .* when the task completes$/ }),
  ).not.toBeChecked();
});

test("a refused delivery says why, Retry clears it, and Discard empties the queue", async ({
  page,
  daemon,
}) => {
  // The switches themselves are proved above; here they are the precondition, so they go in
  // through the same route the panel writes.
  await configureSource(page, daemon, {
    onPrOpened: true,
    onCompleted: false,
    resolve: false,
  });
  writeGhWritebackScript(daemon.home, { comment: "refused" });
  oweOneDelivery(daemon, 5);

  await page.goto(`${daemon.baseURL}/#/settings/task-sources`);

  // The real worker claims it, re-reads the live consent, and runs the real argv against
  // the faked binary - which refuses. Exhausted, the row lands `failed`, and the panel says
  // so with the reason, which is the whole point of separating this from a silent retry.
  await expect(page.getByText(/1 failed/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/could not comment issue: HTTP 403 \(fake\)/)).toBeVisible();
  await shoot(page, "writeback-queue-failed", page.getByRole("button", { name: "Discard queue" }));

  // A failure is proof nothing was written, so its retry is the plain one. The
  // include-unknown control is a separate press, because that one is an operator asserting
  // they have gone and looked upstream.
  const retry = page.getByRole("button", { name: "Retry failed" });
  const retryUnknown = page.getByRole("button", { name: "Retry including unknown" });
  await expect(retry).toBeEnabled();
  await expect(retryUnknown).toBeEnabled();

  writeGhWritebackScript(daemon.home, { comment: "ok" });
  await retry.click();
  await expect(page.getByText(/1 delivery\(s\) back in the queue\./)).toBeVisible();
  await expect(page.getByText(/1 delivered\./)).toBeVisible({ timeout: 30_000 });
  // Delivered means there is nothing left to repair.
  await expect(page.getByRole("button", { name: "Retry failed" })).toBeDisabled();

  // What the faked `gh` was actually asked to do. Nothing was published, and this is where
  // a comment aimed at the wrong issue - or carrying our internals - would show up.
  const comments = recordsIn<GhRecord>(daemon.recordDir, (f) => f.startsWith("gh-")).filter(
    (r) => r.argv[0] === "issue" && r.argv[1] === "comment",
  );
  expect(comments.length).toBeGreaterThan(0);
  const last = comments.at(-1)!;
  expect(last.argv.slice(0, 5)).toEqual(["issue", "comment", "123", "--repo", "acme/demo-repo"]);
  expect(last.argv.at(-1)).toContain(PR_URL);
  expect(last.argv.at(-1)).toContain("Fix the parser");

  // Discard is behind a confirm, unlike "Forget seen items" beside it, because the two undo
  // different things: forgetting makes a sweep file more, while this drops deliveries that
  // have not happened and leaves nothing to say they were owed.
  await page.getByRole("button", { name: "Discard queue" }).click();
  const dialog = page.getByRole("dialog", { name: /Discard demo issues/ });
  await expect(dialog.getByText(/is dropped, along with the record/)).toBeVisible();
  // Measured rather than asserted from markup: this is the only layer that can see text
  // printed onto a panel border.
  await expectContentClearsBorder(dialog);
  await shoot(page, "writeback-discard-confirm");

  await dialog.getByRole("button", { name: "Discard queue" }).click();
  await expect(page.getByText(/Discarded 1 delivery\(s\)\./)).toBeVisible();
  await expect(page.getByText(/Nothing written back yet\./)).toBeVisible();
  expect(await queue(page, daemon)).toMatchObject({
    pending: 0,
    failed: 0,
    unknown: 0,
    delivered: 0,
  });

  // Discarding is about the QUEUE. An operator clearing a backlog of deliveries has not
  // asked to stop writing back, and silently switching their consent off would be a second
  // decision they did not make.
  await expect(page.getByRole("checkbox", { name: /when a pull request opens/ })).toBeChecked();
});

// Cancelling has to be reachable and has to do nothing, because the confirm is the only
// thing standing between a stray click and a queue nobody can rebuild.
test("cancelling the discard confirm leaves the queue alone", async ({ page, daemon }) => {
  await configureSource(page, daemon, {
    onPrOpened: true,
    onCompleted: false,
    resolve: false,
  });
  // Refused for good, so the row is still there to be counted while the confirm is open.
  writeGhWritebackScript(daemon.home, { comment: "refused" });
  oweOneDelivery(daemon, 5);

  await page.goto(`${daemon.baseURL}/#/settings/task-sources`);
  await expect(page.getByText(/1 failed/)).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "Discard queue" }).click();
  const dialog = page.getByRole("dialog", { name: /Discard demo issues/ });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);

  await expect(page.getByText(/1 failed/)).toBeVisible();
  expect(await queue(page, daemon)).toMatchObject({ failed: 1 });
});

// ---- what the operator sees when the REQUEST itself fails ----
//
// A distinct branch from a refused delivery, and the distinction is the point. A refused
// delivery is the daemon successfully telling you upstream said no - the queue moved, and
// the panel reports a real state. A failed REQUEST is the daemon not answering at all: the
// queue did not move, and the worst outcome is a panel that quietly reports success anyway,
// because then an operator believes they have repaired a queue that is still stuck.
//
// `test/task-source-writeback-http.test.ts` covers what the SERVER does with a malformed
// body or an unknown id. It cannot cover this, because this is the client's own branch:
// `useTaskSources` sets an error and returns null, and `SourceCard` turns that null into
// one specific sentence. Only a browser connects those three.
//
// The failure is injected at the network with `page.route`, rather than by asking the
// daemon to misbehave, because what is under test is the panel's reaction to a request that
// did not succeed - and every way that happens for real (the daemon down, the socket cut,
// a 500) reaches the client identically.

test("a retry the daemon refuses says so instead of reporting success", async ({
  page,
  daemon,
}) => {
  await configureSource(page, daemon, {
    onPrOpened: true,
    onCompleted: false,
    resolve: false,
  });
  writeGhWritebackScript(daemon.home, { comment: "refused" });
  oweOneDelivery(daemon, 5);

  await page.goto(`${daemon.baseURL}/#/settings/task-sources`);
  await expect(page.getByText(/1 failed/)).toBeVisible({ timeout: 30_000 });

  // Fail only the retry route. The config poll underneath must keep working, or the panel
  // would be reacting to a dead daemon rather than to one call that failed.
  await page.route("**/api/task-sources/*/writeback/retry", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "the ledger is locked" }),
    }),
  );

  await page.getByRole("button", { name: "Retry failed" }).click();

  // The sentence SourceCard maps a null result to, and the hook's own framing of the
  // daemon's words. Both, because either alone would let the other regress silently.
  await expect(page.getByText("That retry could not run.")).toBeVisible();
  await expect(page.getByText(/didn't stick: the ledger is locked/)).toBeVisible();
  // And no success sentence anywhere near it.
  await expect(page.getByText(/back in the queue/)).toHaveCount(0);

  // The queue is exactly where it was, which is the fact the sentence is protecting.
  await expect(page.getByText(/1 failed/)).toBeVisible();
  expect(await queue(page, daemon)).toMatchObject({ failed: 1, pending: 0 });
  // Photographed after the assertions, anchored on the sentence itself so the frame carries
  // both halves of the claim: the refusal the operator reads, and the queue line above it
  // still saying `1 failed`. A capture of only the sentence would not show that the retry
  // changed nothing, which is the part that matters.
  await shoot(page, "writeback-retry-refused", page.getByText("That retry could not run."));
});

test("a discard the daemon refuses says so, and the queue survives", async ({
  page,
  daemon,
}) => {
  await configureSource(page, daemon, {
    onPrOpened: true,
    onCompleted: false,
    resolve: false,
  });
  writeGhWritebackScript(daemon.home, { comment: "refused" });
  oweOneDelivery(daemon, 5);

  await page.goto(`${daemon.baseURL}/#/settings/task-sources`);
  await expect(page.getByText(/1 failed/)).toBeVisible({ timeout: 30_000 });

  // The DELETE only. Anchored to the end of the path so it cannot also swallow the retry
  // route above it, which shares this prefix.
  await page.route(
    (url) => url.pathname.endsWith("/writeback") && url.pathname.includes("/task-sources/"),
    (route) =>
      route.request().method() === "DELETE"
        ? route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ error: "the ledger is locked" }),
          })
        : route.fallback(),
  );

  await page.getByRole("button", { name: "Discard queue" }).click();
  const dialog = page.getByRole("dialog", { name: /Discard demo issues/ });
  await dialog.getByRole("button", { name: "Discard queue" }).click();

  await expect(page.getByText("The queue could not be discarded.")).toBeVisible();
  await expect(page.getByText(/didn't stick: the ledger is locked/)).toBeVisible();
  await expect(page.getByText(/Discarded /)).toHaveCount(0);

  // Nothing was dropped. A confirm that reports success over a failed delete is how an
  // operator comes to believe a queue is gone while it goes on owing.
  await expect(page.getByText(/1 failed/)).toBeVisible();
  expect(await queue(page, daemon)).toMatchObject({ failed: 1 });
  await shoot(page, "writeback-discard-refused", page.getByText("The queue could not be discarded."));
});
