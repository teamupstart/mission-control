import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OpenInList } from "../src/web/components/OpenInMenu.tsx";
import type { OpenTargetView } from "../src/shared/open-targets.ts";

// What is at stake: the menu is a FOLD over what the daemon reports, so a second target
// costs a server file and two record entries and nothing here. The way that breaks is a
// row learning a target's name - a hard-coded "Browser" item, a `t.id === "vscode"`
// branch - after which the next target needs a component change and gets a different
// disabled-reason story than the first.
//
// The rest pins what a row has to SAY. An unavailable target that will not explain itself
// is a greyed control with no fix attached, and an empty list drawn for a failed fetch
// reads as "there is nowhere to open this" - both are worse than the error they hide.

const view = (over: Partial<OpenTargetView> = {}): OpenTargetView => ({
  id: "browser",
  label: "Browser",
  blurb: "Opens the file from disk in your default browser.",
  glyph: "◍",
  unavailable: null,
  detail: "Chrome",
  ...over,
});

const render = (targets: OpenTargetView[] | null, failed = false): string =>
  renderToStaticMarkup(createElement(OpenInList, { targets, failed, onChoose: () => {} }));

test("an available target names the application it resolved to", () => {
  const html = render([view()]);
  assert.match(html, /Browser/);
  assert.match(html, /<em>Chrome<\/em>/);
  assert.match(html, /role="menuitem"/);
  assert.doesNotMatch(html, /disabled/);
});

test("an unavailable target is disabled and says why, in place of its blurb", () => {
  const html = render([view({ unavailable: "not supported on win32 yet", detail: null })]);
  assert.match(html, /disabled/);
  assert.match(html, /not supported on win32 yet/);
  assert.doesNotMatch(html, /Opens the file from disk/);
});

test("a failed fetch says so rather than rendering an empty menu", () => {
  const html = render(null, true);
  assert.match(html, /Could not ask the daemon/);
  assert.doesNotMatch(html, /menuitem/);
});

test("no answer yet and a genuinely empty build read differently", () => {
  assert.match(render(null), /Checking/);
  assert.match(render([]), /nowhere to open files/);
});

test("every target the daemon reports gets a row, in the order it reported them", () => {
  const html = render([
    view(),
    view({ id: "browser", label: "Editor", detail: "Zed", glyph: "▤" }),
  ]);
  assert.equal(html.match(/role="menuitem"/g)?.length, 2);
  assert.ok(html.indexOf("Browser") < html.indexOf("Editor"));
});

test("the menu names no target itself - rows come only from the registry", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../src/web/components/OpenInMenu.tsx", import.meta.url)),
    "utf8",
  );
  for (const id of ["browser", "vscode", "jetbrains", "chrome", "safari", "firefox"]) {
    assert.doesNotMatch(
      source.toLowerCase(),
      new RegExp(`["'\`]${id}["'\`]`),
      `${id} is named in the menu - a target's identity belongs to the registry`,
    );
  }
});
