import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { homeRelative, type SetupChecksSnapshot, type SetupRowView } from "../src/shared/setup-catalog.ts";
import { SetupPanel, familyForAnchor, nextSetupSelection } from "../src/web/components/SetupPanel.tsx";

const HOME = "/home/operator";

function row(over: Partial<SetupRowView> & Pick<SetupRowView, "rowId" | "family">): SetupRowView {
  return {
    label: "Claude Code",
    requirement: "recommended",
    enables: "Cannot launch Claude.",
    remedy: { kind: "command", argv: ["npm", "install", "claude"], note: "Copy command" },
    status: { state: "satisfied", evidence: `${HOME}/.local/bin/claude` },
    ...over,
  } as SetupRowView;
}

function render(rows: SetupRowView[], jumpAnchor: string | null = null): string {
  const view: SetupChecksSnapshot = {
    snapshotToken: "00000000-0000-4000-8000-000000000000",
    rows,
    home: HOME,
    banner: { visible: true, attentionRowIds: [], attentionCount: 0 },
  };
  return renderToStaticMarkup(createElement(SetupPanel, {
    state: { loading: false, error: null, refresh: async () => {}, dismissBanner: async () => null, view },
    jumpAnchor,
    jumpRequestId: jumpAnchor ? 1 : null,
  }));
}

const CLAUDE = row({ rowId: { source: "dependency", id: "claude-cli" }, family: "agents" });
const GH_CLI = row({
  rowId: { source: "dependency", id: "gh-cli" },
  family: "github",
  label: "GitHub CLI",
  requirement: "required",
  enables: "Cannot inspect GitHub work.",
  status: { state: "missing" },
});
const CMUX = row({
  rowId: { source: "dependency", id: "cmux" },
  family: "terminals",
  label: "cmux",
  requirement: "optional",
  enables: "No durable workspaces.",
  status: { state: "missing" },
});

test("the rail reports no health for a family it has not read yet", () => {
  // A family with no rows has no gaps, which is not the same as being fine. Drawing the dot
  // anyway paints a clean bill of health for a machine still being inspected.
  const view: SetupChecksSnapshot = {
    snapshotToken: "00000000-0000-4000-8000-000000000000",
    rows: [],
    home: HOME,
    banner: { visible: false, attentionRowIds: [], attentionCount: 0 },
  };
  const loading = renderToStaticMarkup(createElement(SetupPanel, {
    state: { loading: true, error: null, refresh: async () => {}, dismissBanner: async () => null, view },
  }));
  assert.doesNotMatch(loading, /setup-dot-ready/, "nothing has been established yet");
  assert.doesNotMatch(loading, /setup-dot-gap/);
  assert.match(loading, /Reading this machine/);
  // A family that HAS been read says so, either way.
  const read = render([CLAUDE, CMUX, GH_CLI]);
  assert.match(read, /setup-dot-ready/);
  assert.match(read, /setup-dot-gap/);
});

test("the rail lists every family always, and the pane renders only the selected one", () => {
  const html = render([CLAUDE, CMUX, GH_CLI]);
  // Every family stays reachable even though only one family's rows are mounted - that is
  // what keeps a deep link and the guided tour able to ask for any of them.
  for (const id of ["agents", "terminals", "github", "extensions", "pipelines"]) {
    assert.match(html, new RegExp(`id="setup-family-${id}"`));
    assert.match(html, new RegExp(`data-anchor="setup/family-${id}"`));
  }
  assert.equal(html.match(/class="setup-pane"/g)?.length, 1);
  // GitHub holds the only required gap, so the rail opens there rather than on the catalog's
  // first family, and the other families' rows are absent rather than merely scrolled away.
  assert.match(html, /data-anchor="setup\/dependency-gh-cli"/);
  assert.doesNotMatch(html, /data-anchor="setup\/dependency-claude-cli"/);
  assert.doesNotMatch(html, /data-anchor="setup\/dependency-cmux"/);
});

test("a required gap outranks an optional one when the rail picks its opening family", () => {
  // Terminals comes before GitHub in catalog order and also has a gap, so "first family with
  // any gap" would open on the optional one and bury the row that actually blocks work.
  assert.match(render([CLAUDE, CMUX, GH_CLI]), /data-anchor="setup\/dependency-gh-cli"/);
  // With no required gap left, the first family holding any gap wins.
  const repaired = { ...GH_CLI, status: { state: "satisfied", evidence: "/usr/bin/gh" } } as SetupRowView;
  assert.match(render([CLAUDE, CMUX, repaired]), /data-anchor="setup\/dependency-cmux"/);
  // And with nothing missing at all, the catalog's first family.
  const allReady = [CLAUDE, { ...CMUX, status: { state: "satisfied", evidence: "/usr/bin/cmux" } } as SetupRowView, repaired];
  assert.match(render(allReady), /data-anchor="setup\/dependency-claude-cli"/);
});

test("a deep link to a row selects the family that holds it", () => {
  // Without this the settings page's flash observer waits on an element that never mounts,
  // and a Foreman or palette link into Setup silently lights nothing at all.
  const html = render([CLAUDE, CMUX, GH_CLI], "setup/dependency-cmux");
  assert.match(html, /data-anchor="setup\/dependency-cmux"/);
  assert.doesNotMatch(html, /data-anchor="setup\/dependency-gh-cli"/);
});

test("a deep link to a family selects it, which is how the guided tour drives the rail", () => {
  const html = render([CLAUDE, CMUX, GH_CLI], "setup/family-agents");
  assert.match(html, /data-anchor="setup\/dependency-claude-cli"/);
  assert.doesNotMatch(html, /data-anchor="setup\/dependency-gh-cli"/);
});

test("familyForAnchor resolves both anchor shapes and refuses anything else", () => {
  const rows = [CLAUDE, CMUX, GH_CLI];
  assert.equal(familyForAnchor("setup/family-pipelines", rows), "pipelines");
  assert.equal(familyForAnchor("setup/dependency-cmux", rows), "terminals");
  assert.equal(familyForAnchor("setup/dependency-ghostty", rows), null, "a row this snapshot does not carry");
  assert.equal(familyForAnchor("setup/recheck", rows), null);
  assert.equal(familyForAnchor("setup/family-nonsense", rows), null);
});

test("a satisfied row states its evidence relative to home and keeps the absolute path", () => {
  const html = render([CLAUDE, CMUX, GH_CLI], "setup/family-agents");
  assert.match(html, /~\/\.local\/bin\/claude/);
  // The absolute path moves into the shared Tooltip's always-rendered description, which is
  // what makes it reachable by a screen reader as well as a pointer.
  assert.match(html, /class="tt-desc">\/home\/operator\/\.local\/bin\/claude</);
  assert.doesNotMatch(html, /title="/, "the native title attribute is not this app's tooltip");
});

test("evidence outside the home directory gets no tooltip repeating what is on screen", () => {
  const brew = { ...CMUX, status: { state: "satisfied", evidence: "/opt/homebrew/bin/cmux" } } as SetupRowView;
  const html = render([CLAUDE, brew, GH_CLI], "setup/family-terminals");
  assert.match(html, /\/opt\/homebrew\/bin\/cmux/);
  assert.equal(
    html.match(/\/opt\/homebrew\/bin\/cmux/g)?.length,
    1,
    "shortening hid nothing, so there is nothing for a hover to add",
  );
});

test("a satisfied row drops the status pill and the requirement word it cannot act on", () => {
  const html = render([CLAUDE, CMUX, GH_CLI], "setup/family-agents");
  assert.doesNotMatch(html, /setup-status-satisfied/, "the dot and the evidence already say Ready");
  assert.doesNotMatch(html, /setup-requirement-recommended/, "a decision already made, on every healthy row");
  // A gap keeps both, because both change what the operator does next.
  const gaps = render([CLAUDE, CMUX, GH_CLI]);
  assert.match(gaps, /setup-status-missing/);
  assert.match(gaps, /setup-requirement-required/);
});

test("the verdict names a required gap, and counts every check rather than one family", () => {
  const blocked = render([CLAUDE, CMUX, GH_CLI]);
  assert.match(blocked, /This machine is missing something required/);
  assert.match(blocked, /1 of 3 ready/);
  assert.match(blocked, /1 required gap blocks work/);

  const repaired = { ...GH_CLI, status: { state: "satisfied", evidence: "/usr/bin/gh" } } as SetupRowView;
  const usable = render([CLAUDE, CMUX, repaired]);
  assert.match(usable, /This machine can run sessions/);
  assert.match(usable, /no required gaps\. 1 optional tool would add capability/);
});

test("the panel keeps the host-owned remedy states and copyable commands", () => {
  const html = render([
    CLAUDE,
    row({
      rowId: { source: "dependency", id: "ai-conductor" },
      family: "pipelines",
      label: "ai-conductor",
      requirement: "optional",
      enables: "Cannot run pipelines.",
      remedy: { kind: "provider-installer", provider: "ai-conductor" },
      status: { state: "missing" },
    }),
  ]);
  assert.match(html, /Checking workspace repositories/);
  assert.match(html, /Remedies open in a visible terminal you can watch/);
  assert.match(html, />Re-check</);
  assert.doesNotMatch(html, /name="argv"/);
});

// The rail's selection precedence, which no markup assertion can reach: these are the
// transitions BETWEEN renders, and `renderToStaticMarkup` only ever produces one.
test("the opening family is latched once, so a repair cannot move the rail", () => {
  const rows = [CLAUDE, CMUX, GH_CLI];
  const blank = { chosen: null, seenRequest: null };
  const noJump = { jumpRequestId: null, jumpFamily: null };

  // First snapshot: latch where the required gap is.
  const first = nextSetupSelection(blank, { rows, ...noJump });
  assert.deepEqual(first, { chosen: "github", seenRequest: null });

  // The repair that would have moved it. `defaultFamily` now answers "terminals", and the
  // point of latching is that the selection does not follow.
  const repaired = [CLAUDE, CMUX, { ...GH_CLI, status: { state: "satisfied", evidence: "/usr/bin/gh" } } as SetupRowView];
  assert.equal(
    nextSetupSelection({ chosen: "github", seenRequest: null }, { rows: repaired, ...noJump }),
    null,
    "nothing to change: the operator stays in the family they were reading",
  );
});

test("a deep link outranks the latch, and is not consumed before it can be resolved", () => {
  const rows = [CLAUDE, CMUX, GH_CLI];

  // Arrives before the snapshot. Consuming it here is what silently dropped the link: the
  // panel starts fetching as it mounts, so this is the ordinary case, not the rare one.
  assert.equal(
    nextSetupSelection({ chosen: null, seenRequest: null }, {
      rows: [],
      jumpRequestId: 7,
      jumpFamily: null,
    }),
    null,
    "unresolvable and unconsumed while there are no rows",
  );

  // Rows arrive, the anchor resolves, and it beats the default that would have won.
  assert.deepEqual(
    nextSetupSelection({ chosen: null, seenRequest: null }, {
      rows,
      jumpRequestId: 7,
      jumpFamily: "terminals",
    }),
    { chosen: "terminals", seenRequest: 7 },
  );

  // It also beats a family the operator had already clicked, because a fresh request is an
  // explicit "show me this one".
  assert.deepEqual(
    nextSetupSelection({ chosen: "agents", seenRequest: 7 }, {
      rows,
      jumpRequestId: 8,
      jumpFamily: "pipelines",
    }),
    { chosen: "pipelines", seenRequest: 8 },
  );

  // The same request is applied once. After it is seen, the operator's click stands.
  assert.equal(
    nextSetupSelection({ chosen: "agents", seenRequest: 8 }, {
      rows,
      jumpRequestId: 8,
      jumpFamily: "pipelines",
    }),
    null,
    "already consumed, so it must not drag the rail back off the operator's choice",
  );
});

test("an anchor naming nothing this build renders is consumed, not waited on forever", () => {
  const rows = [CLAUDE, CMUX, GH_CLI];
  // Rows are present and the anchor still does not resolve, so it names a row this snapshot
  // does not carry. Consumed, and the ordinary default applied - otherwise `seenRequest`
  // never advances and the selection stays derived, re-deciding on every Re-check.
  assert.deepEqual(
    nextSetupSelection({ chosen: null, seenRequest: null }, {
      rows,
      jumpRequestId: 3,
      jumpFamily: null,
    }),
    { chosen: "github", seenRequest: 3 },
  );
  // With a family already chosen, such a request changes nothing but is still consumed.
  assert.deepEqual(
    nextSetupSelection({ chosen: "agents", seenRequest: 3 }, {
      rows,
      jumpRequestId: 4,
      jumpFamily: null,
    }),
    { chosen: "agents", seenRequest: 4 },
  );
});

test("homeRelative rewrites only a true child of the home directory", () => {
  assert.equal(homeRelative("/home/operator/.local/bin/claude", HOME), "~/.local/bin/claude");
  assert.equal(homeRelative("/home/operator", HOME), "~");
  assert.equal(homeRelative("/opt/homebrew/bin/tmux", HOME), "/opt/homebrew/bin/tmux");
  // A sibling that merely shares the prefix must survive intact - the bug a bare
  // `startsWith` without the separator check would ship.
  assert.equal(homeRelative("/home/operator2/bin/gh", HOME), "/home/operator2/bin/gh");
  // Evidence that is a sentence rather than a path is left alone.
  assert.equal(homeRelative("Authenticated to github.com", HOME), "Authenticated to github.com");
  assert.equal(homeRelative("/home/operator/x", ""), "/home/operator/x", "no home reported");
});
