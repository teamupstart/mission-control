import { mkdirSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * A dispatched session NAMES the workflow it is armed with, and the bind dialog opens on it.
 *
 * The reported bug: dispatching with "No-Mistakes Review · v8" selected looked like it
 * attached nothing. The chip on the session read "＋ workflow" - an offer to attach one - and
 * clicking it opened a dialog pre-selected on a completely different workflow. Every server-side
 * fact was correct the whole time; three UI defects stacked into one confident wrong reading:
 *
 *   1. The chip asked whether a RUN existed. Under the `foreman_complete` trigger the run does
 *      not exist until the work is finished, so a correctly armed session looked unarmed for
 *      its entire working life.
 *   2. The dialog's version select defaulted to `publishable[0]` - the catalog's first entry BY
 *      NAME. With one published workflow that is always right, which is how it survived. With
 *      two it offers whichever sorts first.
 *   3. The "already bound to …" notice truncated the version id to 8 characters, turning
 *      `builtin-workflow:no-mistakes-review@8` into "builtin-" - so the one line that could
 *      have corrected the reader named nothing.
 *
 * The second workflow published below is the whole point of this spec, and its name is load
 * bearing: "Aardvark Review" sorts ahead of "No-Mistakes Review", so a catalog-position default
 * lands on it. Against a single-workflow fleet every assertion here passes on the broken build.
 *
 * Only a browser can see this. The routes were right, the summaries were right, and each layer
 * in isolation was exactly what it should be. It is where they MEET, in a rendered chip and a
 * pre-selected option, that the product lied.
 */

const EVIDENCE = artifactsDir("session-bound-workflow");

/**
 * A picture of the surface the report was written about, gated behind `MC_E2E_EVIDENCE`.
 *
 * Taken inside the regression test rather than in a staged capture, because what makes the
 * picture worth anything is that the assertions around it passed on the same run: the chip in
 * the image is the chip `toBeVisible` just matched, over a binding the daemon really created.
 */
async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer.
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/session-bound-workflow/${name}.png`);
}

/**
 * Print a string this run actually READ off the rendered page.
 *
 * A screenshot is the right artifact for a person and the wrong one for anything that consumes
 * a text log - a reviewer reading run output cannot open a PNG, and a prose retelling of what
 * the PNG showed is exactly the unverifiable claim it was meant to replace. So the values the
 * assertions match are also emitted verbatim: what is printed here came out of the DOM on the
 * same run that passed, and can be compared against the assertions beside it.
 */
function seen(label: string, value: string): void {
  if (!process.env.MC_E2E_EVIDENCE) return;
  // eslint-disable-next-line no-console
  console.log(`SEEN  ${label}: ${JSON.stringify(value)}`);
}

/** The accessible name a screen reader announces for a locator. */
async function accessibleName(locator: Locator): Promise<string> {
  return (await locator.getAttribute("aria-label"))
    ?? (await locator.textContent())?.replace(/\s+/g, " ").trim()
    ?? "";
}

async function api<T>(
  daemon: DaemonHandle,
  path: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

/**
 * The prerequisites No-Mistakes Review's own binding defaults ask for.
 *
 * Its published defaults are Foreman-complete trigger and LIVE delivery, so the dispatch form
 * refuses to submit until Foreman is on and the repository is allowlisted. Setting them here
 * rather than picking a gentler workflow keeps this spec on the exact configuration the report
 * came from - the shipped review workflow, armed the way an operator actually arms it.
 */
async function armWorkflowPrerequisites(daemon: DaemonHandle): Promise<void> {
  await api(daemon, "/api/foreman/config", { enabled: true }, "PUT");
  await api(daemon, "/api/workflows/config", {
    liveEnabled: true,
    repoAllowlist: [daemon.repo],
  }, "PUT");
}

/** The text of a `<select>`'s chosen option. A collapsed select renders no option text, so
 *  Playwright's text matchers cannot see it - this reads the DOM instead. */
function selectedLabel(select: Locator): Promise<string> {
  return select.evaluate(
    (el) => (el as HTMLSelectElement).selectedOptions[0]?.textContent?.trim() ?? "",
  );
}

/**
 * Publish a workflow whose name sorts BEFORE the built-in review workflow.
 *
 * Never bound to anything. It exists only to occupy first place in a name-ordered catalog,
 * which is the position the old default reached for.
 */
async function publishAardvark(daemon: DaemonHandle): Promise<void> {
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "Aardvark Review",
    draft: {
      nodes: [
        { id: "session", kind: "session", position: { x: 0, y: 0 } },
        { id: "end", kind: "end", outcome: "Approved", position: { x: 220, y: 0 } },
      ],
      edges: [
        {
          id: "done",
          source: "session",
          sourcePort: "submitted",
          target: "end",
          targetPort: "terminal",
        },
      ],
    },
  });
  await api(daemon, `/api/workflows/${workflow.workflow.id}/publish`, { expectedDraftRevision: 1 });
}

/** Dispatch one agent with the built-in review workflow explicitly chosen, and settle it. */
async function dispatchWithNoMistakes(page: Page, daemon: DaemonHandle): Promise<string> {
  const before = new Set(
    (await api<Array<{ id: string }>>(daemon, "/api/sessions")).map((s) => s.id),
  );

  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("name the bound workflow");

  const afterWork = dialog.getByRole("combobox", { name: "After work", exact: true });
  // The machine's workflow config lands on its own fetch; until it does the default option
  // reads "loading…" and selecting against it would race.
  await expect.poll(() => selectedLabel(afterWork)).not.toContain("loading");
  // Chosen BY HAND rather than left on the dispatch default, because that is what the report
  // described: the operator picked No-Mistakes Review and got something else.
  // Skipping the sentinels deliberately: the "Dispatch default" option NAMES the default
  // workflow too ("Dispatch default — No-Mistakes Review · v8"), so matching on label alone
  // selects the sentinel and proves nothing about choosing the workflow by hand.
  const noMistakesId = await afterWork.evaluate((el) => {
    const option = [...(el as HTMLSelectElement).options]
      .filter((o) => !o.value.startsWith("__"))
      .find((o) => o.textContent?.includes("No-Mistakes Review"));
    return option?.value ?? "";
  });
  expect(noMistakesId, "the built-in review workflow is offered by name").toContain(
    "no-mistakes-review",
  );
  await afterWork.selectOption(noMistakesId);

  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  let sessionId = "";
  await expect.poll(async () => {
    const sessions = await api<Array<{ id: string; state: string }>>(daemon, "/api/sessions");
    const fresh = sessions.find((s) => !before.has(s.id) && s.state !== "exited");
    sessionId = fresh?.id ?? "";
    return fresh?.state ?? "";
  }, { timeout: 60_000 }).toBe("idle");
  return sessionId;
}

test("a dispatched session names its armed workflow, and the bind dialog opens on it", async ({
  page,
  daemon,
}) => {
  await armWorkflowPrerequisites(daemon);
  await publishAardvark(daemon);
  await page.goto(daemon.baseURL);

  const sessionId = await dispatchWithNoMistakes(page, daemon);

  // The server-side fact, asserted first so a UI failure below cannot be mistaken for the
  // daemon having armed the wrong thing.
  await expect.poll(async () => {
    const bindings = await api<Array<{ sessionId: string | null; state: string; workflowVersionId: string }>>(
      daemon,
      "/api/workflow-bindings",
    );
    return bindings.find((b) => b.sessionId === sessionId && b.state === "active")
      ?.workflowVersionId ?? "";
  }, { timeout: 30_000 }).toContain("no-mistakes-review");

  // 1. The chip names the workflow instead of offering to add one. This is the line the
  //    operator read as "nothing is attached".
  const chip = page.getByRole("button", { name: /No-Mistakes Review v\d+/ }).first();
  await expect(chip).toBeVisible();
  await expect(page.getByRole("button", { name: "＋ workflow" })).toHaveCount(0);
  seen("session chip", await accessibleName(chip));
  seen("session chip tooltip", (await chip.getAttribute("title")) ?? "(via Tooltip wrapper)");
  await shoot(page, "card-names-bound-workflow");

  // 2. The dialog opens on what is actually bound - not on the workflow that merely sorts
  //    first. "Aardvark Review" is published and would win a catalog-position default.
  await chip.click();
  const bind = page.getByRole("dialog", { name: "Bind workflow" });
  await expect(bind).toBeVisible();
  const published = bind.getByRole("combobox", { name: "Published workflow", exact: true });
  await expect.poll(() => selectedLabel(published)).toContain("No-Mistakes Review");
  await expect.poll(() => selectedLabel(published)).not.toContain("Aardvark");
  seen("dialog > Published workflow (selected)", await selectedLabel(published));
  seen(
    "dialog > Published workflow (all options)",
    (await published.evaluate((el) =>
      [...(el as HTMLSelectElement).options].map((o) => o.textContent?.trim() ?? "").join(" | "))),
  );

  // 3. The dialog says what it is bound to in words. The truncated id used to read "builtin-",
  //    which is the failure that let a correct binding look like a wrong one.
  await expect(bind.getByText(/Already bound to No-Mistakes Review · v\d+/)).toBeVisible();
  await expect(bind.getByText("builtin-", { exact: false })).toHaveCount(0);

  // 4. The sentence describing the version must not contradict the field beside it. `defaults`
  //    was seeded with the application-wide placeholder - foreman_complete and PREVIEW - and
  //    the effect that resolves it returned early once a binding existed, which is precisely
  //    the state opening on a real binding puts this dialog in. So the sentence claimed
  //    "preview" directly above a Delivery field correctly reading Live. Asserted as an
  //    agreement rather than a fixed string, so it keeps holding if v8's published defaults
  //    ever change, plus the concrete value that makes the agreement meaningful today.
  const delivery = bind.getByRole("combobox", { name: "Delivery", exact: true });
  await expect.poll(() => selectedLabel(delivery)).toBe("Live");
  const hint = bind.getByText(/^This version defaults to /);
  await expect(hint).toBeVisible();
  await expect(hint).toContainText((await selectedLabel(delivery)).toLowerCase());
  await expect(hint).toHaveText(/This version defaults to foreman complete and live\./);
  seen("dialog > bound notice", await accessibleName(bind.getByText(/^Already bound to /)));
  seen("dialog > Delivery (selected)", await selectedLabel(delivery));
  seen("dialog > version hint", await accessibleName(hint));

  await shoot(page, "bind-dialog-opens-on-real-binding");
});

test("a version picked while bindings are still loading is not reverted", async ({
  page,
  daemon,
}) => {
  /*
   * The version select is live for the whole time `GET /api/workflow-bindings` is in flight,
   * and hydration - "open on what this session is actually bound to" - fires when that request
   * settles. A pick inside that window was silently reverted to whatever was bound, which is
   * the same wrong-selection failure the rest of this spec exists to close, in miniature.
   *
   * The other three editable fields already had `overridesTouchedRef` for exactly this
   * async-seed-versus-manual-edit conflict. The version had no equivalent.
   *
   * The race is made deterministic rather than raced: the binding fetch is held open until the
   * pick has happened, then released. Without the guard this fails every run, not one in ten.
   */
  await armWorkflowPrerequisites(daemon);
  await publishAardvark(daemon);
  await page.goto(daemon.baseURL);
  await dispatchWithNoMistakes(page, daemon);

  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/workflow-bindings", async (route) => {
    // The GET only. The dialog's writes go to this same path and must not be held.
    if (route.request().method() === "GET") await held;
    await route.continue();
  });

  await page.getByRole("button", { name: /No-Mistakes Review v\d+/ }).first().click();
  const bind = page.getByRole("dialog", { name: "Bind workflow" });
  await expect(bind).toBeVisible();

  // Picked while the fetch is still out, which is the whole point.
  const published = bind.getByRole("combobox", { name: "Published workflow", exact: true });
  await published.selectOption({ label: "Aardvark Review · v1" });
  await expect.poll(() => selectedLabel(published)).toContain("Aardvark");

  release();

  // The conflict notice is the deterministic proof the bindings landed AND that the pick
  // survived them: it only renders once this session's active binding is known and is a
  // DIFFERENT version from the one selected. Waiting on it removes any need to sleep.
  await expect(bind.getByText(/already bound to No-Mistakes Review · v\d+/i)).toBeVisible();
  seen("dialog > selection after the fetch settled", await selectedLabel(published));
  await expect.poll(() => selectedLabel(published)).toContain("Aardvark");
  await expect.poll(() => selectedLabel(published)).not.toContain("No-Mistakes");
});

test("a session with no workflow still offers to attach one", async ({ page, daemon }) => {
  // The other half, which would rot silently: naming the binding must not turn the chip into a
  // permanent label on sessions that genuinely have nothing armed.
  await page.goto(daemon.baseURL);

  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("no workflow at all");
  const afterWork = dialog.getByRole("combobox", { name: "After work", exact: true });
  await expect.poll(() => selectedLabel(afterWork)).not.toContain("loading");
  await afterWork.selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();

  const offer = page.getByRole("button", { name: "＋ workflow" }).first();
  await expect(offer).toBeVisible({ timeout: 60_000 });
  seen("session chip (nothing bound)", await accessibleName(offer));
  await shoot(page, "card-unbound-still-offers");
});
