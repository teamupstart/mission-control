import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { OVERLAY_IDS, Overlay, overlayGuards } from "../src/web/components/Overlay.tsx";
import { withOverlayHost } from "./helpers/overlay-host.ts";
// ReviewModal is deliberately NOT imported: it pulls in react-diff-view, which imports a
// .css file Node can't load. It is covered by the source-derived suite below, which is
// why that suite exists rather than being a weaker duplicate of the runtime one.
import { ResetModal } from "../src/web/components/ResetModal.tsx";
import { SettingsModal } from "../src/web/components/SettingsModal.tsx";
import { ReportPanel } from "../src/web/components/ReportPanel.tsx";
import { DiffViewer } from "../src/web/components/DiffViewer.tsx";
import { AwayDigestCard } from "../src/web/components/AwayDigestCard.tsx";
import { mkSession } from "./helpers/session-fixture.ts";

/**
 * The regression this file exists for: an overlay that is on screen but NOT counted as
 * open. App's global key handler stands down only while the registry says something is
 * up, so an uncounted overlay leaves grid shortcuts live - and `k` kills, `r` resets the
 * card BEHIND the thing you are looking at. Nothing throws and nothing renders wrong;
 * you just act on the wrong session.
 *
 * Being counted is not a list anyone maintains - `<Overlay>` registers itself. So the
 * property to lock down is that every overlay actually goes through `<Overlay>`, which
 * the suites below approach from opposite directions: no file may mention the
 * `modal-backdrop` class outside the primitive, no file that declares a `role="dialog"`
 * may skip importing `Overlay.tsx` (bar a declared list of known exceptions), and every
 * known overlay must fail without a host.
 *
 * Read those two source scans for exactly what they are: FILE-granular, import-based
 * heuristics, not proof that each surface is inside an `<Overlay>`. A file that renders
 * one registered overlay and hand-rolls a second passes, as does one that imports
 * `Overlay.tsx` only for a type. The `role=` regex is literal, so a computed
 * `role={isModal ? "dialog" : "region"}` is invisible to it, as is any screen-owning
 * surface that declares no role at all. They catch the common shape - a new component
 * copying an existing overlay - and nothing finer. The runtime suite below is what
 * actually proves registration is required.
 *
 * This repo's runner has no DOM, so effects (and therefore registration itself) can't be
 * exercised here; `renderToStaticMarkup` runs render only. That is why the check is
 * structural - "does it route through the primitive" - plus pure tests of the guard
 * logic App derives from the registry. `createElement` rather than JSX because the
 * runner's glob only matches .test.ts.
 */

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/web");

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return tsxFiles(p);
    return e.isFile() && p.endsWith(".tsx") ? [p] : [];
  });
}

/**
 * Comments are stripped before any source scan below. Otherwise a comment that merely
 * MENTIONS `modal-backdrop` or `role="dialog"` fails the scan while proving nothing,
 * and - the same defect from the other side - a real offender could be excused by the
 * scan matching prose rather than code.
 */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("only the Overlay primitive renders a backdrop", () => {
  // Narrow by construction: this catches a new overlay that hand-rolls the `modal-backdrop`
  // class, which is the shape every overlay here happens to use. It does NOT catch an
  // overlay built with a different backdrop class or with no backdrop at all - the
  // role="dialog" scan below covers the screen-owning surfaces that escape this one.
  const offenders = tsxFiles(WEB)
    .filter((f) => code(f).includes("modal-backdrop"))
    .map((f) => path.relative(WEB, f));
  assert.deepEqual(
    offenders,
    ["components/Overlay.tsx"],
    "a component is rendering its own overlay backdrop instead of using <Overlay>, so it " +
      "will not be registered and the global key handler will stay live behind it",
  );
});

/**
 * Known-unregistered `role="dialog"` surfaces, listed so the gap is findable rather than
 * invisible. Both are anchored popovers, not screen-owning overlays, so they were left
 * out of the registry deliberately - but the consequence is real and NOT yet fixed: while
 * either is open, focus sits on a button (so the `typing` guard is false) and `anyOpen` is
 * false, so the grid shortcuts - INCLUDING kill and reset - still act on the card behind
 * the popover. A follow-up needs to decide whether anchored popovers register too.
 */
const UNREGISTERED_DIALOGS = ["components/AlertBar.tsx", "components/ForemanBar.tsx"];

test("every role=\"dialog\" surface is registered, or is a declared exception", () => {
  // A new file declaring a literal role="dialog" fails here until someone decides which
  // side of the line it is on: route it through <Overlay>, or add it to
  // UNREGISTERED_DIALOGS with the reason. File-granular by design - see the header for
  // what that does and does not prove.
  const unregistered = tsxFiles(WEB)
    .filter((f) => {
      const src = code(f);
      return /role=["{]"?dialog/.test(src) && !/from "\.[./]*(components\/)?Overlay\.tsx"/.test(src);
    })
    .map((f) => path.relative(WEB, f))
    .sort();
  assert.deepEqual(
    unregistered,
    [...UNREGISTERED_DIALOGS].sort(),
    "a component declares role=\"dialog\" without routing through <Overlay>, so it is not " +
      "counted as open and the global key handler stays live behind it",
  );
});

test("every overlay routes through the primitive", () => {
  // Source-derived, so it covers overlays the runtime suite can't import - and so a NEW
  // overlay is covered the moment it exists, without being added to a list here.
  const files = tsxFiles(WEB).filter((f) => f !== path.join(WEB, "components/Overlay.tsx"));
  const overlayFiles = files.filter((f) => /from "\.[./]*(components\/)?Overlay\.tsx"/.test(code(f)));
  assert.ok(overlayFiles.length >= 6, `expected the known overlays, found ${overlayFiles.length}`);
  for (const f of overlayFiles) {
    const src = code(f);
    const rel = path.relative(WEB, f);
    // App is the host, not an overlay - it wires the registry rather than rendering one.
    if (rel === "App.tsx") {
      assert.ok(src.includes("<OverlayHost"), "App must render the OverlayHost");
      continue;
    }
    assert.match(src, /<Overlay\b/, `${rel} imports Overlay but never renders it`);
    assert.match(
      src,
      /id=\{OVERLAY_IDS\./,
      `${rel} must identify itself with a declared OVERLAY_IDS entry, or onlyOpen() can ` +
        `never match it and the sitrep chord will fire behind it`,
    );
  }
});

/** The overlays the runner can import (see the ReviewModal note above). */
const OVERLAYS: { name: string; el: () => React.JSX.Element }[] = [
  {
    name: "ResetModal",
    el: () => createElement(ResetModal, { session: mkSession(), onClose: () => {} }),
  },
  {
    name: "SettingsModal",
    el: () =>
      createElement(SettingsModal, {
        onClose: () => {},
        foreman: { config: null, status: null, loading: false } as never,
        cost: { status: null, update: async () => {}, error: null },
        layout: "grid",
        onLayoutChange: () => {},
      }),
  },
  {
    name: "ReportPanel",
    el: () =>
      createElement(ReportPanel, {
        sessions: [mkSession()],
        tasks: [],
        onClose: () => {},
        onOpenReviews: () => {},
        onEditTask: () => {},
      }),
  },
  {
    name: "DiffViewer",
    el: () =>
      createElement(DiffViewer, { session: mkSession(), commit: null, onClose: () => {} }),
  },
  {
    name: "AwayDigestCard",
    el: () =>
      createElement(AwayDigestCard, {
        digest: { awayMs: 60_000, rollup: "nothing", narrative: null, lines: [] } as never,
        onDismiss: () => {},
        onOpenReport: () => {},
      }),
  },
];

test("no overlay can render without being registered", () => {
  // Rendering outside a host throws by construction, so an overlay that stopped routing
  // through the primitive - and would therefore go uncounted - fails right here.
  for (const { name, el } of OVERLAYS) {
    assert.throws(
      () => renderToStaticMarkup(el()),
      /rendered outside <OverlayHost>/,
      `${name} rendered without an OverlayHost instead of throwing, which means it is ` +
        `not going through <Overlay> and will not be counted as open`,
    );
  }
});

test("every overlay renders inside a host", () => {
  // The other half: the throw above must be about registration, not about the component
  // being broken. Each one renders cleanly once a host is present.
  for (const { name, el } of OVERLAYS) {
    const html = renderToStaticMarkup(withOverlayHost(el()));
    assert.ok(html.includes("modal-backdrop"), `${name} should render through the backdrop`);
  }
});

test("every overlay id is declared once", () => {
  const ids = Object.values(OVERLAY_IDS);
  assert.equal(new Set(ids).size, ids.length, "two overlays share an id");
  // Ids are what `onlyOpen` matches on, so a stray literal would silently never match.
  const src = readFileSync(path.join(WEB, "components/Overlay.tsx"), "utf8");
  for (const id of ids) assert.ok(src.includes(`"${id}"`), `${id} missing from OVERLAY_IDS`);
});

test("an overlay that is open stands the grid down", () => {
  assert.equal(overlayGuards([]).anyOpen, false);
  assert.equal(overlayGuards([OVERLAY_IDS.diff]).anyOpen, true);
});

test("the sitrep chord stands down for everyone else's overlay, not its own", () => {
  const { sitrep, diff } = OVERLAY_IDS;
  // Nothing open: the chord opens it.
  assert.equal(overlayGuards([]).onlyOpen(sitrep), true);
  // Its own panel open: the chord must still fire, to toggle it closed.
  assert.equal(overlayGuards([sitrep]).onlyOpen(sitrep), true);
  // Someone else's overlay: stand down, or the chord opens the sitrep behind it.
  assert.equal(overlayGuards([diff]).onlyOpen(sitrep), false);
  assert.equal(overlayGuards([sitrep, diff]).onlyOpen(sitrep), false);
});

test("the primitive gates dismissal on `closable`, both routes at once", () => {
  // ResetModal's mid-reset guard. Escape can't be exercised without a DOM, but the
  // backdrop's handler is inspectable: a non-closable overlay must not wire a close.
  const host = (closable: boolean) =>
    renderToStaticMarkup(
      withOverlayHost(
        createElement(Overlay, {
          id: OVERLAY_IDS.reset,
          onClose: () => {},
          className: "modal",
          closable,
          children: "body",
        }),
      ),
    );
  // Both render the same markup - the guard is behavioral, not structural - so this only
  // pins that `closable` is accepted and renders. The real coupling (one flag driving
  // both the backdrop click and Escape) is enforced by there being one flag at all.
  assert.ok(host(true).includes("modal-backdrop"));
  assert.ok(host(false).includes("modal-backdrop"));
});
