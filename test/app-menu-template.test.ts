import assert from "node:assert/strict";
import test from "node:test";

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
 * `⌘0`/`⌘-`/`⌘+` to its three zoom roles, which are the last three of the Board card's
 * twelve jump shortcuts. Left as a role, those three chords would work in a browser and
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

const template = appMenuTemplate("Mission Control", {
  onOpenSettings: () => {},
  onCheckForUpdates: () => {},
}) as Item[];

/** Every item at every depth, so a nested submenu cannot smuggle an accelerator in. */
function flatten(items: Item[]): Item[] {
  return items.flatMap((item) => [item, ...flatten(item.submenu ?? [])]);
}

const view = template.find((item) => item.label === "View");

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

test("no menu item claims a chord the Board's jump keys use", () => {
  const claimed = new Set(
    flatten(template)
      .map((item) => item.accelerator)
      .filter((accelerator): accelerator is string => Boolean(accelerator))
      .map((accelerator) => accelerator.toLowerCase()),
  );
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

test("every accelerator the list reserves is one the Board actually binds", () => {
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

test("Settings keeps its conventional chord", () => {
  const settings = flatten(template).find((item) => item.label === "Settings…");
  assert.equal(settings?.accelerator, "CmdOrCtrl+,");
});
