import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { withOverlayHost } from "./helpers/overlay-host.ts";

// What repo a fresh dispatch form starts on.
//
// Dispatching happens in runs - several tasks into the same checkout before a switch -
// so a blank repo field asks a question that was just answered, and answering it again
// means retyping a path the app already knows. The seed is the answer carried forward.
//
// Two things are at stake, and the second is the easy one to get wrong: the seed has to
// survive a reload (it is the same operator, mid-run, in the same repo), and it must not
// read as unsaved input - a form nobody has touched still has nothing to Clear, and a
// Clear button lit up on open is an invitation to wipe a field you didn't fill in.

// The store reads localStorage at call time, and the modal reads it during render.
// Node's built-in global exists but throws without a backing file, which the store
// would swallow as "storage unavailable" - so stand up an in-memory one first, then
// import, to keep the persisted seed observable here.
const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
});

const { readLastDispatchRepo, rememberDispatchRepo } = await import("../src/web/lib/lastRepo.ts");
const { DispatchLayer } = await import("../src/web/components/DispatchModal.tsx");

const KEY = "mission-control.dispatch.repo";
const REPO = "/Users/x/workspace/mission-control";

beforeEach(() => store.clear());

// ---- the memory itself ----

test("a dispatched repo is remembered, and persists past the tab that sent it", () => {
  rememberDispatchRepo(REPO);
  assert.equal(readLastDispatchRepo(), REPO);
  // The durable half: it is in storage, so a reload starts the next dispatch there too.
  assert.equal(store.get(KEY), REPO);
});

test("with nothing remembered the seed is empty, which is the old behaviour", () => {
  assert.equal(readLastDispatchRepo(), "");
});

test("a blank repo never clears the memory", () => {
  // Submitting without a repo is impossible, so a blank reaching here is a caller
  // passing something it never sent - and forgetting the seed is not what that means.
  rememberDispatchRepo(REPO);
  rememberDispatchRepo("   ");
  assert.equal(readLastDispatchRepo(), REPO);
});

test("a padded path is stored and read back trimmed, so it matches what was dispatched", () => {
  // The dispatch trims before it POSTs; a seed that kept the padding would compare
  // unequal to it and quietly count as typed input.
  rememberDispatchRepo(`  ${REPO}  `);
  assert.equal(readLastDispatchRepo(), REPO);
});

// ---- the form that reads it ----

/** The dispatch form as it renders on open, with no task under it. */
function renderForm(): string {
  return renderToStaticMarkup(
    withOverlayHost(
      createElement(DispatchLayer, { open: true, editTask: null, onClose: () => {} }),
    ),
  );
}

/** The repo combobox's value. */
function repoValue(html: string): string {
  const v = /role="combobox"[^>]*\bvalue="([^"]*)"/.exec(html)?.[1];
  assert.notEqual(v, undefined, "no repo combobox rendered");
  return v!;
}

/** Whether the footer's Clear button renders disabled. */
function clearDisabled(html: string): boolean {
  const btn = /<button[^>]*>Clear<\/button>/.exec(html)?.[0] ?? "";
  assert.notEqual(btn, "", "no Clear button rendered");
  return btn.includes("disabled");
}

test("a fresh dispatch form opens on the last dispatched repo", () => {
  rememberDispatchRepo(REPO);
  assert.equal(repoValue(renderForm()), REPO);
});

test("with nothing remembered the repo field opens empty", () => {
  assert.equal(repoValue(renderForm()), "");
});

test("the seeded repo doesn't count as typed input, so Clear stays disabled", () => {
  // Clear resets to a freshly-opened form, seed included - so on a form nobody has
  // touched it has nothing to do, and saying otherwise offers to undo work never done.
  rememberDispatchRepo(REPO);
  assert.ok(clearDisabled(renderForm()));
  store.clear();
  assert.ok(clearDisabled(renderForm()), "an unseeded form has nothing to clear either");
});
