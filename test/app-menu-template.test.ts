import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  appMenuTemplate,
  RENDERER_OWNED_ACCELERATORS,
} from "../src/main/menu-template.ts";
import { CARD_SHORTCUT_CHORDS } from "../src/web/lib/card-shortcuts.ts";

/**
 * The desktop menu must not claim a key the dashboard binds.
 *
 * A menu accelerator is registered with the OS and is handled BEFORE the renderer sees the
 * keystroke, so this is not a style question: Electron's stock `viewMenu` attaches
 * `⌘0`/`⌘-`/`⌘+` to its three zoom roles, which are the last three of the fleet's twelve
 * session jump shortcuts. Left as a role, those three chords would work in a browser and
 * silently do nothing in the packaged app - a failure with no diff to look at and no error
 * anywhere.
 *
 * `menu-template.ts` exists so this costs milliseconds instead of an Electron launch. It
 * imports no electron runtime; every electron name in it is a type.
 */

type Item = {
  label?: string;
  role?: string;
  type?: string;
  accelerator?: string;
  submenu?: Item[];
};

/** The menu in a chosen state. `claimed` is whether the dashboard holds the number row. */
function menu(claimed: boolean): Item[] {
  return appMenuTemplate(
    "Mission Control",
    { onOpenSettings: () => {}, onCheckForUpdates: () => {} },
    { rendererOwnsNumberRow: claimed },
  ) as Item[];
}

/** While the fleet is using the jump keys. */
const template = menu(true);
/** While it is not - the preference off, or any page that cannot use them. */
const released = menu(false);

/** Every item at every depth, so a nested submenu cannot smuggle an accelerator in. */
function flatten(items: Item[]): Item[] {
  return items.flatMap((item) => [item, ...flatten(item.submenu ?? [])]);
}

const view = template.find((item) => item.label === "View");
const releasedView = released.find((item) => item.label === "View");

/** Every accelerator the template registers, lowercased, at every depth. */
function accelerators(items: Item[]): Set<string> {
  return new Set(
    flatten(items)
      .map((item) => item.accelerator)
      .filter((accelerator): accelerator is string => Boolean(accelerator))
      .map((accelerator) => accelerator.toLowerCase()),
  );
}

test("the View menu is spelled out rather than the stock role", () => {
  // `role: "viewMenu"` is one line and brings the three zoom accelerators with it, which is
  // exactly the regression this file guards. If someone puts it back, every assertion below
  // would pass vacuously - so the shape is pinned first.
  assert.ok(view, "there is no explicit View submenu");
  assert.equal(
    template.some((item) => item.role === "viewMenu"),
    false,
    "the stock viewMenu role is back, and it claims the card jump keys with it",
  );
});

test("zoom is still reachable, and still steps and resets", () => {
  // The other half of the trade: freeing the keys must not remove the capability. The items
  // stay, with click handlers instead of roles.
  const labels = (view?.submenu ?? []).map((item) => item.label);
  for (const label of ["Actual Size", "Zoom In", "Zoom Out"]) {
    assert.ok(labels.includes(label), `the View menu no longer offers "${label}"`);
  }
  // And they are wired to something. A role would have supplied the behavior; a bare label
  // with no click is a dead menu item, which is the way this fix goes wrong.
  for (const item of view?.submenu ?? []) {
    if (!["Actual Size", "Zoom In", "Zoom Out"].includes(item.label ?? "")) continue;
    assert.equal(
      typeof (item as { click?: unknown }).click,
      "function",
      `"${item.label}" has no handler`,
    );
  }
});

test("the reload, devtools and full-screen roles are untouched", () => {
  // Not collateral damage. These carry accelerators the dashboard does not bind - and `⌃R`,
  // which the dashboard DOES bind, is not `⌘R`.
  const roles = (view?.submenu ?? []).map((item) => item.role);
  for (const role of ["reload", "forceReload", "toggleDevTools", "togglefullscreen"]) {
    assert.ok(roles.includes(role), `the View menu dropped the "${role}" role`);
  }
});

test("no menu item claims a chord the jump keys use, while the fleet is using them", () => {
  const claimed = accelerators(template);
  for (const accelerator of RENDERER_OWNED_ACCELERATORS) {
    assert.equal(
      claimed.has(accelerator.toLowerCase()),
      false,
      `the menu registers ${accelerator}, which the renderer needs`,
    );
    // Electron accepts `CmdOrCtrl` as a synonym, so the abbreviated spelling has to be
    // refused too or the guard is one search-and-replace away from passing over the bug.
    assert.equal(
      claimed.has(accelerator.toLowerCase().replace("commandorcontrol", "cmdorctrl")),
      false,
      `the menu registers ${accelerator} under its CmdOrCtrl spelling`,
    );
  }
});

test("every accelerator the list reserves is one the fleet actually binds", () => {
  // Ties the two files together in the direction that can rot. The list is deliberately not
  // all twelve slots - only ⌘0, ⌘- and ⌘= were ever claimed by a menu role, and reserving
  // ⌘1 would say the menu had a claim on it that it never had. What it must not become is a
  // list of keys nobody uses, which would read as a standing constraint on this menu that
  // no longer has a reason. `Plus` is Electron's spelling of the ⌘= cap, so it maps to the
  // same slot.
  const slots = new Set(CARD_SHORTCUT_CHORDS.map((chord) => chord.replace(/^cmd\+/, "")));
  for (const accelerator of RENDERER_OWNED_ACCELERATORS) {
    const key = accelerator.replace(/^CommandOrControl\+/, "").replace(/^Shift\+/, "");
    assert.ok(
      slots.has(key) || (key === "Plus" && slots.has("=")),
      `${accelerator} is reserved from the menu but is no card slot`,
    );
  }
  // And the three the stock role would have taken are all named, which is the whole point
  // of having the list at all.
  for (const key of ["0", "-", "="]) {
    assert.ok(
      RENDERER_OWNED_ACCELERATORS.includes(`CommandOrControl+${key}`),
      `⌘${key} is a card slot the zoom roles claim, and the list does not reserve it`,
    );
  }
});

test("the menu takes the zoom keys BACK when the fleet is not using them", () => {
  // The bug this is here for: the accelerators were given up unconditionally, so unchecking
  // Jump shortcut left ⌘0/⌘-/⌘= doing nothing at all - the renderer had stopped handling
  // them and the menu no longer owned them either. The preference could switch the feature
  // off but could not give the keys back, which is exactly what its description promises.
  //
  // Asserted through the ROLES rather than through accelerator strings, because that is the
  // actual fix: a role carries Electron's own accelerator, so the fallback is the stock View
  // menu instead of an imitation of it.
  const roles = (releasedView?.submenu ?? []).map((item) => item.role);
  for (const role of ["resetZoom", "zoomIn", "zoomOut"]) {
    assert.ok(
      roles.includes(role),
      `zoom does not get its "${role}" accelerator back when the fleet releases the keys`,
    );
  }
  // And no hand-rolled duplicate left behind beside them, which would give the View menu two
  // Zoom In entries.
  const labels = (releasedView?.submenu ?? []).map((item) => item.label);
  for (const label of ["Actual Size", "Zoom In", "Zoom Out"]) {
    assert.equal(
      labels.filter((candidate) => candidate === label).length,
      0,
      `"${label}" is drawn twice: once as a role and once as a click handler`,
    );
  }
});

test("releasing the keys changes only the zoom entries", () => {
  // The two states must not drift into two different menus. Everything outside the three
  // zoom rows - Settings, the tray-shared update item, reload, DevTools, full screen, and
  // every accelerator any of them carries - is the same in both.
  const zoomChords = new Set(RENDERER_OWNED_ACCELERATORS.map((a) => a.toLowerCase()));
  const outside = (items: Item[]): string[] =>
    [...accelerators(items)].filter((chord) => !zoomChords.has(chord)).sort();
  assert.deepEqual(outside(released), outside(template));

  const labels = (items: Item[]): string[] =>
    flatten(items)
      .map((item) => item.label ?? item.role ?? item.type ?? "")
      .filter((name) => !["Actual Size", "Zoom In", "Zoom Out", "resetZoom", "zoomIn", "zoomOut"]
        .includes(name));
  assert.deepEqual(labels(released), labels(template));
});

test("the default state is the one that leaves zoom alone", () => {
  // `appMenuTemplate` is called once at launch, before any renderer has reported anything.
  // Defaulting to "the fleet owns the keys" would take zoom's shortcuts away for the whole
  // window that a dashboard takes to load, and keep them away for a profile that opens
  // straight onto the Library or Runs and never reaches Fleet at all.
  const roles = (menu(false).find((item) => item.label === "View")?.submenu ?? [])
    .map((item) => item.role);
  const atLaunch = appMenuTemplate("Mission Control", {
    onOpenSettings: () => {},
    onCheckForUpdates: () => {},
  }) as Item[];
  const launchRoles = (atLaunch.find((item) => item.label === "View")?.submenu ?? [])
    .map((item) => item.role);
  assert.deepEqual(launchRoles, roles);
});

test("the preference reaches the menu across all four layers", () => {
  // A source scan, for the reason `board-card-items.test.ts` is one: this seam is four files
  // deep - the dashboard reports, the preload forwards, main handles, the menu rebuilds - and
  // any one of them can be edited alone and still typecheck, lint, build and pass every other
  // test in this repository. The result is a preference that appears to work and silently
  // leaves the desktop shortcuts wherever they were, which is the bug this whole state
  // parameter exists to fix. Nothing else here can see it: the two states above are pure and
  // `menu.ts` cannot be imported outside the Electron process at all.
  const source = (path: string): string =>
    readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

  const app = source("../src/web/App.tsx");
  // Optional on BOTH links. The bridge member is declared optional so the compiler enforces
  // this as well; the assertion is here because the second `?.` is exactly what a well-meaning
  // tidy-up removes, and unguarded it unmounts the entire dashboard against any bridge object
  // that predates the member - which is how `update-banner.spec.ts` caught it.
  assert.match(
    app,
    /missionDesktop\?\.setCardJumpKeys\?\.\(cardShortcutsOn\)/,
    "the dashboard does not report its claim on the number row, or reports it unguarded",
  );

  const preload = source("../src/preload/index.ts");
  assert.match(preload, /setCardJumpKeys:/, "the preload bridge no longer exposes the report");
  assert.match(
    preload,
    /ipcRenderer\.invoke\("mission:card-jump-keys", claimed\)/,
    "the preload bridge no longer forwards the report to main",
  );

  const main = source("../src/main/index.ts");
  assert.match(
    main,
    /ipcMain\.handle\("mission:card-jump-keys"/,
    "main no longer handles the report",
  );
  assert.match(
    main,
    /setRendererOwnsNumberRow\(/,
    "main receives the report and does not pass it to the menu",
  );

  const menu = source("../src/main/menu.ts");
  assert.match(
    menu,
    /export function setRendererOwnsNumberRow/,
    "the menu module no longer accepts a changed claim",
  );
  assert.match(
    menu,
    /appMenuTemplate\(app\.name, installed, state\)/,
    "the menu is rebuilt without the claim it was told about",
  );
  // Idempotent, because the dashboard reports on load, on change and on every reload. Without
  // this the macOS menu bar is replaced on each of those for no reason.
  assert.match(
    menu,
    /if \(state\.rendererOwnsNumberRow === owns\) return;/,
    "an unchanged claim still rebuilds the whole application menu",
  );
});

test("Settings keeps its conventional chord", () => {
  const settings = flatten(template).find((item) => item.label === "Settings…");
  assert.equal(settings?.accelerator, "CmdOrCtrl+,");
});
