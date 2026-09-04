import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * The conversation header stays on ONE row, and the review button is on it at every width.
 *
 * The defect: the header is a wrapping flex row and the identity block was `flex: 1 1 auto`,
 * so flex line-breaking placed it at the session NAME'S max-content width. A long name filled
 * the first line by itself and pushed the entire runtime cluster - mode, model, effort,
 * context, cost - onto a second row, which comes straight off the conversation underneath.
 * The name was then shrunk and ellipsed, so the row that caused the wrap looked innocent.
 *
 * This is the only layer that can see any of it. `detail-head-ladder.test.ts` beside it reads
 * the stylesheet and can prove a rung is well formed, that the base size is zero and that no
 * rung hides the badge - but not that the row then FITS, at a real width, on a real session,
 * with a real rail beside it. Row count and reading order are laid-out facts.
 *
 * Two claims, and the second is the operator's actual requirement:
 *
 * - At every width the header is on one row, or has already spent every rung it has.
 * - The review button is DRAWN at every one of those widths. It is the one control here that
 *   says an agent has stopped dead waiting on a person, so the ladder is allowed to make it
 *   smaller and never allowed to hide it - while the estimates, the model pill and the two
 *   pickers are given up, in that order, because the board's card draws all of them.
 */

const EVIDENCE = artifactsDir("console-header-one-row");

/**
 * A long name AND a long objective, which are two different cases.
 *
 * The name is the one that wrapped, and it is given explicitly because a blank title is
 * summarized by the model - and the fake answers `E2E Mock Session` for every prompt, which is
 * short enough to fit and would pass against the defect. (The daemon caps a session name at 60
 * characters, so the drawn name is shorter than this string.)
 *
 * The objective is the second case, and it is long on purpose. It is drawn UNDER the name
 * inside the same identity block, so anything it contributes to that block's intrinsic width
 * would widen the cap that keeps the block down to the name - and push the chips that belong
 * beside the name across the row. `GOAL_MAX_CHARS` bounds it at 180, and this is most of that.
 */
const TASK = {
  title: "Investigate and plan adding herdr as a new supported multiplexer to mission control",
  intent:
    "leverage the existing cmux and tmux adapters, survey where the pane capture layer assumes " +
    "one of them, and write the plan up beside the multiplexer notes it belongs with",
};

const QUESTION = {
  kind: "input",
  title: "Which multiplexer adapter should herdr borrow from?",
  body: "Which multiplexer adapter should herdr borrow from?",
  decisions: [
    {
      id: "q",
      question: "Which multiplexer adapter should herdr borrow from?",
      options: [
        { id: "o0", label: "The cmux adapter", recommended: true },
        { id: "o1", label: "The tmux adapter" },
      ],
      allowOther: false,
    },
  ],
};

/** Launch one agent and wait for the fleet to have adopted its card. */
async function dispatch(page: Page, daemon: DaemonHandle): Promise<void> {
  await page.getByRole("button", { name: "Dispatch" }).click();
  const dialog = page.getByRole("dialog", { name: "Dispatch an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("search repos or type a path…").fill(daemon.repo);
  // The repo combobox portals its listbox over the Task field and reopens on every keystroke;
  // without this the next fill lands on a covered control. Its own handler stops propagation,
  // so this closes the list rather than the modal.
  await page.keyboard.press("Escape");
  await dialog.getByPlaceholder("What should this agent do?").fill(TASK.intent);
  // The title lives inside the Backlog details fold, which a fresh dispatch opens closed. The
  // summary line is part of the control's accessible name, so this cannot be `exact`.
  await dialog.getByRole("button", { name: /Backlog details/ }).click();
  await dialog.getByPlaceholder("summarized from the task if left blank").fill(TASK.title);
  await dialog
    .locator("select")
    .filter({ hasText: "finish without a Workflow" })
    .selectOption("__none");
  await dialog.getByRole("button", { name: "Dispatch now" }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row"),
  ).toHaveCount(1);
}

/**
 * Ask a question the way the agent's MCP child does, so the header carries a review BUTTON.
 *
 * Posted over HTTP rather than scripted into the fake agent, because the review channel IS an
 * HTTP route (`src/mcp/server.ts` performs exactly this POST), and going through it keeps the
 * spec honest about the contract while every agent binary stays a cost-free fake.
 */
async function ask(daemon: DaemonHandle, cwd: string): Promise<void> {
  const token = readFileSync(join(daemon.home, "token"), "utf8").trim();
  const res = await fetch(`${daemon.baseURL}/mcp/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({ env: {}, cwd, ...QUESTION }),
  });
  expect(res.status, `the review channel accepted the question: ${await res.clone().text()}`)
    .toBe(200);
}

/**
 * The checkout the daemon cut, once the session has one to bind a review to.
 *
 * Polled rather than read once: a card is on screen before the registry has necessarily
 * finished adopting the worktree it was cut into, so a single read is intermittently empty.
 */
async function checkout(daemon: DaemonHandle): Promise<string> {
  let found = "";
  await expect
    .poll(
      async () => {
        const all = (await (await fetch(`${daemon.baseURL}/api/sessions`)).json()) as Array<{
          cwd: string | null;
        }>;
        found = all.find((s) => s.cwd)?.cwd ?? "";
        return found;
      },
      { message: "the dispatched session should have a checkout" },
    )
    .not.toBe("");
  return found;
}

/**
 * The pieces of the header this spec reads, by the class the ladder acts on.
 *
 * Read as WIDTHS rather than with `toBeVisible`, because a shed word keeps a 1x1
 * visually-hidden box so it can hold on to its accessible name - and Playwright counts that
 * box as visible, so `toBeVisible` cannot tell a collapsed control from a drawn one. A missing
 * element reads as 0 and a clipped one as 1, so `> 2` is "actually drawn" for both.
 */
const PARTS = {
  review: ".badge-btn",
  keycap: ".badge-btn .kb-hint",
  arrow: ".badge-go",
  name: ".detail-title h2",
  runtimeWord: ".runtime-name",
  runtimeMark: ".runtime-glyph",
  effort: ".rt-think",
  effortWord: ".rt-think-word",
  effortMark: ".rt-think-glyph",
  model: ".rt-model",
  mode: ".mode",
  cost: ".cost-chip",
  context: ".rt-ctx",
  contextNum: ".rt-ctx-num",
} as const;

interface Head {
  /** How many rows the header's controls are laid out on. */
  rows: number;
  /** The rungs currently applied, e.g. `1 2 3`. */
  rung: string;
  /** The room the row has, and how much text it is carrying - the fit's two guards. */
  container: number;
  textLength: number;
  /** Laid-out width of each of `PARTS`, read in the same pass. */
  width: Record<keyof typeof PARTS, number>;
  /**
   * Where the identity block ends, and where the last thing INSIDE it ends. Equal means the
   * block is exactly as wide as what it draws; a block wider than its own content has taken
   * free space it did not need, and everything after it has been pushed across the row.
   */
  edges: { titleRight: number; contentRight: number };
}

/**
 * Read the header after letting the fit run.
 *
 * The wait is not slack. `ResizeObserver` delivers after layout and before paint, so a sample
 * taken between a viewport change and that delivery catches a header the operator never sees -
 * which reads as an intermittent two-row failure at scattered widths.
 *
 * Every width is read in ONE pass in the page rather than through a locator per part. Not only
 * for speed across a 68-sample sweep: `boundingBox()` auto-waits for an element to exist, so a
 * part this session never reported would spend the whole action timeout before answering, and
 * this spec deliberately asks about parts that may be absent.
 */
async function readHead(page: Page): Promise<Head> {
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
  return (await page.evaluate((parts: Record<string, string>) => {
    const row = document.querySelector("header.detail-head") as HTMLElement;
    const style = getComputedStyle(row);
    const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    // One row is as tall as the tallest control on it, which here is the two-line identity
    // block. A second row costs the 10px row-gap plus a whole chip, so this is never a close
    // call. The same comparison `measuredLadder.ts` makes, deliberately: a spec that measured
    // it differently could disagree with the fit it is checking.
    const tallest = Math.max(0, ...[...row.children].map((k) => (k as HTMLElement).offsetHeight));
    const width: Record<string, number> = {};
    for (const [key, selector] of Object.entries(parts)) {
      width[key] = (row.querySelector(selector) as HTMLElement | null)?.offsetWidth ?? 0;
    }
    const rect = (selector: string): DOMRect | null =>
      (row.querySelector(selector) as HTMLElement | null)?.getBoundingClientRect() ?? null;
    const title = rect(".detail-title");
    // The last element of the block's own top line, whatever the session is: `SessionWhere`
    // always draws a `.name-source`, as the Agent SDK pill or as the pane it lives in.
    const content = rect(".detail-title .name-source");
    return {
      rows: row.clientHeight - padY > tallest + 2 ? 2 : 1,
      rung: row.dataset.rung ?? "",
      container: Math.round(
        row.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      ),
      textLength: (row.textContent ?? "").length,
      width,
      edges: {
        titleRight: Math.round(title?.right ?? 0),
        contentRight: Math.round(content?.right ?? 0),
      },
    };
  }, PARTS as unknown as Record<string, string>)) as Head;
}

/** Whether a part is actually DRAWN - see `PARTS`. */
function drawn(state: Head, part: keyof typeof PARTS): boolean {
  return state.width[part] > 2;
}

/**
 * One reviewer-facing frame of the header, only when capture is asked for.
 *
 * The pointer is parked first: `Tooltip` portals a bubble under a resting pointer, and a shot
 * taken with one open photographs the bubble rather than the row.
 */
async function shot(page: Page, head: Locator, name: string, observed: string): Promise<void> {
  if (!process.env.MC_E2E_EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.mouse.move(0, 0);
  await head.screenshot({ path: EVIDENCE + name + ".png" });
  // eslint-disable-next-line no-console
  console.log(`OBSERVED ${observed}`);
  // eslint-disable-next-line no-console
  console.log(`CAPTURED e2e/.artifacts/console-header-one-row/${name}.png`);
}

/** Step the window down until the header has spent `rung`, and report where that was. */
async function narrowUntilRung(page: Page, rung: string): Promise<Head> {
  for (let width = 1500; width >= 560; width -= 20) {
    await page.setViewportSize({ width, height: 900 });
    const state = await readHead(page);
    if (state.rung.split(" ").includes(rung)) return state;
  }
  throw new Error(`no window from 1500px down to 560px put this header on rung ${rung}`);
}

/** The dispatched session, selected in the console rail, with a review waiting on it. */
async function asking(page: Page, daemon: DaemonHandle): Promise<Locator> {
  await dispatch(page, daemon);
  await ask(daemon, await checkout(daemon));

  await page.getByRole("navigation", { name: "Sessions" }).locator("button.rail-row").first()
    .click();
  const head = page.locator("header.detail-head");
  await expect(head).toBeVisible();
  // The badge appearing is the fleet having heard about the review; without it this spec would
  // be measuring a header that never had the control it is about.
  await expect(head.getByRole("button", { name: "to review" })).toBeVisible({ timeout: 15_000 });
  // And the runtime cluster is really on the row, so the sheds below shed something.
  //
  // All three waited on, not just the model: each of these arrives on its own SSE frame after
  // the card does, and the ladder's whole reason for being MEASURED is that its answer changes
  // when they land. A spec that read the header before they did would be measuring a narrower
  // row than the one an operator sees, and asserting a shed on a chip that was not there yet.
  // The context meter is deliberately not here - the fake reports no context percentage, and
  // the sweep's order check skips a part this session never had.
  for (const part of [".rt-model", ".rt-think", ".cost-chip"]) {
    await expect(head.locator(part), `the header should carry ${part}`).toBeVisible({
      timeout: 30_000,
    });
  }
  return head;
}

test("a long-named session keeps its header on one row at the width it stacked at", async ({
  dashboard,
  daemon,
}) => {
  const head = await asking(dashboard, daemon);

  // The reported width. The screenshot came from a ~1230px conversation pane, which in the
  // console layout is a ~1560px window once the rail beside it is paid for.
  await dashboard.setViewportSize({ width: 1560, height: 900 });
  const state = await readHead(dashboard);

  // Photographed BEFORE the assertion, so the same command run against the commit this fixes
  // produces the two-row frame rather than stopping at a red assertion with nothing to look
  // at. "One row" is checkable in the DOM as a height; it is only legible as a header here.
  await shot(
    dashboard,
    head,
    "header-1560",
    `the 1560px header is on ${state.rows} row(s) at rung "${state.rung}"`,
  );

  expect(state.rows, `the header wrapped to ${state.rows} rows`).toBe(1);

  // And it is on one row because everything FITS, not because the ladder stripped the row bare
  // at a width that never needed it: nothing is shed here at all, and every part of the cluster
  // the defect pushed onto a second row is drawn on the first one.
  expect(state.rung, "the ladder spent a rung at a width that did not need one").toBe("");
  for (const part of ["review", "name", "model", "mode", "effort", "cost"] as const) {
    expect(drawn(state, part), `\`${PARTS[part]}\` is not drawn at the reported width`).toBe(true);
  }

  // And the identity block ends where its content ends, which is the claim the `max-content`
  // cap exists for and the one thing here that is not about wrapping.
  //
  // Two ways for it to fail, and this session is built to catch both. The block grows at 1000
  // against the spacer's 1, so WITHOUT the cap it takes every pixel of free space and pushes
  // the chips that belong beside the name across to the far side of the row. And the objective
  // is drawn INSIDE the block, at near the 180 characters `GOAL_MAX_CHARS` allows, so anything
  // it contributed to the block's intrinsic width would raise the cap above the name and do the
  // same thing more subtly - on some sessions and not others.
  //
  // A pixel of tolerance for sub-pixel layout, and no layout constant: the assertion is that
  // the two edges are the SAME edge, which holds on any font stack.
  const surplus = state.edges.titleRight - state.edges.contentRight;
  expect(
    surplus,
    `the identity block is ${surplus}px wider than the name and runtime chip it draws, so it ` +
      `took free space it did not need and everything after it has been pushed across the row`,
  ).toBeLessThanOrEqual(1);
});

test("the review button survives every width, and the readouts go before it", async ({
  dashboard,
  daemon,
}) => {
  const head = await asking(dashboard, daemon);

  // The sweep. Every claim made on it is stated without a magic width, which is the point: the
  // width a session stops fitting at moves with its own name, with which chips it happens to be
  // carrying and with the browser's font metrics, so a spec that pinned one would be asserting
  // this fixture rather than the invariant.
  // Down to 400px, not to a comfortable desktop minimum. Two reasons, and the second is why
  // the floor is this low: the console rail drops out below ~560px, so the pane gets the whole
  // window from there down, and only in that last stretch does the row get narrow enough to
  // need the last two rungs. Stopping at 560 left rungs 5 and 6 asserted by the stylesheet and
  // exercised by nothing. 400px is also a window this app is read at - `settings-worktrees`
  // drives it at 390.
  const samples: (Head & { window: number })[] = [];
  for (let window = 1900; window >= 400; window -= 20) {
    await dashboard.setViewportSize({ width: window, height: 900 });
    samples.push({ window, ...(await readHead(dashboard)) });
  }
  const widest = samples[0]!;
  const narrowest = samples[samples.length - 1]!;
  const spent = (state: Head): number => state.rung.split(" ").filter(Boolean).length;
  const where = (s: Head & { window: number }): string => `${s.window}px ("${s.rung}")`;

  // The narrow end of the sweep, photographed where the sweep left the window, and this is the
  // frame the whole change is FOR: everything the header could give up has gone and the review
  // button is still there. The assertions below say that in offsets and row counts, which is a
  // true statement about a DOM and not a picture of a header - and "the button is still on the
  // row" is a claim a person reads rather than measures.
  await shot(
    dashboard,
    head,
    "header-narrowest",
    `a ${narrowest.container}px header at rung "${narrowest.rung}": every rung spent, the ` +
      `runtime cluster gone, and the review button still on the row`,
  );

  // 1. It never stacks while it still has a rung in hand. A rung that fires too late IS the
  //    defect, and is what no threshold can promise.
  expect(
    samples.filter((s) => s.rows === 2 && spent(s) < 6).map(where),
    "the header stacked while it still had rungs in hand",
  ).toEqual([]);

  // 2. The review button is drawn at every one of those widths - the operator's requirement,
  //    and the one thing this ladder may never spend.
  expect(
    samples.filter((s) => !drawn(s, "review")).map(where),
    "the review button was not drawn",
  ).toEqual([]);
  // The name goes with it. The identity block's floor is what keeps it, and a revert to
  // `min-width: 0` would leave a header that fits and says nothing about which session it is.
  expect(
    samples.filter((s) => !drawn(s, "name")).map(where),
    "the session's name was squeezed out of its own header",
  ).toEqual([]);

  // 3. The ORDER, asserted at every sample rather than at one chosen width: nothing later in
  //    the give-way order may be gone while something earlier is still drawn. Each pair reads
  //    as "if the later one has gone, the earlier one had already gone".
  const ORDER = [
    ["keycap", "cost", "the chord hint outlived the cost chip"],
    ["cost", "model", "cost outlived the model pill"],
    ["context", "model", "the context meter outlived the model pill"],
    ["model", "mode", "the model pill outlived the mode picker"],
    ["model", "effort", "the model pill outlived the effort picker"],
  ] as const;
  const inverted: string[] = [];
  for (const state of samples) {
    for (const [earlier, later, why] of ORDER) {
      // Skipped where the later part is absent from this session ENTIRELY - a fact it never
      // reported reads as 0 at every width, which is not the same as having been shed.
      if (widest.width[later] <= 2) continue;
      if (!drawn(state, later) && drawn(state, earlier)) inverted.push(`${where(state)}: ${why}`);
    }
  }
  expect(inverted, "the header gave way out of order").toEqual([]);

  // 4. And the sweep really spanned the ladder, so nothing above passed vacuously: the widest
  //    header sheds nothing, and the narrowest has spent rungs.
  expect(spent(widest), `the widest header is already on rung "${widest.rung}"`).toBe(0);
  expect(
    spent(narrowest),
    `the narrowest header (${narrowest.window}px window, ${narrowest.container}px of row) shed ` +
      `nothing, so this sweep never exercised the ladder`,
  ).toBeGreaterThan(0);

  // 5. The ladder is a ladder, not a ratchet: it gives the rungs back when the room comes back.
  //    A fit that only ever collapsed would satisfy everything above and leave the header
  //    stripped for the rest of the session.
  await dashboard.setViewportSize({ width: 1900, height: 900 });
  const back = await readHead(dashboard);
  expect(back.rows).toBe(1);
  expect(
    spent(back),
    `the wide header still holds the narrow one's rungs ("${back.rung}" after "${narrowest.rung}")`,
  ).toBeLessThan(spent(narrowest));
  expect(drawn(back, "review"), "the review button never came back").toBe(true);
  expect(drawn(back, "model"), "the model pill never came back").toBe(true);
});

test("a collapsed control is still the control it was, and still names itself", async ({
  dashboard,
  daemon,
}) => {
  const head = await asking(dashboard, daemon);

  // Found rather than pinned, for the reason the sweep gives: the width rung 2 fires at is a
  // function of this session's own content and of the browser's fonts.
  const state = await narrowUntilRung(dashboard, "2");
  await shot(
    dashboard,
    head,
    "header-collapsed",
    `a ${state.container}px header at rung "${state.rung}": the review button is drawn, the ` +
      `words beside marks are not`,
  );

  // The effort pill is the case the visually-hidden rule exists for. Its word is gone, its
  // glyph is what is left, and the control still opens its own picker under an accessible name
  // that never mentioned a width. Had the rung used `display: none`, this would be a live,
  // clickable glyph with nothing naming it.
  expect(drawn(state, "effortWord"), "rung 2 did not shed the effort level").toBe(false);
  expect(drawn(state, "effortMark"), "the effort pill has no mark left to click").toBe(true);
  const effort = head.locator(".rt-think-btn");
  await expect(effort).toHaveAttribute("aria-label", /Reasoning effort/);
  await effort.click();
  await expect(dashboard.getByRole("menu", { name: "Reasoning effort" })).toBeVisible();
  await dashboard.keyboard.press("Escape");

  // The runtime chip the same way: `Agent SDK` becomes its ◈, and the sentence explaining what
  // an embedded session is stays on the chip rather than going with the word.
  expect(drawn(state, "runtimeWord"), "rung 2 did not shed the runtime's name").toBe(false);
  expect(drawn(state, "runtimeMark"), "the runtime chip has no mark left").toBe(true);
  await expect(head.locator(".runtime-chip")).toHaveAttribute("aria-label", /Agent SDK/);

  // And rung 1's two, which are all the review button ever gives up. The chord the hint was
  // advertising still opens the queue at this width, which is what makes shedding it a hint
  // rather than a loss.
  expect(drawn(state, "keycap"), "rung 1 did not shed the chord hint").toBe(false);
  expect(drawn(state, "arrow"), "rung 1 did not shed the arrow").toBe(false);
  expect(drawn(state, "review"), "the review button itself went").toBe(true);
  await dashboard.keyboard.press("e");
  await expect(dashboard.getByRole("dialog", { name: "Review request" })).toBeVisible();
});
