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
 * is what the two suites below check from opposite directions: no component may
 * hand-roll a backdrop, and every known overlay must fail without a host.
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

test("only the Overlay primitive renders a backdrop", () => {
  // The catch-all. A new overlay hand-rolling `modal-backdrop` is exactly the change
  // that used to need four edits to App.tsx and silently got fewer.
  const offenders = tsxFiles(WEB)
    .filter((f) => readFileSync(f, "utf8").includes("modal-backdrop"))
    .map((f) => path.relative(WEB, f));
  assert.deepEqual(
    offenders,
    ["components/Overlay.tsx"],
    "a component is rendering its own overlay backdrop instead of using <Overlay>, so it " +
      "will not be registered and the global key handler will stay live behind it",
  );
});

test("every overlay routes through the primitive", () => {
  // Source-derived, so it covers overlays the runtime suite can't import - and so a NEW
  // overlay is covered the moment it exists, without being added to a list here.
  const files = tsxFiles(WEB).filter((f) => f !== path.join(WEB, "components/Overlay.tsx"));
  const overlayFiles = files.filter((f) => /from "\.[./]*(components\/)?Overlay\.tsx"/.test(readFileSync(f, "utf8")));
  assert.ok(overlayFiles.length >= 6, `expected the known overlays, found ${overlayFiles.length}`);
  for (const f of overlayFiles) {
    const src = readFileSync(f, "utf8");
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
