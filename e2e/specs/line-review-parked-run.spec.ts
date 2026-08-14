import { mkdirSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * A parked repair round that nothing will ever reopen, and whether the dashboard says so.
 *
 * The bug this pins: a session receives a repair packet, makes the fix, goes idle - and round
 * N+1 never opens. The run sits in `waiting_for_session` indefinitely.
 * `workflowRunWaitsOnOperator` used to exclude that status outright, on the stated grounds
 * that "the session will resubmit on its own" - which is true only under `auto` resumption
 * AND `live` delivery. Under any other posture the run is nobody's, and the surfaces an
 * operator actually scans said nothing at all about it: the Line strip's Review fold, the
 * Review drawer, and the palette.
 *
 * Only this layer can see it. The fold's unit test proves the sentence given a summary, and
 * the drawer's markup test proves the row given a run - but neither can tell whether the
 * daemon puts `resumptionPolicy` and `deliveryMode` on the summary that reaches the browser
 * in the first place, which is the half of the fix that lives in SQL. A build that resolved
 * neither field would pass every unit test in the repository and still show an operator
 * nothing, because both would read as absent and absent means "assume it resumes itself".
 *
 * Both postures are covered on purpose. Asserting only the parked case would pass on a build
 * that simply called every live run yours, which is the false positive the old
 * `manual-resubmit` alert actually shipped.
 *
 * No model tokens: the seeded runs are held by a Persona the fake agent answers
 * deterministically.
 */

const EVIDENCE = artifactsDir("line-review-parked-run");

/**
 * Photograph a state this spec has already asserted on.
 *
 * Behind `MC_E2E_EVIDENCE` for the reason the Line strip's captures are: an ordinary run
 * would rewrite the binaries for no added signal. Inside the regression test rather than in
 * a staged capture spec, because the point of the picture is that the assertions around it
 * passed on the same run.
 */
async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer, and the
  // strip is six adjacent buttons.
  await page.mouse.move(0, 0);
  // Clipped to the strip and the drawer beneath it, which is the whole subject. A full-page
  // shot drags in the session card and the top bar, so the two postures this spec exists to
  // contrast stop being the thing a reader's eye lands on.
  const line = page.getByRole("navigation", { name: "The Line" });
  const box = await line.boundingBox();
  // Counted before it is measured: `boundingBox()` WAITS for its element, and this is called
  // once with the drawer still shut. Asking for a box that will never arrive spends the whole
  // expect timeout and then fails the test the picture was meant to illustrate.
  const drawer = page.locator(".line-drawer").first();
  const drawerBox = (await drawer.count()) > 0 ? await drawer.boundingBox() : null;
  const bottom = drawerBox ? drawerBox.y + drawerBox.height : (box?.y ?? 0) + (box?.height ?? 0);
  await page.screenshot({
    path: `${EVIDENCE}${name}.png`,
    ...(box ? { clip: { x: 0, y: box.y - 8, width: 1280, height: bottom - box.y + 16 } } : {}),
  });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/line-review-parked-run/${name}.png`);
}

async function api<T>(
  daemon: DaemonHandle,
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${text}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    // A 200 of HTML is the SPA fallback answering for a path no route claimed - a mistyped
    // path or the wrong method. Naming it beats `Unexpected token '<'` three frames away.
    throw new Error(`${path} answered ${response.status} with non-JSON: ${text.slice(0, 160)}`);
  }
}

const stage = (page: Page, name: string): Locator =>
  page.getByRole("navigation", { name: "The Line" })
    .getByRole("button", { name: new RegExp(`^${name},`) });

const drawer = (page: Page, name: string): Locator =>
  page.getByRole("region", { name: `${name} drawer` });

interface Posture {
  /** The workflow name, which is also what the Review row prints. */
  name: string;
  /** The half of the posture that lives on the immutable published VERSION. */
  resumptionPolicy: "manual" | "auto";
  /** The half that lives on the BINDING. `live` types the packet; `preview` never does. */
  deliveryMode: "preview" | "live";
}

/**
 * One real run parked in `waiting_for_session` under a stated resumption posture.
 *
 * Both fields are stated rather than defaulted, because the application default for
 * `resumptionPolicy` is `auto` and defaulting would silently seed the one posture that does
 * reopen itself - which is the counter-example, not the bug.
 */
async function seedParkedRun(
  dashboard: Page,
  daemon: DaemonHandle,
  posture: Posture,
): Promise<{ runId: string; sessionName: string }> {
  if (posture.deliveryMode === "live") {
    // Live delivery is refused outright without both of these, so a spec that wants the
    // self-resuming posture has to grant it the same way an operator does.
    await api(
      daemon,
      "/api/workflows/config",
      { liveEnabled: true, repoAllowlist: [daemon.repo] },
      "PUT",
    );
  }

  const before = new Set(
    (await api<Array<{ id: string }>>(daemon, "/api/sessions")).map((s) => s.id),
  );

  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(`park a ${posture.name} run`);
  await dialog.locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  // The daemon's own word for "the launch turn is over", which no DOM poll substitutes for.
  // Naming the NEW session rather than "the first one not exited" keeps a second seeded run
  // from binding to a conversation that already has a binding.
  let sessionId = "";
  await expect.poll(async () => {
    const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
    const live = sessions.find((s) => !before.has(s.id) && s.state !== "exited");
    sessionId = live?.id ?? "";
    return live?.state ?? "";
  }, { timeout: 60_000 }).toBe("idle");

  const persona = await api<{ id: string }>(daemon, "/api/personas", {
    name: `Strict reviewer ${posture.name}`,
    // The marker the fake agent answers with a failing verdict, which returns the run to the
    // session and parks it - open, and stable enough to assert against.
    guidanceMarkdown: `# Strict reviewer ${posture.name}\n\nE2E_FAIL_VERDICT`,
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: posture.name,
    resumptionPolicy: posture.resumptionPolicy,
    draft: {
      nodes: [
        { id: "session", kind: "session", position: { x: 0, y: 0 } },
        { id: "reviewer", kind: "persona", personaId: persona.id, position: { x: 220, y: 0 } },
        { id: "end", kind: "end", outcome: "Approved", position: { x: 440, y: 0 } },
      ],
      edges: [
        {
          id: "submit",
          source: "session",
          sourcePort: "submitted",
          target: "reviewer",
          targetPort: "activate",
        },
        {
          id: "pass",
          source: "reviewer",
          sourcePort: "pass",
          target: "end",
          targetPort: "terminal",
        },
        {
          id: "fail",
          source: "reviewer",
          sourcePort: "fail",
          target: "session",
          targetPort: "return_for_changes",
        },
      ],
    },
  });
  const published = await api<{ version: { id: string } }>(
    daemon,
    `/api/workflows/${workflow.workflow.id}/publish`,
    { expectedDraftRevision: 1 },
  );
  const binding = await api<{ id: string; sessionName: string }>(daemon, "/api/workflow-bindings", {
    workflowVersionId: published.version.id,
    sessionId,
    deliveryMode: posture.deliveryMode,
  });
  const submitted = await api<{ run: { id: string } }>(
    daemon,
    `/api/workflow-bindings/${binding.id}/submit`,
    { requestId: `e2e-parked-${posture.name}` },
  );
  await expect.poll(async () =>
    (await api<{ run: { status: string } }>(
      daemon,
      `/api/workflow-runs/${submitted.run.id}`,
    )).run.status,
  { timeout: 60_000 }).toBe("waiting_for_session");

  return { runId: submitted.run.id, sessionName: binding.sessionName };
}

test("a parked run nothing will resume counts as yours on the strip and in the drawer", async ({
  dashboard,
  daemon,
}) => {
  // Both halves false, because both are real shipped postures and either alone strands a
  // session: `manual` is every built-in version before 7 and every version published by a
  // build predating the column, and `preview` never types, so the packet sits `prepared` for
  // ever and the resumption observer reads that as "the agent was never told what to fix".
  const seeded = await seedParkedRun(dashboard, daemon, {
    name: "Parked review",
    resumptionPolicy: "manual",
    deliveryMode: "preview",
  });

  // ---- the strip ----
  //
  // The headline. Before the fix this stage read "Review, 1 run - Parked review v1" and
  // stopped there: a run that only a human Resubmit can move, reported as though the daemon
  // had it in hand. The accessible name is built from the same fold the drawer header
  // prints, so a drift between the two fails here on one of them.
  const review = stage(dashboard, "Review");
  await expect(review).toHaveAttribute("aria-label", /1 needs you/);
  await expect(review).toHaveClass(/tone-attention/);
  await shoot(dashboard, "strip-needs-you");

  // ---- the drawer ----
  await review.click();
  const panel = drawer(dashboard, "Review");
  await expect(panel.locator(".line-drawer-count")).toContainText("1 run live");
  await expect(panel.locator(".line-drawer-att")).toHaveText("1 needs you");
  // "needs you" and "stalled" are counted by subtraction so they cannot overlap: this run is
  // waiting on a person, not dead, and saying both would double-count one run.
  await expect(panel.locator(".line-drawer-att")).not.toContainText("stalled");

  // Amber marks "your turn"; red is reserved for runs that have stopped for good.
  const row = panel.locator(".line-run-row").first();
  await expect(row).toHaveClass(/is-waiting/);
  await expect(row).not.toHaveClass(/is-blocked/);
  await expect(row).toContainText("Parked review v1");
  await expect(row.locator("strong")).toHaveText(seeded.sessionName);

  // And the row still reaches the page that can clear it.
  await expect(row.getByRole("button", { name: "Open run" })).toBeVisible();
  await shoot(dashboard, "drawer-needs-you");
});

test("an auto, live run is the daemon's to reopen and is never called yours", async ({
  dashboard,
  daemon,
}) => {
  // The counter-example, and the reason the fix reads two fields rather than one status. This
  // is the posture the built-in workflow ships at version 7 and later: the resumption
  // observer picks the round up seconds after the agent settles, so calling it the operator's
  // would be the false positive the old `manual-resubmit` alert actually fired.
  await seedParkedRun(dashboard, daemon, {
    name: "Auto review",
    resumptionPolicy: "auto",
    deliveryMode: "live",
  });

  const review = stage(dashboard, "Review");
  await expect(review).toHaveAttribute("aria-label", /Auto review v1/);
  await expect(review).not.toHaveAttribute("aria-label", /needs you/);

  await review.click();
  const panel = drawer(dashboard, "Review");
  await expect(panel.locator(".line-drawer-count")).toContainText("1 run live");
  // Present and unmarked, rather than absent: the run is in flight and worth seeing.
  await expect(panel.locator(".line-run-row")).toHaveCount(1);
  await expect(panel.locator(".line-drawer-att")).toHaveCount(0);
  await expect(panel.locator(".line-run-row").first()).not.toHaveClass(/is-waiting/);
  await shoot(dashboard, "drawer-auto-unmarked");
});

test("the palette hoists a parked run into what is waiting on you", async ({
  dashboard,
  daemon,
}) => {
  // `workflowRunWaitsOnOperator`'s docstring has always claimed the palette's waiting-on-you
  // list reads it. Until this change the run provider never called it, so no run of any
  // status ever reached the empty-query attention preview.
  await seedParkedRun(dashboard, daemon, {
    name: "Palette parked",
    resumptionPolicy: "manual",
    deliveryMode: "preview",
  });

  // `Meta+k` and not `ControlOrMeta+k`: `chordFromEvent` derives the Command modifier from
  // `e.metaKey` alone, so the ControlOrMeta spelling arrives as "ctrl+k" on Linux and matches
  // nothing. See the note in `palette.spec.ts`.
  await dashboard.keyboard.press("Meta+k");
  const palette = dashboard.getByRole("dialog", { name: "Search everything" });
  await expect(palette).toBeVisible();

  // No query typed: the preview is exactly the rows that want a person.
  const parked = palette.getByRole("option", { name: /Palette parked/ });
  await expect(parked).toBeVisible();
  await expect(parked).toContainText("Waiting for the session");
});
