import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  AVAILABLE_UPDATE,
  OUTPUT_DIR,
  SCREENSHOTS,
  desktopUpdateBridgeScript,
  openSetupFamily,
  requestedScreenshots,
  trustCell,
  type CaptureLocator,
  type CapturePage,
} from "../scripts/docs-screenshots.mjs";
import { SETUP_FAMILY_INFO, type SetupFamilyId } from "../src/shared/setup-catalog.ts";
import { UPDATE_PHASES, isNewerVersion } from "../src/shared/update.ts";

/**
 * The committed-imagery registry's pure half.
 *
 * Taking a frame needs a build, a demo daemon and a browser, none of which `test/` has - it runs
 * against `src/` on a fresh checkout. So what is held here is everything that can be wrong
 * WITHOUT running: a shot that names no committed file, a `--only` that silently captures
 * nothing, a family label that has drifted from the catalog it is a copy of, and a fake preload
 * bridge that has drifted from the contract the renderer calls through.
 *
 * Importing the module must also not start a demo daemon, which is the entrypoint guard at the
 * bottom of the script. Every case here proves that by existing.
 */

const shot = (name: string) => {
  const found = SCREENSHOTS.find((s) => s.name === name);
  assert.ok(found, `no screenshot named ${name}`);
  return found;
};

test("every shot names a distinct committed figure", () => {
  const names = SCREENSHOTS.map((s) => s.name);
  assert.equal(new Set(names).size, names.length, "two shots would write the same file");

  // A shot whose PNG was never committed, or was deleted without its definition, is the
  // failure this catches: `docs/setup-guide.html` and `README.md` embed these by path, and a
  // missing one is a broken image in published documentation rather than a build error.
  for (const name of names) {
    assert.ok(
      existsSync(join(OUTPUT_DIR, `${name}.png`)),
      `docs/images/${name}.png is missing - run \`npm run docs:screenshots -- --only ${name}\``,
    );
  }
});

test("every shot declares a route and a readiness locator", () => {
  for (const s of SCREENSHOTS) {
    assert.match(s.route, /^#\//, `${s.name} must open a dashboard hash route`);
    assert.equal(typeof s.ready, "function", `${s.name} has no readiness locator`);
  }
});

test("--only selects the named shots and refuses an unknown one", () => {
  assert.deepEqual(requestedScreenshots([]), SCREENSHOTS);

  const picked = requestedScreenshots(["--only", "setup-panel,setup-github"]);
  assert.deepEqual(picked.map((s) => s.name), ["setup-panel", "setup-github"]);

  // The case that matters: a typo must not quietly capture nothing and report success, which
  // is what an intersection with no check would do.
  assert.throws(() => requestedScreenshots(["--only", "setup-pannel"]), /setup-pannel/);
  assert.throws(() => requestedScreenshots(["--only"]), /comma-separated/);
});

test("the Setup shots choose their family instead of inheriting one", () => {
  // Which family the panel OPENS on is derived from where the capturing machine's gaps are, so
  // a Setup shot with no `prepare` documents that laptop rather than the panel.
  for (const name of ["setup-panel", "setup-github"]) {
    const s = shot(name);
    assert.equal(s.route, "#/settings/setup");
    assert.equal(typeof s.prepare, "function", `${name} must select a family`);
  }
});

test("the family labels the capture script hardcodes still match the catalog", async () => {
  // `openSetupFamily` takes a label because this script runs under plain Node with no
  // TypeScript loader and cannot import `SETUP_FAMILY_INFO` at runtime. That makes the labels
  // a copy, and this is the assertion that stops the copy drifting: renaming a family in the
  // catalog fails here rather than hanging a capture on a button that no longer exists.
  const asked: string[] = [];
  const page = fakePage({ onRole: (name) => asked.push(String(name)) });

  for (const family of ["agents", "terminals", "github"] as SetupFamilyId[]) {
    const { label } = SETUP_FAMILY_INFO[family];
    await openSetupFamily(page, family, label);
    const pattern = new RegExp(asked.at(-1) ?? "");
    // The rail item reads "<label>: N of M ready", or the bare label while it is still loading.
    assert.ok(pattern.test(`${label}: 3 of 3 ready`), `${label} rail item would not be found`);
    assert.ok(pattern.test(label), `${label} would not be found while its rows load`);
    assert.ok(!pattern.test(`Not ${label}`), `${label} pattern is not anchored`);
  }
});

test("openSetupFamily waits on the pane, not on the click", async () => {
  const waited: string[] = [];
  const page = fakePage({ onLocator: (selector) => waited.push(selector) });
  await openSetupFamily(page, "github", SETUP_FAMILY_INFO.github.label);

  // A click resolves as soon as the event is dispatched. The frame is of the PANE, so the wait
  // has to be on the pane having become current.
  assert.deepEqual(waited, ['#setup-family-github[aria-current="true"]']);
});

test("the faked preload bridge carries every member the renderer calls unguarded", () => {
  const source = desktopUpdateBridgeScript(AVAILABLE_UPDATE);

  // `App.tsx` reaches these through `window.missionDesktop?.<member>(...)`, so the optional
  // chain covers the BRIDGE being absent and not the MEMBER's. A bridge missing one throws
  // inside a mount effect and takes the dashboard down instead of drawing a banner.
  for (const member of ["isDesktop", "onOpenSettings", "version", "openExternal", "updates"]) {
    assert.match(source, new RegExp(`\\b${member}\\s*:`), `bridge has no ${member}`);
  }
  for (const member of ["getState", "check", "apply", "install", "cancel", "defer", "onState"]) {
    assert.match(source, new RegExp(`\\b${member}\\s*:`), `bridge's updates has no ${member}`);
  }

  // The snapshot has to survive the trip into the page's own world intact, because the banner
  // draws its version and its release summary straight out of it.
  assert.ok(source.includes(JSON.stringify(AVAILABLE_UPDATE)));
});

test("the update snapshot is a phase the shipped union actually has", () => {
  assert.ok(UPDATE_PHASES.includes(AVAILABLE_UPDATE.phase));
  assert.equal(AVAILABLE_UPDATE.phase, "available");
  // The banner renders `newVersion`; a snapshot that is not strictly newer is not an offer the
  // real updater would ever make, since it never provides a downgrade path.
  //
  // Asked through the shipped `isNewerVersion` rather than with `>`, which is a STRING compare:
  // it happens to agree for 1.17.0 over 1.16.1 and disagrees for 1.10.0 over 1.9.0, so editing
  // these literals to a pair that straddles a ten could leave this passing while asserting the
  // opposite of what it says. Using the updater's own predicate also means the snapshot is held
  // to the rule the product actually applies, rather than to a second copy of it here.
  assert.ok(isNewerVersion(AVAILABLE_UPDATE.currentVersion, AVAILABLE_UPDATE.newVersion));
  assert.equal(typeof AVAILABLE_UPDATE.releaseNotes, "string");
  assert.ok(AVAILABLE_UPDATE.releaseNotes.length > 0);

  // The check that found a release cannot predate the release. Nothing renders either field -
  // the banner shows the version and the notes - so only an assertion can keep the fixture
  // describing a machine state the real updater could actually reach.
  assert.ok(
    AVAILABLE_UPDATE.checkedAt >= Date.parse(AVAILABLE_UPDATE.publishedAt),
    "checkedAt predates publishedAt, which the updater can never produce",
  );
});

test("the update shot takes its own context and the reminder shot precedes the dismissal", () => {
  // `addInitScript` outlives the page it was added for, so a shot that fakes the desktop
  // bridge on the SHARED page would silently redraw every later frame as a desktop one.
  const update = shot("update-available");
  assert.equal(typeof update.init, "function");
  assert.equal(update.needsFleet, true);

  // The reminder is raised on a fresh profile and dismissed once. A frame of it therefore has
  // to be taken before `dismissSetupBanner`, which is what this flag orders.
  const reminder = shot("first-run-reminder");
  assert.equal(reminder.beforeBannerDismissal, true);
  assert.equal(reminder.needsFleet, true);
  assert.ok(
    !SCREENSHOTS.some((s) => s.beforeBannerDismissal && s.name !== "first-run-reminder"),
    "another shot claims the pre-dismissal window; confirm it really needs the reminder raised",
  );
});

test("the Trust shot stages its rows rather than inheriting an empty matrix", () => {
  const s = shot("settings-trust");
  assert.equal(s.route, "#/settings/trust");
  // An empty matrix is the true first-run state and says only "no repositories yet", which
  // cannot show the thing the guide sends people here for: a row that exists and still allows
  // nothing. So the figure is staged, and staging is what `prepare` does.
  assert.equal(typeof s.prepare, "function");
});

test("trustCell matches the accessible name TrustPanel actually builds", () => {
  const repo = "/Users/someone/work/demo-api";
  // `aria-label={`${on ? "Revoke" : "Grant"}: ${col.label} for ${row.repo}`}`, where `col.label`
  // is the column's full TITLE - "Foreman sends live", not the "Foreman" in the header. A
  // selector written against the header silently matched nothing and hung the capture for 30s.
  assert.match(`Grant: Foreman sends live for ${repo}`, trustCell("Grant", "Foreman", repo));
  assert.match(`Revoke: Workflows act for ${repo}`, trustCell("Revoke", "Workflows", repo));
  assert.match(
    `Grant: GitHub Inspector posts reviews for ${repo}`,
    trustCell("Grant", "GitHub Inspector", repo),
  );

  // Anchored at both ends: a sibling repository whose name merely ends the same way, and the
  // opposite action, are both the wrong button to click.
  assert.doesNotMatch(`Grant: Foreman sends live for /Users/someone/work/other-demo-api`, trustCell("Grant", "Foreman", repo));
  assert.doesNotMatch(`Revoke: Foreman sends live for ${repo}`, trustCell("Grant", "Foreman", repo));
  assert.doesNotMatch(`Grant: Workflows act for ${repo}`, trustCell("Grant", "Foreman", repo));
});

/**
 * A `Page` that records what was asked of it.
 *
 * Deliberately implements the WHOLE of `CapturePage` and `CaptureLocator` rather than the two
 * members these cases exercise. The declarations are the parameter types of exported callbacks,
 * so a fake that satisfies only part of them would let the contract narrow without anything
 * noticing - which is the failure `scripts/docs-screenshots.d.mts` exists to prevent. Making
 * this the one full implementation means widening the contract breaks here first.
 */
function fakePage(
  hooks: { onRole?: (name: unknown) => void; onLocator?: (selector: string) => void } = {},
): CapturePage {
  const locator: CaptureLocator = {
    click: async () => {},
    waitFor: async () => {},
    fill: async () => {},
    isVisible: async () => false,
    first: () => locator,
    scrollIntoViewIfNeeded: async () => {},
  };
  return {
    getByRole: (_role: string, options?: Record<string, unknown>) => {
      hooks.onRole?.((options?.name as RegExp | undefined)?.source);
      return locator;
    },
    getByPlaceholder: () => locator,
    getByText: () => locator,
    locator: (selector: string) => {
      hooks.onLocator?.(selector);
      return locator;
    },
    keyboard: { press: async () => {} },
    waitForTimeout: async () => {},
  };
}
