import { mkdirSync } from "node:fs";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { withDaemonDb } from "../fixtures/daemon-db.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * What a blocked run is CALLED, everywhere a person meets one.
 *
 * The reported incident: a No-Mistakes Review run stopped 1.27 seconds after it started, the
 * daemon wrote an exact human sentence into its gate state, and every surface an operator
 * scans answered "image evidence capture" - the name of a pipeline stage. Twelve of the
 * twenty-seven phases a run can block in were in that state, because `blockedPhaseClause`
 * falls back to `phase.replaceAll("_", " ")` and the fallback is silent: it is grammatical,
 * lower-case and the right length, so a missing clause looks exactly like a deliberate one.
 *
 * Only this layer can see the whole path. The clause map's unit test proves the vocabulary,
 * `line-review-groups.test.ts` proves the fold picks it up, and neither can tell whether the
 * phase column survives the daemon's own run-summary query, rides the SSE frame, and reaches
 * the two shapes the drawer renders - a bar for a pile and a row for a single run. A build
 * that named every phase perfectly and published the raw phase on the wire would pass every
 * unit test in the repository and show an operator the same code it always did.
 *
 * Both shapes are asserted for that reason, and each in both directions: the cause is present
 * AND the identifier it replaced is nowhere in the drawer. Asserting only the presence would
 * pass on a build that printed both.
 *
 * The states are seeded while the daemon is down and picked up by its own boot, which is the
 * cheap half of this spec: `initializeWorkflowRuns` reads the table once at startup, so a row
 * written behind a LIVE daemon would never reach the registry. Everything downstream of the
 * seed - the summary query, the fold, the SSE frame, the drawer - stays real.
 *
 * No model tokens: nothing here dispatches an agent or runs a Persona. The workflow is
 * published and never submitted.
 *
 * One consequence of seeding a skeleton run worth knowing before reading a failure here: with
 * no `intent_json` and no submissions, run detail draws its "Captured intent and evidence are
 * corrupt" notice and its header sentence comes from `resubmitAvailability`'s refusal rather
 * than from `runNoMoveReason`'s clause fallback. Neither is under test and neither prints a
 * phase code, which is why the run-detail assertion below is the negative one.
 */

const EVIDENCE = artifactsDir("line-blocked-phase-vocabulary");

/** The pile, and the phase the reported run actually stopped on. */
const PILED_PHASE = "image_evidence_capture";
const PILED_CLAUSE = "registered evidence refused";
/** The single row, and the phase a second run in the operator's own state database sits on. */
const LONE_PHASE = "preflight_refinement_exhausted";
const LONE_CLAUSE = "out of evidence refinements";

/** What each phase rendered as before it had a clause - the text that must now be absent. */
const fallback = (phase: string): string => phase.replaceAll("_", " ");

async function api<T>(daemon: DaemonHandle, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseURL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

/**
 * Photograph a state this spec has already asserted on.
 *
 * Behind `MC_E2E_EVIDENCE` for the reason every other capture in the suite is: an ordinary run
 * would rewrite a binary for no added signal. Inside the regression test rather than in a
 * staged walk, because the point of the picture is that the assertions around it passed on the
 * same run.
 */
async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  // Off every control first: `Tooltip` portals a bubble under a resting pointer, and the
  // drawer is a column of adjacent buttons.
  await page.mouse.move(0, 0);
  const line = page.getByRole("navigation", { name: "The Line" });
  const box = await line.boundingBox();
  const drawer = page.locator(".line-drawer").first();
  const drawerBox = (await drawer.count()) > 0 ? await drawer.boundingBox() : null;
  const bottom = drawerBox
    ? drawerBox.y + drawerBox.height
    : (box?.y ?? 0) + (box?.height ?? 0);
  // The viewport's own width, not a constant: one case widens the window to show that the
  // clause is laid out rather than merely labelled, and a hardcoded 1280 would crop the
  // picture at exactly the point it exists to show.
  const width = page.viewportSize()?.width ?? 1280;
  await page.screenshot({
    path: `${EVIDENCE}${name}.png`,
    ...(box ? { clip: { x: 0, y: box.y - 8, width, height: bottom - box.y + 16 } } : {}),
  });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/line-blocked-phase-vocabulary/${name}.png`);
}

/**
 * The same capture, unclipped.
 *
 * The palette is a centred dialog rather than a band under the strip, so there is no strip to
 * measure and clip against - the subject is the whole screen.
 */
async function shootPage(page: Page, name: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${EVIDENCE}${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/line-blocked-phase-vocabulary/${name}.png`);
}

/** A published version to hang bindings off, reached the way an operator reaches one. */
async function publishWorkflow(daemon: DaemonHandle, name: string): Promise<string> {
  const persona = await api<{ id: string }>(daemon, "/api/personas", {
    name: `${name} reviewer`,
    // Never invoked - this workflow is published and never submitted - but a persona node
    // needs a real persona id, and the marker keeps it inert if a later edit ever does submit.
    guidanceMarkdown: `# ${name} reviewer\n\nE2E_FAIL_VERDICT`,
  });
  const workflow = await api<{ workflow: { id: string } }>(daemon, "/api/workflows", {
    name,
    draft: {
      nodes: [
        { id: "session", kind: "session", position: { x: 0, y: 0 } },
        { id: "reviewer", kind: "persona", personaId: persona.id, position: { x: 220, y: 0 } },
        { id: "end", kind: "end", outcome: "Approved", position: { x: 440, y: 0 } },
      ],
      edges: [
        { id: "submit", source: "session", sourcePort: "submitted", target: "reviewer", targetPort: "activate" },
        { id: "pass", source: "reviewer", sourcePort: "pass", target: "end", targetPort: "terminal" },
        { id: "fail", source: "reviewer", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
      ],
    },
  });
  const published = await api<{ version: { id: string } }>(
    daemon,
    `/api/workflows/${workflow.workflow.id}/publish`,
    { expectedDraftRevision: 1 },
  );
  return published.version.id;
}

/**
 * One binding and its blocked runs, written into the stopped daemon's own database.
 *
 * `paused` rather than `active`, because that is what the state actually is: every phase
 * seeded here is reached with the binding no longer working, and an `active` binding naming a
 * session that does not exist is a lifecycle combination the daemon never writes.
 */
interface Seed {
  /** The run id, which also names its binding and its trigger key. */
  id: string;
  /** The phase it is blocked in - the whole point of the fixture. */
  phase: string;
  /** The captured session name the rows are told apart by. */
  sessionName: string;
}

function seedBlockedRuns(
  daemon: DaemonHandle,
  versionId: string,
  seeds: Seed[],
): void {
  const now = Date.now();
  withDaemonDb(daemon, (db) => {
    db.prepare(`
      INSERT INTO workflow_bindings (
        id, workflow_version_id, note_key, session_agent, session_name, repo_root,
        trigger_mode, delivery_mode, state, max_repair_rounds, created_at, updated_at
      ) VALUES (?, ?, ?, 'claude', ?, ?, 'manual', 'preview', 'paused', 3, ?, ?)
    `).run("vocab-binding", versionId, "vocab:note", "Vocabulary session", daemon.repo, now, now);
    for (const [index, seed] of seeds.entries()) {
      db.prepare(`
        INSERT INTO workflow_bindings (
          id, workflow_version_id, note_key, session_agent, session_name, repo_root,
          trigger_mode, delivery_mode, state, max_repair_rounds, created_at, updated_at
        ) VALUES (?, ?, ?, 'claude', ?, ?, 'manual', 'preview', 'paused', 3, ?, ?)
      `).run(
        `vocab-binding-${seed.id}`,
        versionId,
        `vocab:note:${seed.id}`,
        seed.sessionName,
        daemon.repo,
        now,
        now,
      );
      db.prepare(`
        INSERT INTO workflow_runs (
          id, binding_id, workflow_version_id, status, current_phase, max_repair_rounds,
          trigger_source, trigger_key, started_at, updated_at, completed_at
        ) VALUES (?, ?, ?, 'blocked', ?, 3, 'manual', ?, ?, ?, NULL)
      `).run(
        seed.id,
        `vocab-binding-${seed.id}`,
        versionId,
        seed.phase,
        `vocab-trigger-${seed.id}`,
        now,
        // Descending, so the drawer's newest-first order is the one this spec asserts in.
        now - index,
      );
    }
  });
}

const stage = (page: Page, name: string): Locator =>
  page.getByRole("navigation", { name: "The Line" })
    .getByRole("button", { name: new RegExp(`^${name},`) });

const drawer = (page: Page, name: string): Locator =>
  page.getByRole("region", { name: `${name} drawer` });

/**
 * Blocked runs on this daemon, loaded by its own boot, with the wire checked first.
 *
 * The daemon's own answer is polled before any browser assertion so that a failure separates
 * "the rows were never loaded" from "the browser never heard about them" - two very different
 * bugs that look identical in the DOM.
 */
async function seedRuns(daemon: DaemonHandle, seeds: Seed[]): Promise<void> {
  const versionId = await publishWorkflow(daemon, "Vocabulary review");

  await daemon.crash();
  seedBlockedRuns(daemon, versionId, seeds);
  await daemon.restart();

  const expected = seeds.map((seed) => `blocked:${seed.phase}`).sort();
  await expect.poll(async () => {
    const page = await api<{ items: Array<{ id: string; status: string; phase: string }> }>(
      daemon,
      "/api/workflow-runs",
    );
    return page.items
      .filter((run) => run.id.startsWith("vocab-"))
      .map((run) => `${run.status}:${run.phase}`)
      .sort();
  }, { timeout: 60_000 }).toEqual(expected);
}

/**
 * The mixed fleet: a pile of three sharing one cause, and one run stopped for another.
 *
 * Three is `REVIEW_GROUP_MIN`, so the pile folds into a bar while the fourth stays a row -
 * the drawer's two shapes read the same field through different code, and one assertion
 * cannot cover both. Two DISTINCT causes is also what makes the strip's honest-plural case
 * reachable; `SINGLE_CAUSE_FLEET` below covers the other half of that rule.
 */
const MIXED_FLEET: Seed[] = [
  { id: "vocab-img-1", phase: PILED_PHASE, sessionName: "Evidence one" },
  { id: "vocab-img-2", phase: PILED_PHASE, sessionName: "Evidence two" },
  { id: "vocab-img-3", phase: PILED_PHASE, sessionName: "Evidence three" },
  { id: "vocab-preflight", phase: LONE_PHASE, sessionName: "Preflight one" },
];

/** Every stopped run stopped for one reason, which is the case the strip can name outright. */
const SINGLE_CAUSE_FLEET: Seed[] = [
  { id: "vocab-img-1", phase: PILED_PHASE, sessionName: "Evidence one" },
  { id: "vocab-img-2", phase: PILED_PHASE, sessionName: "Evidence two" },
  { id: "vocab-img-3", phase: PILED_PHASE, sessionName: "Evidence three" },
];

test("a blocked run is named by its cause in the Review drawer, never by its phase code", async ({
  dashboard,
  daemon,
}) => {
  await seedRuns(daemon, MIXED_FLEET);

  await dashboard.reload();

  /*
   * ---- the Line strip, the first of the four named surfaces ----
   *
   * `foldReview` names the causes beside the number of stopped runs, and this fleet holds two
   * of them - so what the strip owes here is the HONEST PLURAL. It deliberately refuses to
   * name the commonest cause when there are several: "4 stalled - registered evidence
   * refused" would be a false statement about the fourth run, and the move that sentence
   * invites (dismiss the pile) is exactly the wrong one. The single-cause case, where the
   * clause itself is printed, is the last test in this file.
   *
   * The daemon words this one, which is only possible because the clause map now lives in
   * `@shared/` - the fold runs in `src/server/`.
   */
  const review = stage(dashboard, "Review");
  await expect(review).toBeVisible();
  await expect(review).toHaveAttribute("aria-label", /4 stalled/, { timeout: 60_000 });
  await expect(review).toContainText("Vocabulary review v1");
  await expect(review.locator(".ls-sub")).toHaveText(/^2 causes · /);
  await expect(review).not.toContainText(fallback(PILED_PHASE));
  await expect(review).not.toContainText(fallback(LONE_PHASE));
  // And the strip is the route to the surface that names each of those causes, which is the
  // half of the claim a screenshot of the strip alone could not make.
  await review.click();
  const panel = drawer(dashboard, "Review");
  await expect(panel).toBeVisible();

  // ---- the pile: one bar, naming the cause once ----
  //
  // Selected through the caret's accessible name rather than the visible text, because that
  // name is what a screen reader is handed and it is built from the same clause - a build that
  // fixed only the visible label would pass a text assertion and still read the phase code out
  // loud.
  const bar = panel.getByRole("button", { name: `3 runs blocked, ${PILED_CLAUSE}` });
  await expect(bar).toBeVisible();
  await expect(panel.locator(".line-group-who")).toContainText(`3 runs · ${PILED_CLAUSE}`);

  // ---- the single run: a row, through the other code path ----
  const row = panel.locator(".line-run-row", { hasText: "Preflight one" });
  await expect(row).toHaveCount(1);
  await expect(row.locator(".line-run-state")).toHaveText(`Blocked · ${LONE_CLAUSE}`);

  // ---- and the identifiers they replaced are nowhere a person can read them ----
  //
  // The half that makes this a regression test. Both phases printed their own code here for
  // every release before this one, and a build that added the clause beside the code rather
  // than in place of it would satisfy every assertion above.
  await expect(panel).not.toContainText(fallback(PILED_PHASE));
  await expect(panel).not.toContainText(fallback(LONE_PHASE));

  await shoot(dashboard, "drawer-names-the-cause");

  // Expanding the bar produces the three rows it folded, and each of them says the cause too -
  // the row and the bar read the same field through different code, so an expanded pile is
  // where the two could disagree.
  await bar.click();
  const members = panel.locator(".line-run-row.is-member");
  await expect(members).toHaveCount(3);
  for (let index = 0; index < 3; index += 1) {
    await expect(members.nth(index).locator(".line-run-state"))
      .toHaveText(`Blocked · ${PILED_CLAUSE}`);
  }
  await expect(panel).not.toContainText(fallback(PILED_PHASE));
  await shoot(dashboard, "drawer-expanded-members");
});

/**
 * The Runs rail, the third of the four named surfaces, and the palette beside it.
 *
 * The rail's row is the one an operator scans when they open the Runs page, and until this
 * change its whole account of a stopped run was the word "Blocked" - true of every stopped
 * run at once, so a rail of them was a column of one word and a reader who had to open each
 * in turn to find out which was theirs. It now carries the cause under the chip.
 *
 * Only this layer can see it. The rail's rows are built from a fetched page held in component
 * state, so no markup test can render one without standing up the route it reads; and the
 * clause has to survive the run-summary query and the SSE frame to get there at all.
 *
 * The palette is in the same case because it is the other renderer of `run-model.ts:2692`
 * (`runTriageSentence`) - the line the source plan attributes to this surface - and because
 * it is the row that takes a reader from a search to the run. Asserting one and not the other
 * would leave the two able to disagree about one field.
 */
test("the Runs rail names the cause under the chip, and the palette row agrees", async ({
  dashboard,
  daemon,
}) => {
  await seedRuns(daemon, MIXED_FLEET);
  await dashboard.reload();

  // ---- the rail ----
  await dashboard.goto(`${daemon.baseURL}/#/runs`);
  const rail = dashboard.getByRole("list", { name: "Workflow runs" });
  await expect(rail.getByRole("listitem")).toHaveCount(4, { timeout: 60_000 });

  // The note key is what tells the four rows apart - they share a workflow, and none of them
  // has a live session to be named after.
  const railRow = rail.getByRole("listitem").filter({ hasText: "vocab:note:vocab-preflight" });
  await expect(railRow).toHaveCount(1);
  await expect(railRow).toContainText("Vocabulary review");
  // THAT it stopped, then WHY. The chip is unchanged; the clause is the new line beside it.
  await expect(railRow).toContainText("Blocked");
  await expect(railRow.locator(".wf-run-row-why")).toHaveText(LONE_CLAUSE);

  // Counted across the whole rail, because the fleet's other three stopped for a different
  // reason and a row that printed one pile's cause on another's would be worse than the word
  // it replaced.
  await expect(rail.locator(".wf-run-row-why").filter({ hasText: PILED_CLAUSE })).toHaveCount(3);
  await expect(rail.locator(".wf-run-row-why")).toHaveCount(4);
  await expect(rail).not.toContainText(fallback(LONE_PHASE));
  await expect(rail).not.toContainText(fallback(PILED_PHASE));

  await shootPage(dashboard, "runs-rail-names-the-cause");

  // The clause is in the row's ACCESSIBLE name too, not merely painted into it: the row is a
  // button labelled by its own content, so a reader who never sees the colour still hears why.
  await expect(
    rail.getByRole("button", { name: new RegExp(LONE_CLAUSE) }),
  ).toHaveCount(1);

  // Opening the run leaves the reader on a page that decodes nothing either: run detail
  // renders `currentPhase` in exactly one place and it is a comparison, never text.
  await railRow.getByRole("button").click();
  await expect(dashboard.getByRole("heading", { name: /Vocabulary review/ }).first())
    .toBeVisible({ timeout: 40_000 });
  await expect(dashboard.locator(".wf-run-reader")).not.toContainText(fallback(LONE_PHASE));

  // ---- the palette, which is the other `runTriageSentence` renderer ----
  //
  // `Meta+k` and not `ControlOrMeta+k`: `chordFromEvent` derives the Command modifier from
  // `e.metaKey` alone, so the ControlOrMeta spelling arrives as "ctrl+k" on Linux and matches
  // nothing. See the note in `palette.spec.ts`.
  await dashboard.keyboard.press("Meta+k");
  const palette = dashboard.getByRole("dialog", { name: "Search everything" });
  await expect(palette).toBeVisible();
  await dashboard.getByRole("combobox", { name: "Search everything" }).fill("Vocabulary");

  // Counted rather than matched one at a time: all four rows carry the same title, so the
  // clause is the only thing that tells them apart - which is exactly the reader's problem
  // this phase exists to fix.
  const options = palette.getByRole("option");
  await expect(options.filter({ hasText: `Blocked · ${PILED_CLAUSE}` })).toHaveCount(3);
  await expect(options.filter({ hasText: `Blocked · ${LONE_CLAUSE}` })).toHaveCount(1);
  await expect(palette).not.toContainText(fallback(PILED_PHASE));
  await expect(palette).not.toContainText(fallback(LONE_PHASE));

  await shootPage(dashboard, "palette-names-the-cause");
});

/**
 * The strip's other half: one cause, said outright.
 *
 * `blockedCause` has two answers and the mixed fleet above only reaches one of them. This is
 * the headline case and the one the reported incident would have produced - every stopped run
 * stopped for the same reason, so the strip can state it rather than count it, and an operator
 * scanning the fleet's permanent header learns what happened without opening anything.
 *
 * Its own fleet rather than a filter over the one above, because the rule is a property of the
 * whole set of blocked runs and cannot be reached by looking at a subset of a mixed one.
 */
test("the Line strip states the cause outright when every stopped run shares one", async ({
  dashboard,
  daemon,
}) => {
  await seedRuns(daemon, SINGLE_CAUSE_FLEET);
  await dashboard.reload();

  const review = stage(dashboard, "Review");
  await expect(review).toBeVisible();
  const sub = review.locator(".ls-sub");
  // The cause LEADS the line. `.ls-sub` is one `nowrap` line with `text-overflow: ellipsis`,
  // so position decides what a person actually reads: whatever is last is read by nobody, and
  // "3 stalled" has been falling off the end of this sentence for as long as it has been in
  // it. Leading is what puts the cause inside the visible run of characters at every width.
  await expect(sub).toHaveText(new RegExp(`^${PILED_CLAUSE} · `), { timeout: 60_000 });
  await expect(review).toContainText("3 stalled");
  // It does not hedge when it does not have to: "causes" is the mixed fleet's answer.
  await expect(review).not.toContainText("causes");
  await expect(review).not.toContainText(fallback(PILED_PHASE));

  /*
   * The whole clause is REACHABLE at every width, not merely present in the DOM.
   *
   * Two independent routes, because at six stages on a 1280px window a stage cell is about
   * 150px and this clause needs about 203px - so at the default width the line genuinely is
   * clipped, exactly as every other stage sentence on this strip is. Asserting `toHaveText`
   * and stopping there would be the hollow version of this test: it passes on a string the
   * browser has painted out of sight.
   */
  await expect(review).toHaveAttribute("aria-label", new RegExp(`${PILED_CLAUSE}, `));
  await expect(review).toHaveAccessibleDescription(new RegExp(PILED_CLAUSE));

  /*
   * And it is laid out, not just labelled: widen the window and the clause is measurably
   * inside the cell that draws it.
   *
   * A measurement rather than a screenshot diff, and it is the assertion that would fail if
   * the clause went back to the end of the sentence - at this width the workflow name and
   * both attention parts sit in front of it, and the ellipsis would land mid-clause.
   */
  await dashboard.setViewportSize({ width: 2400, height: 900 });
  await expect.poll(async () => await sub.evaluate((node) => {
    const probe = node.ownerDocument.createElement("span");
    probe.textContent = node.textContent?.split(" · ")[0] ?? "";
    probe.style.cssText =
      `font: ${getComputedStyle(node).font}; position: absolute; white-space: nowrap; visibility: hidden`;
    node.ownerDocument.body.append(probe);
    const needed = probe.getBoundingClientRect().width;
    probe.remove();
    return Math.ceil(needed) <= Math.floor(node.getBoundingClientRect().width);
  })).toBe(true);

  await shoot(dashboard, "strip-states-the-cause");
});
