import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * Library › Commands: the shelf, the fixed-slot editor, and the workflow palette that reads it.
 *
 * This is the layer the phase actually needs. The Library model is a pure function `test/` can
 * check in a millisecond and the editor's markup is a `renderToStaticMarkup` shape - but
 * neither can tell you whether typing a command and pressing Save reaches the daemon's catalog,
 * whether the shelf card follows over SSE without a reload, or whether a second window's save
 * quietly eats your typing. Every assertion below is a click, a route, a server event, and what
 * came back to the DOM.
 *
 * Each durable claim is made TWICE - once through the browser and once against the daemon's own
 * `/api/workflow-commands` route - because the failure that matters here is silent in exactly
 * one direction: the editor renders what it just sent, so a broken write looks correct on
 * screen while every Command node skips forever.
 *
 * Nothing here dispatches, so no agent binary is launched and no model tokens are spent.
 */

const EVIDENCE = artifactsDir("library-commands");

interface CommandView {
  slot: string;
  defaultCommand: string[] | null;
  overrides: Array<{ repoRoot: string; command: string[] }>;
  revision: number;
}

/** The daemon's own catalog, read straight from it rather than off the screen. */
async function catalog(daemon: DaemonHandle): Promise<CommandView[]> {
  const res = await fetch(`${daemon.baseURL}/api/workflow-commands`);
  return (await res.json()) as CommandView[];
}

const slotOf = (views: CommandView[], slot: string): CommandView =>
  views.find((view) => view.slot === slot)!;

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

/**
 * Photograph a state this spec has already asserted on.
 *
 * Inside the regression test rather than in a staged capture spec, for the reason
 * `library.spec.ts` gives: the point of the picture is that the assertions around it passed on
 * the same run, so the image and the measurement cannot drift apart. Both widths, because the
 * split editor has two layouts - the rail sits beside the form above 820px and above it below.
 */
async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  const original = page.viewportSize() ?? { width: 1280, height: 720 };
  await page.mouse.move(0, 0);
  for (const [suffix, width] of [["wide", 1440], ["narrow", 720]] as const) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${EVIDENCE}${name}-${suffix}.png`, fullPage: true });
    // eslint-disable-next-line no-console
    console.log(`CAPTURED e2e/.artifacts/library-commands/${name}-${suffix}.png`);
  }
  await page.setViewportSize(original);
  await page.waitForTimeout(150);
}

const SLOTS = ["test", "lint", "typecheck", "build"] as const;

const card = (page: Page, slot: string) =>
  page.getByRole("region", { name: "What does each standard gate run?" })
    .getByRole("button", { name: new RegExp(`^${slot}\\b`) });

test("the Commands shelf is the sixth question, with four built-in cards and no New", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/library`);

  // Sixth, and headed by its question like the other five - the inversion that is the whole
  // point of this page.
  const shelf = dashboard.getByRole("region", { name: "What does each standard gate run?" });
  await expect(shelf).toBeVisible();
  await expect(shelf.getByRole("heading", { name: "What does each standard gate run?" }))
    .toBeVisible();

  for (const slot of SLOTS) {
    await expect(card(dashboard, slot)).toBeVisible();
    // A fresh daemon configures none of them, and an unconfigured slot is still a card: a
    // missing tile would read as a missing subsystem rather than as work to do.
    await expect(card(dashboard, slot)).toContainText("Not configured");
    await expect(card(dashboard, slot)).toContainText("built-in");
  }
  // Every authoring shelf carries a ＋ New card. This one cannot: the slots ship with the
  // product and there is no fifth to author.
  await expect(shelf.getByRole("button", { name: /New/ })).toHaveCount(0);
  // And no cross-link, because a Command has no runs of its own to count.
  await expect(shelf.getByRole("button", { name: /→$/ })).toHaveCount(0);

  // The page's contract, restated for the shelf that made it necessary: a Command IS an
  // executable argv, and saving one still executes nothing.
  await expect(dashboard.getByRole("main"))
    .toContainText("Nothing runs from here - live state stays on the runs and ensembles pages");

  await shoot(dashboard, "shelf");
});

test("an unloaded catalog says so, rather than claiming four unconfigured slots", async ({
  dashboard,
  daemon,
}) => {
  /*
   * `Not configured` is a claim about what this machine has stored, and the browser cannot
   * make it until the catalog has actually arrived. Drawn too early it is worse than blank:
   * an operator who reads it on a slot that does have a global default is being invited to
   * type over configuration that merely has not loaded.
   *
   * The window is milliseconds on a healthy daemon, so it is held open here by severing the
   * event stream before the page asks for it - which is also the state a daemon that has
   * stopped answering leaves the shelf in permanently.
   */
  await dashboard.route("**/events", (route) => route.abort());
  // A RELOAD, not a hash navigation. `#/library` from the fleet is same-document, so the
  // EventSource opened before the interception was installed would survive it and the
  // snapshot would already be in hand - the window this case exists to hold open would never
  // occur, and the test would pass against the unfixed build.
  await dashboard.goto(`${daemon.baseURL}/#/library`);
  await dashboard.reload();

  const shelf = dashboard.getByRole("region", { name: "What does each standard gate run?" });
  await expect(shelf).toBeVisible();
  for (const slot of SLOTS) {
    // Still four cards - the slots are a fixed vocabulary that ships with the build, so their
    // existence is knowable without the daemon. What they RUN is not.
    await expect(card(dashboard, slot)).toBeVisible();
    await expect(card(dashboard, slot)).toContainText("Waiting for the daemon");
  }
  await expect(shelf).not.toContainText("Not configured");

  // And the claim appears the moment the catalog does. Same page, no reload: the stream is
  // restored and the browser's own reconnect brings the snapshot in.
  await dashboard.unroute("**/events");
  await expect(card(dashboard, "test")).toContainText("Not configured", { timeout: 30_000 });
  await expect(shelf).not.toContainText("Waiting for the daemon");
});

test("a global default is typed, previewed, saved, and lands in the daemon's catalog", async ({
  dashboard,
  daemon,
}) => {
  // Precondition, asserted rather than assumed: every claim below is about a change of state.
  const opening = await catalog(daemon);
  expect(opening.map((view) => view.slot)).toEqual([...SLOTS]);
  expect(opening.every((view) => view.defaultCommand === null)).toBe(true);

  await dashboard.goto(`${daemon.baseURL}/#/library`);
  await card(dashboard, "test").click();

  // The card opens the editor on that slot, and the hash names it - so this is a link
  // somebody can paste rather than merely a place you can get to.
  await expect(dashboard.getByRole("complementary", { name: "Command library" })).toBeVisible();
  await expect(dashboard.getByRole("heading", { name: "test", exact: true })).toBeVisible();
  await expect.poll(async () => dashboard.evaluate(() => location.hash))
    .toBe("#/library/commands/test");

  // The execution note, stated once beside the form: this is where an operator decides
  // whether typing an argv here is a thing they meant to do.
  await expect(dashboard.getByRole("main")).toContainText("Saving stores an argv - it runs nothing");

  const field = dashboard.getByLabel("Default command");
  // The split is shown BEFORE anything is stored, because there is no shell in this path and
  // the rule is ours: the quoted pair is ONE argument, and that is only trustworthy numbered.
  await field.fill('npm run test -- --grep "a b"');
  await expect(dashboard.locator(".wf-command-preview").first()).toContainText("6. a b");
  // A line that cannot be split refuses locally, with the parser's own sentence.
  await field.fill('npm "unclosed');
  await expect(dashboard.locator(".wf-command-preview").first()).not.toContainText("Runs as:");

  await field.fill("npm test");
  await dashboard.getByRole("button", { name: "Save Command" }).click();

  // The daemon's catalog moved - the assertion the editor's own optimistic render cannot make
  // on its own behalf.
  await expect
    .poll(async () => slotOf(await catalog(daemon), "test").defaultCommand, {
      message: "Save should replace the slot's default through /api/workflow-commands",
    })
    .toEqual(["npm", "test"]);

  // And it comes back over SSE rather than by polling: the rail row and the shelf card both
  // follow without a reload.
  await expect(dashboard.getByRole("complementary", { name: "Command library" }))
    .toContainText("Global default");
  await expect(dashboard.getByRole("button", { name: "Save Command" })).toBeDisabled();

  await dashboard.goto(`${daemon.baseURL}/#/library`);
  await expect(card(dashboard, "test")).toContainText("Global default");
  await expect(card(dashboard, "lint")).toContainText("Not configured");
});

test("an override, a nested override, and a removal all survive a reload", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/library/commands/test`);
  await expect(dashboard.getByRole("heading", { name: "test", exact: true })).toBeVisible();
  // A fresh slot has no default, so there is no "default above" for a repository to use and
  // every one of them skips. The empty state has to say which of those two states it is in -
  // the first thing a new operator reads here must not describe configuration that is absent.
  const empty = dashboard.locator(".wf-command-empty");
  await expect(empty).toContainText("no default");
  await expect(empty).toContainText("skips");
  await expect(empty).not.toContainText("resolves to the default above");

  // A half-typed line is not a default either - it cannot be parsed, so it cannot be saved,
  // so there is nothing to fall back to. This is the state an operator is in between two
  // keystrokes, which is why it is asserted here rather than only in the pure test.
  await dashboard.getByLabel("Default command").fill('npm "unclosed');
  await expect(empty).toContainText("not a command yet");
  await expect(empty).not.toContainText("resolves to the default above");

  await dashboard.getByLabel("Default command").fill("npm test");
  // Finished, and the same row now describes what the exceptions would be exceptions TO.
  await expect(empty).toContainText("every repository resolves to the default above");
  await expect(empty).not.toContainText("no default");

  // A repository-wide exception, then a nested one. The directory has to exist on disk: the
  // editor resolves the typed path to its repository first, which is exactly what makes
  // `/repo/packages/web` a storable override rather than a path that collapses to `/repo`.
  const nested = join(daemon.repo, "packages", "web");
  mkdirSync(nested, { recursive: true });
  for (const [path, command] of [[daemon.repo, "npm run test:ci"], [nested, "pnpm test"]] as const) {
    await dashboard.getByRole("combobox", { name: "Repository path" }).fill(path);
    await dashboard.getByLabel("Override command").fill(command);
    await dashboard.getByRole("button", { name: "Add override" }).click();
  }

  const rows = dashboard.locator(".wf-command-override-list li");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText(basename(daemon.repo));
  await expect(rows.nth(1)).toContainText(nested);

  // Nothing is stored until Save: one compare-and-swap carries the default and the whole
  // override list together, so the two halves can never be committed apart.
  expect(slotOf(await catalog(daemon), "test").overrides).toEqual([]);

  await dashboard.getByRole("button", { name: "Save Command" }).click();
  // Clean before anything else is asserted. Save is disabled exactly when the draft matches
  // the stored slot, so this is the editor saying the write came back - and it is also what
  // keeps the navigation below from waking the dirty-draft gate, which is doing its job.
  await expect(dashboard.getByRole("button", { name: "Save Command" })).toBeDisabled();
  await expect
    .poll(async () => slotOf(await catalog(daemon), "test"))
    .toMatchObject({
      defaultCommand: ["npm", "test"],
      overrides: [
        { repoRoot: daemon.repo, command: ["npm", "run", "test:ci"] },
        { repoRoot: nested, command: ["pnpm", "test"] },
      ],
    });

  await shoot(dashboard, "editor");

  // A reload proves this is stored rather than merely rendered, and that the route restores
  // the slot the address bar names.
  await dashboard.reload();
  await expect(dashboard.getByRole("heading", { name: "test", exact: true })).toBeVisible();
  await expect(dashboard.getByLabel("Default command")).toHaveValue("npm test");
  await expect(dashboard.locator(".wf-command-override-list li")).toHaveCount(2);

  // Navigating to another slot and back keeps the surface honest about which one is open.
  await dashboard.getByRole("button", { name: /^lint/ }).click();
  await expect.poll(async () => dashboard.evaluate(() => location.hash))
    .toBe("#/library/commands/lint");
  await expect(dashboard.getByLabel("Default command")).toHaveValue("");
  await dashboard.getByRole("button", { name: /^test/ }).click();
  await expect(dashboard.getByLabel("Default command")).toHaveValue("npm test");

  // Removing an exception is the other half of the atomic write: the daemon has to read a
  // SHORTER list as a deletion rather than merging it.
  await dashboard.locator(".wf-command-override-list li").nth(1)
    .getByRole("button", { name: "Remove" }).click();
  await expect(dashboard.locator(".wf-command-override-list li")).toHaveCount(1);
  await dashboard.getByRole("button", { name: "Save Command" }).click();
  await expect(dashboard.getByRole("button", { name: "Save Command" })).toBeDisabled();
  await expect
    .poll(async () => slotOf(await catalog(daemon), "test").overrides.map((o) => o.repoRoot))
    .toEqual([daemon.repo]);

  // The shelf card reads both facts at once, over the live stream.
  await dashboard.goto(`${daemon.baseURL}/#/library`);
  await expect(card(dashboard, "test")).toContainText("Global default · 1 override");
});

test("a hash naming another slot moves the editor, whether typed, followed or stepped to", async ({
  dashboard,
  daemon,
}) => {
  /*
   * The surface stays MOUNTED across these moves, which is the whole difficulty. Clicking a
   * rail row rewrites the hash through `replaceState` and builds no history entry, so the only
   * ways to reach a second `#/library/commands/<slot>` are the ones a person actually uses on
   * a bookmarkable page: pasting a link, following one, and stepping through history. In every
   * one of them React keeps the component and its state initializer does not run again - so an
   * editor that only reads the route at mount would go on showing `test` under an address bar
   * reading `lint`, and the link somebody pasted would open the wrong Command.
   */
  await dashboard.goto(`${daemon.baseURL}/#/library/commands/test`);
  await expect(dashboard.getByRole("heading", { name: "test", exact: true })).toBeVisible();

  // A pasted link, into the tab that is already here: same document, so nothing remounts.
  await dashboard.goto(`${daemon.baseURL}/#/library/commands/lint`);
  await expect(dashboard.getByRole("heading", { name: "lint", exact: true })).toBeVisible();
  await expect(dashboard.locator(".wf-command-list-item.active")).toContainText("lint");

  // Back and Forward across those two entries, which is the same move in both directions.
  await dashboard.goBack();
  await expect(dashboard.getByRole("heading", { name: "test", exact: true })).toBeVisible();
  await expect(dashboard.locator(".wf-command-list-item.active")).toContainText("test");
  await dashboard.goForward();
  await expect(dashboard.getByRole("heading", { name: "lint", exact: true })).toBeVisible();

  // A slot that does not exist is not a fifth Command. The route drops the segment, the
  // editor keeps whatever it had open rather than blanking, and the surface re-stamps the
  // address bar with what is actually on screen - so the pasted link resolves to a real
  // Command instead of leaving the two disagreeing.
  await dashboard.goto(`${daemon.baseURL}/#/library/commands/deploy`);
  await expect(dashboard.getByRole("heading", { name: "lint", exact: true })).toBeVisible();
  await expect.poll(async () => dashboard.evaluate(() => location.hash))
    .toBe("#/library/commands/lint");
});

test("a dirty draft holds a hash move to another slot, and the answer is honoured once", async ({
  dashboard,
  daemon,
}) => {
  // The router's gate already asks about a hash change that leaves a dirty draft, so the
  // editor must NOT ask a second time about a discard the operator has just answered for -
  // and it must actually move once they have.
  await dashboard.goto(`${daemon.baseURL}/#/library/commands/test`);
  await dashboard.getByLabel("Default command").fill("npm test");

  await dashboard.goto(`${daemon.baseURL}/#/library/commands/lint`);
  const gate = dashboard.getByRole("dialog", { name: "Leave with unsaved changes" });
  await expect(gate).toBeVisible();

  // Staying keeps both the slot and the typing.
  await gate.getByRole("button", { name: "Cancel" }).click();
  await expect(dashboard.getByRole("heading", { name: "test", exact: true })).toBeVisible();
  await expect(dashboard.getByLabel("Default command")).toHaveValue("npm test");
  await expect.poll(async () => dashboard.evaluate(() => location.hash))
    .toBe("#/library/commands/test");

  // Leaving anyway moves, discards, and raises no second dialog.
  await dashboard.goto(`${daemon.baseURL}/#/library/commands/lint`);
  await expect(gate).toBeVisible();
  await gate.getByRole("button", { name: "Discard and leave" }).click();
  await expect(dashboard.getByRole("heading", { name: "lint", exact: true })).toBeVisible();
  await expect(dashboard.getByLabel("Default command")).toHaveValue("");
  await expect(dashboard.getByRole("dialog")).toHaveCount(0);
});

test("a revision that lands while you are typing is surfaced, never silently applied", async ({
  dashboard,
  daemon,
}) => {
  // The failure this rules out is the one nobody notices: two windows open on one slot, and
  // the second save quietly replaces the first with a command nobody chose.
  await dashboard.goto(`${daemon.baseURL}/#/library/commands/lint`);
  await expect(dashboard.getByRole("heading", { name: "lint", exact: true })).toBeVisible();
  await dashboard.getByLabel("Default command").fill("npm run lint");

  // Somebody else saves the same slot. The draft here is dirty, so it must be held.
  const before = slotOf(await catalog(daemon), "lint");
  const written = await dashboard.request.put(
    `${daemon.baseURL}/api/workflow-commands/lint`,
    {
      data: {
        expectedRevision: before.revision,
        defaultCommand: ["eslint", "."],
        overrides: [],
      },
    },
  );
  expect(written.ok(), await written.text()).toBe(true);

  const conflict = dashboard.locator(".wf-command-conflict");
  await expect(conflict).toBeVisible();
  await expect(conflict).toContainText("Your typing has not been changed");
  // Untouched, which is the whole claim.
  await expect(dashboard.getByLabel("Default command")).toHaveValue("npm run lint");

  await shoot(dashboard, "conflict");

  // Adopting theirs replaces the draft, on the operator's own click rather than behind them.
  await conflict.getByRole("button", { name: "Load newer" }).click();
  await expect(dashboard.getByLabel("Default command")).toHaveValue("eslint .");
  await expect(conflict).toHaveCount(0);

  // And a clean editor DOES follow the stream: this is the same event, with nothing at stake.
  const current = slotOf(await catalog(daemon), "lint");
  await dashboard.request.put(`${daemon.baseURL}/api/workflow-commands/lint`, {
    data: {
      expectedRevision: current.revision,
      defaultCommand: ["eslint", "--max-warnings=0", "."],
      overrides: [],
    },
  });
  await expect(dashboard.getByLabel("Default command")).toHaveValue("eslint --max-warnings=0 .");
});

test("a refused save keeps its conflict until the stream actually catches up", async ({
  dashboard,
  daemon,
}) => {
  /*
   * A 409 is the SERVER saying a newer revision exists. The SSE view is a second, slower
   * answer to that same question, and the two must not be confused: until the stream delivers
   * the revision the refusal named, "the stream still agrees with my baseline" says nothing
   * about whether the conflict is over.
   *
   * Staged with a synthetic refusal naming a revision the daemon will never emit, which is
   * what a delayed or disconnected stream looks like from here - and then the operator does
   * the ordinary thing after a rejection: undoes their edit to reconsider. That flips the
   * draft clean, and it is the moment a conflict tied to the wrong comparison disappears -
   * leaving no way to load the newer revision and every retry refused again.
   */
  await dashboard.goto(`${daemon.baseURL}/#/library/commands/build`);
  await expect(dashboard.getByRole("heading", { name: "build", exact: true })).toBeVisible();

  await dashboard.route("**/api/workflow-commands/build", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: "This Command changed in another window",
        code: "workflow_command_revision_conflict",
        current: {
          slot: "build",
          defaultCommand: ["make", "release"],
          overrides: [],
          revision: 9,
          createdAt: 0,
          updatedAt: 0,
        },
      }),
    });
  });

  const field = dashboard.getByLabel("Default command");
  await field.fill("npm run build");
  await dashboard.getByRole("button", { name: "Save Command" }).click();

  const conflict = dashboard.locator(".wf-command-conflict");
  await expect(conflict).toBeVisible();
  await expect(conflict).toContainText("r9");

  // The move that used to lose it: undo the edit. The draft matches the stored slot again,
  // and the stream still holds the revision this editor started from - neither of which
  // retires a refusal the server issued.
  await field.fill("");
  await expect(field).toHaveValue("");
  await expect(conflict).toBeVisible();
  await expect(conflict.getByRole("button", { name: "Load newer" })).toBeVisible();

  // And it is still actionable: adopting the refusal's own view is what breaks the retry
  // loop, because the next save carries the revision the daemon actually holds.
  await conflict.getByRole("button", { name: "Load newer" }).click();
  await expect(field).toHaveValue("make release");
  await expect(conflict).toHaveCount(0);
});

test("the workflow palette says what the slot runs here, and links to it", async ({
  dashboard,
  daemon,
}) => {
  const created = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name: "Command palette spec",
    description: "One Command node, for the palette.",
  });

  await dashboard.goto(`${daemon.baseURL}/#/library/commands/typecheck`);
  await dashboard.getByLabel("Default command").fill("npm run typecheck");
  await dashboard.getByRole("button", { name: "Save Command" }).click();
  await expect(dashboard.getByRole("button", { name: "Save Command" })).toBeDisabled();
  await expect
    .poll(async () => slotOf(await catalog(daemon), "typecheck").defaultCommand)
    .toEqual(["npm", "run", "typecheck"]);

  await dashboard.goto(`${daemon.baseURL}/#/library/workflows/${created.workflow.id}`);
  await dashboard.getByRole("button", { name: "Graph", exact: true }).click();
  const palette = dashboard.getByRole("complementary", {
    name: "Workflow library and node palette",
  });
  await expect(palette).toBeVisible();

  // The word an operator reads is Command, on the button that creates the node.
  const slot = palette.getByLabel("Slot for new Command node");
  await expect(slot).toBeVisible();
  await slot.selectOption("typecheck");
  await expect(palette).toContainText("A global default is configured");
  // What a configured slot says, and the qualifier that keeps it honest: resolution is what
  // this catalog decides, and running is gated elsewhere.
  await expect(palette).toContainText("Running one also needs Commands allowed");
  await shoot(dashboard, "palette-configured");
  // An unconfigured slot is not a validation error - a portable workflow is meant to name one -
  // so the palette states the skip instead of refusing.
  await slot.selectOption("build");
  await expect(palette).toContainText("skips and passes with a note");
  await expect(palette.getByRole("link", { name: /Configure build in Library/ }))
    .toHaveAttribute("href", "#/library/commands/build");
  // The unconfigured arm carries no qualifier: nothing about authorization changes "there is
  // no command", so the skip is stated flatly.
  await expect(palette).not.toContainText("Running one also needs");

  await shoot(dashboard, "palette");

  await palette.getByRole("button", { name: "＋ Command" }).click();

  // The visible label is Command; the serialized node is still `kind: "check"`, which is the
  // contract every published version, run attempt and bookmark rests on.
  await expect(dashboard.getByLabel("Workflow graph")).toContainText("Command · build");
  await expect
    .poll(async () => {
      const detail = await api<{
        workflow: { draft: { nodes: Array<{ kind: string; slot?: string }> } };
      }>(daemon, `/api/workflows/${created.workflow.id}`);
      return detail.workflow.draft.nodes.filter((node) => node.kind === "check")
        .map((node) => node.slot);
    }, { message: "the palette must still persist the durable `check` node kind" })
    .toEqual(["build"]);

  await palette.getByRole("link", { name: /Configure build in Library/ }).click();
  await expect(dashboard.getByRole("complementary", { name: "Command library" })).toBeVisible();
  await expect.poll(async () => dashboard.evaluate(() => location.hash))
    .toBe("#/library/commands/build");
});

test("Settings keeps the authorization and the Trust summary, and no command table", async ({
  dashboard,
  daemon,
}) => {
  await dashboard.goto(`${daemon.baseURL}/#/settings/workflows`);

  // What stays: the machine-wide switch, its one safety sentence, and the grant summary.
  const authorization = dashboard.locator('.sc-card[data-anchor="workflows/checks"]');
  await expect(dashboard.getByRole("heading", { name: "Workflow Commands" })).toBeVisible();
  await expect(dashboard.getByLabel("Allow workflow Commands")).not.toBeChecked();
  await expect(dashboard.getByRole("main")).toContainText("It is not a sandbox.");
  await expect(dashboard.getByRole("main")).toContainText("Paused - every Command passes with a note");
  await expect(dashboard.getByRole("button", { name: "Manage in Trust" })).toBeVisible();

  // What goes: every control that authored a command. One catalog, one surface writing it.
  await expect(dashboard.getByRole("button", { name: "Add command" })).toHaveCount(0);
  await expect(dashboard.getByLabel("Command to run")).toHaveCount(0);
  await expect(dashboard.getByText("Check commands", { exact: true })).toHaveCount(0);

  // And the way to where they went, followed rather than merely present.
  await dashboard.getByRole("link", { name: "Open Commands in Library →" }).click();
  await expect(dashboard.getByRole("complementary", { name: "Command library" })).toBeVisible();
  // The surface opens on its default slot and says so in the address bar, exactly as the
  // Persona and Action surfaces do - the shelf hash is an entry point, not a resting state.
  await expect.poll(async () => dashboard.evaluate(() => location.hash))
    .toBe("#/library/commands/test");

  // The one confirmation, still asked, still naming what is actually authorized.
  await dashboard.goto(`${daemon.baseURL}/#/settings/workflows`);
  // Clicked on the track an operator actually hits: the checkbox under it is
  // `appearance: none` and `pointer-events: none`, so the label is the control.
  await authorization.locator("label.sc-switch").click();
  const confirm = dashboard.getByRole("dialog", { name: "Allow workflow Commands" });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("executes branch-authored code");
  await confirm.getByRole("button", { name: "Allow Commands" }).click();
  await expect
    .poll(async () => {
      const res = await fetch(`${daemon.baseURL}/api/workflows/config`);
      return ((await res.json()) as { checksEnabled: boolean }).checksEnabled;
    })
    .toBe(true);
  await expect(dashboard.getByText("Allowed - a Command runs branch-authored code")).toBeVisible();
});
