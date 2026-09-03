import { before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  ProductIssuePreflight,
  ProductIssuePreview,
} from "../src/shared/product-issues.ts";
import {
  ProductIssueModal,
  productIssueDraftPayload,
  type ProductIssueDraftState,
  type ProductIssueModalProps,
} from "../src/web/components/ProductIssueModal.tsx";
import { withOverlayHost } from "./helpers/overlay-host.ts";
import { assertElectronGuiLaunchAllowed } from "./helpers/electron-gui.ts";

/**
 * What the Feedback dialog does to the screen it is drawn on.
 *
 * `product-issue-render.test.ts` pins its markup and `e2e/specs/product-issue-reporting.spec.ts`
 * drives the journey, and neither can produce a used height. That matters here more than for
 * most dialogs, because this one is unusually tall by design: it carries a five-option form
 * AND a rendered preview of everything about to become public, and it is the only dialog in
 * the app whose confirm button a person MUST reach before anything happens.
 *
 * Three things follow, and all three are pixels rather than markup:
 *
 *  1. On a short window the dialog scrolls inside the backdrop instead of running off the
 *     bottom of it. A footer past the viewport with nothing scrollable above it is a Report
 *     button nobody can press.
 *  2. Neither the page nor the dialog scrolls SIDEWAYS when the daemon supplies a long
 *     repository name and a wide Markdown body - both unbounded strings that arrive from a
 *     response rather than from this repository.
 *  3. The screenshot region is actually drawn. A zero-height image input is unusable.
 *
 * createElement, not JSX, because the runner's glob only matches .test.ts.
 */

const require = createRequire(import.meta.url);

/** Same backstop the other geometry tests use: a hung browser fails, slowly. */
const ELECTRON_TIMEOUT_MS = 240_000;
/** What the fixture gets of that, leaving the rest for launch, exit and its own reporting. */
const FIXTURE_BUDGET_MS = ELECTRON_TIMEOUT_MS - 30_000;

/**
 * The window every number below is read in.
 *
 * Deliberately SHORT. A 900px-tall window has room for this dialog and would prove nothing;
 * 620px is a laptop with a dock, a browser chrome bar and a video call taking the top third,
 * which is where the confirm button actually goes missing.
 */
const VIEWPORT = { width: 1280, height: 620 };

const DRAFT: ProductIssueDraftState = {
  type: "bug",
  title: "Board tiles stop updating after a reconnect",
  details: "Killed the daemon, reconnected, and the tiles froze at their old counts.",
  attachments: [],
};

const PREFLIGHT: ProductIssuePreflight = {
  ready: true,
  target: "acme/public-issues",
  attachments: {
    enabled: true,
    reason: null,
  },
  problems: [],
};

/**
 * The widest thing the daemon can hand this dialog.
 *
 * Both halves are the shapes a real response takes rather than invented worst cases: GitHub
 * allows a 39-character owner and a 100-character name, and a report body is prose that has
 * already been through a `## Details` heading with no wrapping applied anywhere upstream.
 */
const WIDE_TARGET = `${"o".repeat(39)}/${"n".repeat(100)}`;
const WIDE_BODY = [
  "## Details",
  "",
  "x".repeat(600),
  "",
  "## Environment",
  "",
  "- Mission Control: 0.1.0",
  "",
  "<!-- mission-control-product-report:v1 -->",
].join("\n");

function preview(overrides: Partial<ProductIssuePreview> = {}): ProductIssuePreview {
  return {
    outcome: "preview",
    requestId: "11111111-2222-4333-8444-555555555555",
    draftIdentity: "a".repeat(64),
    draft: productIssueDraftPayload(DRAFT),
    target: "acme/public-issues",
    labels: ["bug", "status:needs-triage", "source:dashboard"],
    environment: {
      missionControlVersion: "0.1.0",
      platform: "macOS",
      architecture: "arm64",
      client: "browser",
    },
    body: "## Details\n\nShort.\n\n<!-- mission-control-product-report:v1 -->",
    attachments: PREFLIGHT.attachments,
    ...overrides,
  };
}

function dialog(overrides: Partial<ProductIssueModalProps> = {}): string {
  const props: ProductIssueModalProps = {
    draft: DRAFT,
    onDraftChange: () => {},
    preflight: PREFLIGHT,
    preview: preview(),
    previewProblem: null,
    previewing: false,
    confirmation: null,
    confirming: false,
    submitting: false,
    result: null,
    retryAllowed: true,
    onConfirm: () => {},
    onSubmit: () => {},
    onClear: () => {},
    onClose: () => {},
    ...overrides,
  };
  return renderToStaticMarkup(withOverlayHost(createElement(ProductIssueModal, props)));
}

const CASES: Array<[string, string]> = [
  ["ordinary", dialog()],
  [
    "wide",
    dialog({
      preview: preview({ target: WIDE_TARGET, body: WIDE_BODY }),
      previewProblem: null,
    }),
  ],
  [
    "refused",
    dialog({
      preview: null,
      result: {
        outcome: "refused",
        message:
          "GitHub CLI refused the issue: could not add label \"status:needs-triage\" to " +
          `${WIDE_TARGET} - run \`gh label create status:needs-triage --repo ${WIDE_TARGET}\``,
        retrySafe: true,
      },
    }),
  ],
];

interface Measured {
  viewportHeight: number;
  modalHeight: number;
  modalWidth: number;
  footBottomOverflow: number;
  backdropScrollable: number;
  documentOverflow: number;
  modalOverflow: number;
  shotsHeight: number | null;
  viewport: { width: number; height: number };
}

function page(styles: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><style>${styles}</style><div class="app">${body}</div>`;
}

let measured: Record<string, Measured>;

before(() => {
  assertElectronGuiLaunchAllowed();
  const electron = require("electron") as string;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const dir = mkdtempSync(join(tmpdir(), "mission-product-issue-"));
  const userData = mkdtempSync(join(tmpdir(), "mission-product-issue-profile-"));
  try {
    const styles = readFileSync(
      fileURLToPath(new URL("../src/web/styles.css", import.meta.url)),
      "utf8",
    );
    const paths = CASES.map(([name, body]) => {
      const path = join(dir, `${name}.html`);
      writeFileSync(path, page(styles, body));
      return path;
    });
    const output = execFileSync(
      electron,
      [
        ...(process.platform === "linux" ? ["--no-sandbox"] : []),
        `--user-data-dir=${userData}`,
        fileURLToPath(new URL("fixtures/product-issue-browser.cjs", import.meta.url)),
        "--viewport",
        `${VIEWPORT.width}x${VIEWPORT.height}`,
        "--budget-ms",
        String(FIXTURE_BUDGET_MS),
        // Last, because it takes the rest of the line.
        "--pages",
        ...paths,
      ],
      { encoding: "utf8", env, timeout: ELECTRON_TIMEOUT_MS },
    );
    measured = JSON.parse(output.trim()) as Record<string, Measured>;
  } finally {
    rmSync(dir, { force: true, recursive: true });
    rmSync(userData, { force: true, recursive: true });
  }
});

/**
 * A case's numbers, refused unless they were measured in the window that was asked for.
 *
 * Every assertion goes through here for the reason the Line strip's copy of it gives: a
 * window that wobbled can then only ever be reported as a window that wobbled, rather than
 * arriving as a layout regression in a dialog that did nothing.
 */
function at(name: string): Measured {
  const m = measured[name];
  assert.ok(m, `the fixture measured no case called ${name}`);
  const got = `${m.viewport.width}x${m.viewport.height}`;
  const want = `${VIEWPORT.width}x${VIEWPORT.height}`;
  assert.equal(
    got,
    want,
    `${name} was measured in a ${got} window, not the ${want} it asked for - these numbers `
      + `describe the window, not the layout`,
  );
  return m;
}

test("every case is measured in the window the fixture asked for", () => {
  for (const [name] of CASES) at(name);
});

test("the Report button stays reachable on a short window", () => {
  const m = at("ordinary");
  // The premise: this dialog really is taller than the window, so the assertion below is
  // not passing because there was nothing to scroll.
  assert.ok(
    m.modalHeight > m.viewportHeight - 96,
    `the dialog was only ${m.modalHeight}px in a ${m.viewportHeight}px window - this case no `
      + `longer exercises the overflow it exists for`,
  );
  // And the recovery: the backdrop scrolls by at least as much as the footer hangs past the
  // bottom, so the one control this dialog exists for can be brought onto the screen.
  assert.ok(
    m.backdropScrollable >= m.footBottomOverflow,
    `the footer sits ${m.footBottomOverflow}px past the viewport but the backdrop only `
      + `scrolls ${m.backdropScrollable}px - the Report button cannot be reached`,
  );
});

test("a daemon-supplied repository, body and refusal never scroll the page sideways", () => {
  for (const name of ["ordinary", "wide", "refused"]) {
    const m = at(name);
    assert.equal(
      m.documentOverflow,
      0,
      `${name} scrolled the page ${m.documentOverflow}px sideways`,
    );
    assert.equal(
      m.modalOverflow,
      0,
      `${name} scrolled the dialog ${m.modalOverflow}px sideways`,
    );
  }
  // And the dialog kept its measure rather than growing to fit the long strings.
  assert.equal(at("wide").modalWidth, at("ordinary").modalWidth);
});

test("the disabled screenshot region is drawn rather than collapsed", () => {
  // Zero height would be indistinguishable from a component that failed to render, which is
  // the opposite of what an intentionally-not-yet affordance has to communicate.
  const m = at("ordinary");
  assert.ok(
    (m.shotsHeight ?? 0) > 60,
    `the screenshot region laid out at ${m.shotsHeight}px - it reads as a rendering fault`,
  );
});
