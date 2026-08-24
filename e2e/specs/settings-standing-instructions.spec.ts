import { mkdirSync } from "node:fs";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { seedRepo, type DaemonHandle } from "../fixtures/daemon.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";

/**
 * The Standing instructions settings category, end to end.
 *
 * This is the only layer that can answer the question the feature is actually about: does a
 * rule an operator types into Settings reach the very next session dispatched into that
 * repository? The markup test asserts the panel's shape and the HTTP tests assert the
 * routes, but neither connects a keystroke to a route to a launch and back to the DOM.
 *
 * Both proofs are here and the negative one is as load-bearing as the positive: a feature
 * that sent the block everywhere would pass a positive-only spec, and the regression that
 * represents - a repository with no rule whose prompt is no longer what it was - is exactly
 * the one this store was designed not to cause.
 *
 * DELIVERY IS READ FROM THE LAUNCH SNAPSHOT, not from the fake agent's recorded argv, and
 * the choice is forced rather than convenient. Neither shipped pair puts the block anywhere
 * argv can see it: a terminal launch is handed to a multiplexer this environment does not
 * have, and the Agent SDK carries `systemPrompt.append` over the control protocol on stdin.
 * Phase 1 writes the composed block exactly as delivered to a per-session row at launch,
 * once and never updated, so that row IS the delivery - and it is the same source the
 * session chip renders, which is what makes the assertion visible to a person too.
 *
 * No model tokens are spent: every agent binary is redirected at a fake by
 * `e2e/fixtures/fake-agents.ts`.
 */

const EVIDENCE = artifactsDir("settings-standing-instructions");

const RULE = "Never run E2E tests locally. Run npm test and let CI cover the browser layer.";

/** Photograph a state this spec has already asserted on, behind `MC_E2E_EVIDENCE`. */
async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control, pointer AND focus: `Tooltip` opens on either, and a bubble over the
  // card the picture is of makes the picture useless.
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.screenshot({ path: `${EVIDENCE}${name}.png`, fullPage: true });
  // oxlint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/settings-standing-instructions/${name}.png`);
}

/**
 * Open the category and wait for the daemon's first answer.
 *
 * `reload` is not optional decoration on the second visit. `page.goto` to a URL that differs
 * only in its hash does not reload a single-page app, so a spec that "reloads" that way keeps
 * every scrap of client state - including which cards are disclosed - and an assertion that
 * a value came back from the DAEMON would in fact be reading the draft it never left.
 */
async function openPanel(
  page: Page,
  daemon: DaemonHandle,
  { reload = false } = {},
): Promise<void> {
  await page.goto(`${daemon.baseURL}/#/settings/standing-instructions`);
  if (reload) await page.reload();
  await expect(page).toHaveURL(/#\/settings\/standing-instructions$/);
  await expect(page.getByRole("tab", { name: /Standing instructions/ }))
    .toHaveAttribute("aria-selected", "true");
  // The unanswered sentence goes when the poll lands. Waiting on it is what keeps every
  // assertion below from racing the first read.
  await expect(page.getByText("The daemon has not answered yet", { exact: false }))
    .toHaveCount(0);
}

/**
 * One repository's card.
 *
 * Scoped by the textarea it owns rather than by index, because the panel holds N+1 boxes and
 * every card carries a Save of its own - an unscoped `Save` would be a strict-mode violation
 * at best and would press the wrong repository's button at worst, which is precisely the
 * mistake this feature must never make.
 */
function cardFor(page: Page, repo: string) {
  return page
    .locator(".si-card")
    .filter({ has: page.getByLabel(`Standing instructions for ${repo}`) });
}

/** Open a repository's disclosure. Its accessible name is its leaf plus its state chip. */
async function openCard(page: Page, repo: string): Promise<void> {
  const leaf = repo.split("/").pop()!;
  await page.getByRole("button", { name: new RegExp(`^${leaf} `) }).click();
}

/** Stage `repo` as a card, if it does not already have one. */
async function addRepo(page: Page, repo: string): Promise<void> {
  await page.getByPlaceholder("/path/to/repository (or a subdirectory)").fill(repo);
  // The combobox portals its listbox over the controls below and reopens on every
  // keystroke; its own Escape handler stops propagation, so this closes only the list.
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Add", exact: true }).click();
}

/** Write a rule for `repo` through the real controls, and wait for the daemon to hold it. */
async function writeRule(page: Page, daemon: DaemonHandle, repo: string, rule: string) {
  await addRepo(page, repo);
  await openCard(page, repo);
  await page.getByLabel(`Standing instructions for ${repo}`).fill(rule);
  await cardFor(page, repo).getByRole("button", { name: "Save", exact: true }).click();

  await expect
    .poll(async () => {
      const view = await (await page.request.get(`${daemon.baseURL}/api/instructions`)).json();
      return view.repositories[repo] ?? null;
    }, { message: "the daemon should hold the rule the operator just saved" })
    .toBe(rule);
}

/** Drive the dispatch modal for `repo`, with the workflow pinned to none. */
async function dispatch(page: Page, repo: string, task: string): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();

  await dialog.getByPlaceholder("search repos or type a path…").fill(repo);
  // The combobox portals its listbox over the Task field and opens on every keystroke, so
  // the next `fill` would land on a covered control. Its own Escape handler stops
  // propagation, so this closes the list and not the modal.
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(task);
  await dialog.getByLabel("Kind").selectOption("ship");
  // Pinned to none: this repo is not allowlisted for Live delivery, so the configured
  // default would refuse the dispatch and leave the modal open.
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");

  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
}

/** The sessions the daemon currently holds. */
async function sessions(page: Page, daemon: DaemonHandle): Promise<{ id: string; cwd: string }[]> {
  return await (await page.request.get(`${daemon.baseURL}/api/sessions`)).json();
}

/**
 * What a session was ACTUALLY sent at launch, from its immutable snapshot, or null on 404.
 *
 * This is the observation point for delivery in this environment, and the choice is forced
 * rather than convenient. A terminal launch is handed to a multiplexer that is not present
 * here, and the Agent SDK carries `systemPrompt.append` over the control protocol on stdin,
 * so neither pair puts the block anywhere `recordsIn` can read it. The snapshot is written
 * BY the launch from the very object the launch delivers - Phase 1 records the composed
 * block exactly as sent, once, and never updates it - so asserting on it is asserting on
 * the delivery, and it is the same source the session chip renders in the browser below.
 */
async function launchSnapshot(
  page: Page,
  daemon: DaemonHandle,
  id: string,
): Promise<{ text: string; mechanism: string; sources: { repoPath: string }[] } | null> {
  const res = await page.request.get(
    `${daemon.baseURL}/api/sessions/${encodeURIComponent(id)}/standing-instructions`,
  );
  return res.ok() ? await res.json() : null;
}

/** The one session this spec's dispatch created. */
async function onlySession(page: Page, daemon: DaemonHandle): Promise<string> {
  await expect.poll(async () => (await sessions(page, daemon)).length).toBeGreaterThan(0);
  return (await sessions(page, daemon))[0]!.id;
}

// ---- 1. Write a rule, save, reload, read it back ----

test("a rule written in Settings survives a reload and reads back from the daemon", async ({
  dashboard,
  daemon,
}) => {
  await openPanel(dashboard, daemon);

  // The shipped state: nothing configured, and the panel says so rather than looking broken.
  await expect(dashboard.getByText("No repository has a rule of its own")).toBeVisible();
  await expect(dashboard.getByText("0 configured")).toBeVisible();
  await shoot(dashboard, "empty");

  await writeRule(dashboard, daemon, daemon.repo, RULE);

  // Reloaded from scratch, so this reads the daemon rather than any surviving client state.
  await openPanel(dashboard, daemon, { reload: true });
  await expect(dashboard.getByText("1 configured")).toBeVisible();
  await openCard(dashboard, daemon.repo);
  await expect(dashboard.getByLabel(`Standing instructions for ${daemon.repo}`))
    .toHaveValue(RULE);
  // `override`, not `inherited` - the chip is what tells an operator this repository carries
  // its own text rather than falling through to the machine-wide default.
  await expect(cardFor(dashboard, daemon.repo).getByText("override")).toBeVisible();
  await shoot(dashboard, "rule-saved");

  // The reach block, row by row, in a browser. The Node test pins the DERIVATION that
  // produces these rows; this is the only layer that can say they are legible on screen.
  const reach = cardFor(dashboard, daemon.repo).locator(".si-reach");
  await reach.scrollIntoViewIfNeeded();
  for (const pair of ["claude · terminal", "claude · sdk", "codex · terminal", "codex · sdk", "pi · terminal"]) {
    await expect(reach.getByText(pair, { exact: true })).toBeVisible();
  }
  await expect(reach.getByText("sessions started outside Mission Control")).toBeVisible();
  await expect(reach.getByText("Foreman / Inspector / Persona review prompts")).toBeVisible();
  await expect(reach.getByText("sessions already running")).toBeVisible();
  await expect(reach.getByText(/keep what they launched with/)).toBeVisible();
  await shoot(dashboard, "reach-block");
});

// ---- 2. The rule reaches the very next dispatch ----

test("a rule written in Settings reaches the very next dispatch", async ({
  dashboard,
  daemon,
}) => {
  await openPanel(dashboard, daemon);
  await writeRule(dashboard, daemon, daemon.repo, RULE);

  await dashboard.getByRole("button", { name: "← Fleet" }).click();
  await dispatch(dashboard, daemon.repo, "write a haiku about flexbox");

  const id = await onlySession(dashboard, daemon);
  await expect
    .poll(async () => (await launchSnapshot(dashboard, daemon, id))?.text ?? null, {
      message: "the launch should carry the operator's rule, with no daemon restart",
    })
    .toContain(RULE);

  const snapshot = (await launchSnapshot(dashboard, daemon, id))!;
  // Composed, not pasted raw: the heading is what tells the agent these are the operator's
  // standing instructions rather than part of the task.
  expect(snapshot.text).toContain("## Standing instructions for this repository");
  // The MECHANISM is a property of the harness AND runtime pair, and this build dispatches
  // Claude over the Agent SDK by default, where the block is a non-destructive
  // `systemPrompt.append` rather than turn-one prose. Asserting it is what stops the pair
  // silently degrading to a prompt prefix - which would put the rule in the transcript, and
  // leave it governing only turn one instead of the whole session.
  expect(snapshot.mechanism).toBe("claude-sdk-system-prompt-append");
  expect(snapshot.sources.map((s) => s.repoPath)).toEqual([daemon.repo]);

  // And the browser says so: the chip is the operator-facing half of this proof, and it is
  // the only place the text is legible at all, since on Claude it never enters the
  // conversation.
  await dashboard
    .getByRole("navigation", { name: "Sessions" })
    .locator("button.rail-row")
    .first()
    .click();
  await expect(
    dashboard.getByRole("button", { name: /Standing instructions this session/ }),
  ).toBeVisible();
  await shoot(dashboard, "session-chip");
});

// ---- 3. A repository with no rule dispatches without one ----

test("a repository with no rule dispatches with no standing instructions at all", async ({
  dashboard,
  daemon,
}) => {
  await openPanel(dashboard, daemon);
  // A rule for the FIRST repo, so this proves SCOPING rather than merely proving that an
  // unconfigured machine sends nothing. The dispatch below goes into the second one.
  await writeRule(dashboard, daemon, daemon.repo, RULE);

  await dashboard.getByRole("button", { name: "← Fleet" }).click();
  await dispatch(dashboard, daemon.secondRepo, "write a haiku about grid");

  const id = await onlySession(dashboard, daemon);

  // Settled before asserting an absence, so this is not merely reading a launch that has
  // not written its snapshot yet.
  await new Promise((r) => setTimeout(r, 1500));
  expect(
    await launchSnapshot(dashboard, daemon, id),
    "a checkout with no rule must send nothing, and record nothing",
  ).toBeNull();

  // No chip either: the marker exists so nobody debugs an instruction they cannot see, and
  // one on a session that received nothing would send them looking for a rule that is not
  // there.
  await dashboard
    .getByRole("navigation", { name: "Sessions" })
    .locator("button.rail-row")
    .first()
    .click();
  await expect(dashboard.locator(".console-detail")).toBeVisible();
  await expect(
    dashboard.getByRole("button", { name: /Standing instructions this session/ }),
  ).toHaveCount(0);
});

// ---- 4. The session chip does not follow the setting ----

test("the session chip shows what that session received, and does not change when the rule does", async ({
  dashboard,
  daemon,
}) => {
  await openPanel(dashboard, daemon);
  await writeRule(dashboard, daemon, daemon.repo, RULE);

  await dashboard.getByRole("button", { name: "← Fleet" }).click();
  await dispatch(dashboard, daemon.repo, "write a haiku about flexbox");

  await dashboard
    .getByRole("navigation", { name: "Sessions" })
    .locator("button.rail-row")
    .first()
    .click();

  const chip = dashboard.getByRole("button", { name: /Standing instructions this session/ });
  await expect(chip).toBeVisible();
  await chip.click();
  const modal = dashboard.getByRole("dialog", {
    name: "Standing instructions this session received",
  });
  await expect(modal).toBeVisible();
  await expect(modal).toContainText(RULE);
  await shoot(dashboard, "session-chip-open");
  await dashboard.keyboard.press("Escape");

  // Now change the rule underneath the running session.
  const EDITED = "Completely different instructions that this session never saw.";
  await openPanel(dashboard, daemon, { reload: true });
  await openCard(dashboard, daemon.repo);
  await dashboard.getByLabel(`Standing instructions for ${daemon.repo}`).fill(EDITED);
  await cardFor(dashboard, daemon.repo)
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect
    .poll(async () => {
      const view = await (await dashboard.request.get(`${daemon.baseURL}/api/instructions`)).json();
      return view.repositories[daemon.repo] ?? null;
    })
    .toBe(EDITED);

  // The chip must still show what the session was GIVEN. This is the browser proof that it
  // reads the launch snapshot: a chip wired to the resolved route passes every other case in
  // this spec and fails only here - and it would then quote a running session text it never
  // saw, sending an operator looking for the cause of a behaviour in a rule never in effect.
  await dashboard.getByRole("button", { name: "← Fleet" }).click();
  await dashboard
    .getByRole("navigation", { name: "Sessions" })
    .locator("button.rail-row")
    .first()
    .click();
  await dashboard
    .getByRole("button", { name: /Standing instructions this session/ })
    .click();
  const after = dashboard.getByRole("dialog", {
    name: "Standing instructions this session received",
  });
  await expect(after).toContainText(RULE);
  await expect(after).not.toContainText(EDITED);
});

// ---- 5. The dispatch note covers every attached repository ----

test("the dispatch note reports a rule carried by the SECONDARY repository", async ({
  dashboard,
  daemon,
}) => {
  // The failure worth naming: sending one `repoPath` when the form has two attached would
  // read "nothing will be sent" while the launch sends the secondary's block - and an
  // operator told nothing is coming does not go looking for it.
  await openPanel(dashboard, daemon);
  await writeRule(dashboard, daemon, daemon.secondRepo, RULE);

  await dashboard.getByRole("button", { name: "← Fleet" }).click();
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();

  // The PRIMARY is the repository with no rule at all.
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("touch both checkouts");

  // With only the unconfigured primary attached, there is nothing to announce.
  await expect(dialog.getByText("Standing instructions will be sent.")).toHaveCount(0);

  // Attach the secondary, which is the one carrying the rule. The control is two-step: a
  // button reveals the combobox, and a second one commits the chip.
  await dialog.getByRole("button", { name: "Add another repo" }).click();
  await dialog.getByPlaceholder("repo to attach…").fill(daemon.secondRepo);
  await dashboard.keyboard.press("Escape");
  await dialog.getByRole("button", { name: "Attach repo" }).click();

  await expect(dialog.getByText("Standing instructions will be sent.")).toBeVisible();
  await dialog.getByRole("button", { name: "view" }).click();
  await expect(dialog.getByText(RULE)).toBeVisible();
  await shoot(dashboard, "dispatch-note-secondary");
});

// ---- 5b. A checkout whose path contains a space ----

test("a repository path containing a space is previewed, not silently split", async ({
  dashboard,
  daemon,
}) => {
  // `~/My Projects` is an ordinary directory and this app does not choose an operator's
  // paths for them. The note serializes its attached repositories into one effect key, and a
  // space-joined key splits back into two paths that are each not a repository: the route
  // refuses them, the fetch returns nothing, and the note says nothing is coming while the
  // launch delivers the block. A marker that says "nothing" is the reason an operator stops
  // looking, so this is the exact failure the marker exists to prevent - reachable only for
  // the operators whose paths happen to have a space in them.
  const spaced = seedRepo(daemon.workspace, "my spaced repo");

  await openPanel(dashboard, daemon);
  await writeRule(dashboard, daemon, spaced, RULE);

  await dashboard.getByRole("button", { name: "← Fleet" }).click();
  await dashboard.getByRole("button", { name: "Dispatch" }).click();
  const dialog = dashboard.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();

  await dialog.getByPlaceholder("search repos or type a path…").fill(spaced);
  await dashboard.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill("work in the spaced checkout");

  await expect(dialog.getByText("Standing instructions will be sent.")).toBeVisible();
  await dialog.getByRole("button", { name: "view" }).click();
  await expect(dialog.getByText(RULE)).toBeVisible();
  // And the provenance names the whole path, rather than a prefix ending at the space.
  await expect(dialog.getByText(`from the rule for ${spaced}`)).toBeVisible();
});

// ---- 6. Use global default removes the override rather than emptying it ----

test("Use global default returns a repository to inheriting, which an empty box does not", async ({
  dashboard,
  daemon,
}) => {
  // The distinction the whole store is built on, driven through the two real controls: a
  // box cleared to empty is an override meaning "send nothing HERE" and beats the
  // machine-wide default, while removing the override falls back through to it.
  await openPanel(dashboard, daemon);
  await writeRule(dashboard, daemon, daemon.repo, RULE);

  const card = cardFor(dashboard, daemon.repo);
  const box = dashboard.getByLabel(`Standing instructions for ${daemon.repo}`);

  await box.fill("");
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .poll(async () => {
      const view = await (await dashboard.request.get(`${daemon.baseURL}/api/instructions`)).json();
      return Object.hasOwn(view.repositories, daemon.repo) ? view.repositories[daemon.repo] : "ABSENT";
    }, { message: "clearing the box stores an empty override - it does not remove the key" })
    .toBe("");
  // Still an override, because "" beats the default. The chip has to say so.
  await expect(card.getByText("override")).toBeVisible();

  await card.getByRole("button", { name: "Use global default" }).click();
  await expect
    .poll(async () => {
      const view = await (await dashboard.request.get(`${daemon.baseURL}/api/instructions`)).json();
      return Object.hasOwn(view.repositories, daemon.repo);
    }, { message: "Use global default sends null, which removes the key" })
    .toBe(false);
  await expect(dashboard.getByText("0 configured")).toBeVisible();
});

// ---- 7. A poll landing mid-edit does not revert the operator's text ----

test("a config poll landing mid-edit does not revert what the operator is typing", async ({
  dashboard,
  daemon,
}) => {
  // The defect `useTaskSources.ts:49-60` records four times over, in the panel most exposed
  // to it: this edit is a long free-text field an operator may sit inside for minutes while
  // a 4-second poll runs underneath, and what would be reverted is a rule an agent obeys.
  await openPanel(dashboard, daemon);
  await writeRule(dashboard, daemon, daemon.repo, RULE);

  // Slow every read, so a poll is reliably in flight across the typing below.
  await dashboard.route("**/api/instructions", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await new Promise((r) => setTimeout(r, 300));
    await route.fallback();
  });

  const box = dashboard.getByLabel(`Standing instructions for ${daemon.repo}`);
  const TYPED = "A rule the operator is still in the middle of writing";
  await box.fill(TYPED);

  // Watched across several poll cycles rather than sampled once: the revert this guards
  // against is a flash that the very next commit would then persist.
  let reverted: string | null = null;
  for (let i = 0; i < 30; i++) {
    const value = await box.inputValue();
    if (value !== TYPED) reverted = value;
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(reverted, "a poll response overwrote the operator's in-flight edit").toBeNull();
});

// ---- 8. Saving one repository leaves every other repository alone ----

test("saving one repository does not persist a neighbour's unsaved draft", async ({
  dashboard,
  daemon,
}) => {
  // The worst failure this panel has: writing a rule the operator did not commit to. If the
  // panel ever PUTs its whole draft map, the second repository's in-progress text is stored
  // as though it had been saved, nothing on screen says so, and the next session dispatched
  // into it obeys an instruction nobody meant to write.
  await openPanel(dashboard, daemon);
  await writeRule(dashboard, daemon, daemon.repo, RULE);
  await writeRule(dashboard, daemon, daemon.secondRepo, "The second repository's saved rule.");

  const first = dashboard.getByLabel(`Standing instructions for ${daemon.repo}`);
  const second = dashboard.getByLabel(`Standing instructions for ${daemon.secondRepo}`);

  await second.fill("NEVER COMMITTED - still being typed");
  await first.fill("The first repository's new rule.");

  // Save the FIRST card only.
  await cardFor(dashboard, daemon.repo)
    .getByRole("button", { name: "Save", exact: true })
    .click();

  await expect
    .poll(async () => {
      const view = await (await dashboard.request.get(`${daemon.baseURL}/api/instructions`)).json();
      return view.repositories[daemon.repo];
    })
    .toBe("The first repository's new rule.");

  const view = await (await dashboard.request.get(`${daemon.baseURL}/api/instructions`)).json();
  expect(
    view.repositories[daemon.secondRepo],
    "saving one repository must not persist another's unsaved draft",
  ).toBe("The second repository's saved rule.");

  // The draft survives on screen, so the operator has not silently lost their place either.
  await expect(second).toHaveValue("NEVER COMMITTED - still being typed");

  // And Revert on it restores what is genuinely STORED rather than the draft - the
  // assertion that fails if the whole map was sent, because that path leaves the draft and
  // the baseline agreeing with each other and wrong.
  await cardFor(dashboard, daemon.secondRepo)
    .getByRole("button", { name: "Revert" })
    .click();
  await expect(second).toHaveValue("The second repository's saved rule.");
});
