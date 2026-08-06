import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/test.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import type { DaemonHandle } from "../fixtures/daemon.ts";

/**
 * Keep Awake, driven the way an operator meets it: the fleet pulse's live segment opens
 * a dropdown, the switch PUTs to the daemon, the daemon spawns its inhibitor child, and
 * the observed state comes back over SSE to every open window.
 *
 * This is the layer the other three cannot reach. The manager tests prove the exact argv
 * against an injected spawn, the render tests prove each state's markup, the route tests
 * prove the status codes - but only here does a click become a real OS process (the fake
 * `caffeinate` in `fake-agents.ts`, so no test run ever touches host power settings) and
 * only here can two browser windows be proven to converge on one truth without a reload.
 */

const EVIDENCE = artifactsDir("keep-awake");

/** The records the fake caffeinate writes: argv at start, a reason at exit. */
function records(daemon: DaemonHandle, kind: "start" | "exit"): { argv?: string[] }[] {
  return readdirSync(daemon.recordDir)
    .filter((f) => f.startsWith("keep-awake-") && f.endsWith(`-${kind}.json`))
    .map((f) => JSON.parse(readFileSync(join(daemon.recordDir, f), "utf8")) as { argv?: string[] });
}

async function daemonPid(daemon: DaemonHandle): Promise<number> {
  const res = await fetch(`${daemon.baseURL}/api/health`);
  return ((await res.json()) as { pid: number }).pid;
}

/** The live segment: located by role and its stateful accessible name, never a test id. */
const trigger = (page: Page) => page.getByRole("button", { name: /^Keep awake/ });
const dialog = (page: Page) => page.getByRole("dialog", { name: "Keep awake" });
const switchIn = (page: Page) =>
  dialog(page).getByRole("switch", { name: "Keep this Mac awake" });

test("the live segment drives caffeinate and every window converges over SSE", async ({
  dashboard,
  daemon,
}) => {
  // 1. Off, and honest about it: the segment still reads `live` and names its mode.
  await expect(trigger(dashboard)).toBeVisible();
  await expect(trigger(dashboard)).toHaveAccessibleName("Keep awake - off");
  await expect(trigger(dashboard)).toContainText("live");
  await expect(trigger(dashboard)).toHaveAttribute("aria-haspopup", "dialog");

  await trigger(dashboard).click();
  await expect(dialog(dashboard)).toBeVisible();
  await expect(trigger(dashboard)).toHaveAttribute("aria-expanded", "true");

  // 2. The dropdown states the guarantee, the non-guarantees, and the lifecycle - the
  // exact promises the runbook verifies against a real Mac.
  await expect(dialog(dashboard)).toContainText(
    "The screen can dim and lock normally. Prevents idle sleep.",
  );
  await expect(dialog(dashboard)).toContainText(
    "Lid close and manual Sleep still work. Uses more battery power.",
  );
  await expect(dialog(dashboard)).toContainText("On until Mission Control quits or restarts.");

  // A second window, opened BEFORE the toggle, so the on state it later shows can only
  // have arrived over the live channel - no reload, no poll.
  const second = await dashboard.context().newPage();
  await second.goto(`${daemon.baseURL}/#/fleet`);
  await expect(trigger(second)).toHaveAccessibleName("Keep awake - off");

  // 3. Turn it on.
  await expect(switchIn(dashboard)).toBeEnabled();
  await switchIn(dashboard).click();

  // 5. The SSE-driven flip: indicator and dropdown, same frame of truth, no reload.
  await expect(trigger(dashboard)).toContainText("live · awake");
  await expect(trigger(dashboard)).toHaveAccessibleName("Keep awake - on");
  await expect(switchIn(dashboard)).toHaveAttribute("aria-checked", "true");

  // 4. The OS received exactly `-i -w <this daemon's PID>` - nothing more. `-i` is the
  // idle-sleep-only semantics, `-w` the crash-safety backstop, and the absent `-d`/`-u`/
  // `-s` are what keep the display free to dim and lock.
  const pid = await daemonPid(daemon);
  await expect.poll(() => records(daemon, "start").length).toBe(1);
  expect(records(daemon, "start")[0]!.argv).toEqual(["-i", "-w", String(pid)]);

  // 6. The second window heard it too.
  await expect(trigger(second)).toContainText("live · awake");
  await expect(trigger(second)).toHaveAccessibleName("Keep awake - on");

  // The review artifact: the ACTIVE dropdown open beside the pulse. Captured while on,
  // gated like every capture in this suite so an ordinary run writes nothing.
  if (process.env.MC_E2E_EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true });
    await dashboard.mouse.move(0, 0); // Tooltip portals a bubble under a resting pointer.
    await dashboard.screenshot({
      path: `${EVIDENCE}keep-awake-active-dropdown.png`,
      clip: { x: 0, y: 0, width: 900, height: 330 },
    });
    console.log(`CAPTURED ${EVIDENCE}keep-awake-active-dropdown.png`);
  }

  // 7. Off again: the child exits, and BOTH windows return to plain live.
  await switchIn(dashboard).click();
  await expect(trigger(dashboard)).toHaveAccessibleName("Keep awake - off");
  await expect(trigger(dashboard)).not.toContainText("awake");
  await expect(trigger(second)).toHaveAccessibleName("Keep awake - off");
  await expect(trigger(second)).not.toContainText("awake");
  await expect.poll(() => records(daemon, "exit").length).toBe(1);
});

test("a daemon crash never leaves a stale awake claim, and a restart returns off", async ({
  dashboard,
  daemon,
}) => {
  await trigger(dashboard).click();
  await switchIn(dashboard).click();
  await expect(trigger(dashboard)).toContainText("live · awake");
  await expect.poll(() => records(daemon, "start").length).toBe(1);

  // 8. Sever the stream the way it actually severs: the daemon dies with no orderly
  // shutdown of any kind. The browser cannot know whether the assertion is still held,
  // so the control must fall to `reconnecting` and refuse input rather than keep
  // drawing an on state it can no longer vouch for. (`setOffline` is deliberately not
  // used here - Chromium leaves an established SSE socket alive through it.)
  await daemon.crash();
  await expect(trigger(dashboard)).toContainText("reconnecting");
  await expect(trigger(dashboard)).toHaveAccessibleName(
    "Keep awake - Mission Control is reconnecting",
  );
  await expect(switchIn(dashboard)).toBeDisabled();
  await expect(switchIn(dashboard)).toHaveAttribute("aria-checked", "false");
  await expect(dialog(dashboard)).toContainText("Mission Control is reconnecting");

  // The crash-safety backstop, end to end: nothing could run the manager's orderly
  // stop, so the `-w <daemon PID>` watch is what releases the assertion - the fake
  // notices its watched pid is gone and exits on its own, exactly as caffeinate would.
  await expect.poll(() => records(daemon, "exit").length, { timeout: 5_000 }).toBe(1);

  // And the approved restart lifecycle: the successor daemon starts with the mode OFF -
  // nothing persists it, nothing reacquires it - and the reconnecting dashboard
  // converges on that truth by itself, with no reload.
  await daemon.restart();
  await expect(trigger(dashboard)).toHaveAccessibleName("Keep awake - off", {
    timeout: 30_000,
  });
  await expect(trigger(dashboard)).not.toContainText("awake");
  await expect(switchIn(dashboard)).toBeEnabled();
  await expect(switchIn(dashboard)).toHaveAttribute("aria-checked", "false");
});

test("the awake label never wraps the title bar, and compaction never hides the control", async ({
  dashboard,
}) => {
  await trigger(dashboard).click();
  await switchIn(dashboard).click();
  await expect(trigger(dashboard)).toContainText("live · awake");
  await dashboard.keyboard.press("Escape");
  await expect(dialog(dashboard)).toBeHidden();

  // The one-row invariant with the ADDED WORD on the bar, at the pinned widths the
  // ladder was calibrated against and below. Stated the way topbar-one-row.spec.ts
  // states it - one row, or every rung already spent - because exact rungs at these
  // widths are a rounding direction on CI fonts, not a contract.
  for (const width of [1470, 1360, 1200, 1000, 800]) {
    await dashboard.setViewportSize({ width, height: 900 });
    const bar = await dashboard.evaluate(() => {
      return new Promise<{ rows: number; rung: string }>((done) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const el = document.querySelector("header.topbar") as HTMLElement;
            const style = getComputedStyle(el);
            const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
            const tallest = Math.max(
              0,
              ...[...el.children].map((k) => (k as HTMLElement).offsetHeight),
            );
            done({
              rows: el.clientHeight - padY > tallest + 2 ? 2 : 1,
              rung: el.dataset.rung ?? "",
            });
          }),
        ),
      );
    });
    expect(
      bar.rows === 1 || bar.rung === "1 2 3 4 5",
      `${width}px: the awake bar stacked to ${bar.rows} rows with rungs "${bar.rung}" in hand`,
    ).toBe(true);
  }

  // Filter compaction. Before this feature, an idle fleet's pulse held no interactive
  // segment, so rung 3 hid the WHOLE pulse while the filter was active - a rule that
  // would now take the Keep awake control off screen. Probe down to a width where rung 3
  // is actually applied (font metrics move it, so no single width is safe to pin) and
  // prove the trigger survives the compaction drawn and working. The HELD-TERM branch is
  // the one driven, because it is the stable one: a held term keeps the compaction
  // applied after focus leaves, so the click below lands on settled geometry.
  let rung = "";
  for (const width of [980, 900, 840, 780]) {
    await dashboard.setViewportSize({ width, height: 900 });
    rung = await dashboard.evaluate(
      () =>
        new Promise<string>((done) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() =>
              done((document.querySelector("header.topbar") as HTMLElement).dataset.rung ?? ""),
            ),
          ),
        ),
    );
    if (rung.split(" ").includes("3")) break;
  }
  expect(rung.split(" "), "no probed width reached the filter's rung").toContain("3");

  await dashboard.locator(".filter-box").click();
  const field = dashboard.locator(".filter-input");
  await expect(field).toBeFocused();
  await field.fill("hold the compaction open");
  await dashboard.locator("header.topbar .brand").click();
  await expect(field).not.toBeFocused();

  await expect
    .poll(async () => ((await trigger(dashboard).boundingBox())?.width ?? 0) > 2, {
      message: "filter compaction took the Keep awake control off screen",
    })
    .toBe(true);
  // The sole-survivor shape: this idle fleet's inbox is empty, so no reviews control
  // renders and the trigger is the pulse's ONLY visible segment - which must take the
  // FULL rounding, not keep the leading-edge-only radius that assumes a trailing
  // sibling and draws a square corner on hover inside the rounded pill.
  expect(
    await trigger(dashboard).evaluate((el) => getComputedStyle(el).borderRadius),
    "the lone live trigger kept its leading-edge-only rounding",
  ).toBe("999px");

  await trigger(dashboard).click();
  await expect(dialog(dashboard)).toBeVisible();
  // Still the ACTIVE control, compacted: the switch inside reflects the held assertion.
  await expect(switchIn(dashboard)).toHaveAttribute("aria-checked", "true");
});
