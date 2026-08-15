import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ConductorPanel, detectionReading, offeredRepos, repoHealthLine } from "../src/web/components/ConductorPanel.tsx";
import type { ConductorState } from "../src/web/useConductor.ts";
import type { PipelineProbe, PipelinesView } from "../src/shared/pipeline.ts";

// What is at stake: this panel is the CONSENT surface, and consent has to be legible in
// both directions. Three different things can be false - the engine may not be installed,
// the master switch may be off, and a repository may not be switched on - and an operator
// who sees no pipelines has to be able to tell which, in one look. A panel that collapsed
// them into one "not configured" would send somebody to reinstall an engine that is working.
//
// The sharper claim is the one the Inspector and Shipping panels also make and which is
// easy to lose: before the daemon answers, the controls show DEFAULTS, and defaults are not
// a reading. Drawing them as fact tells an operator nothing is being observed while the
// stored config may have several repositories switched on.
//
// `renderToStaticMarkup` runs no effects, so this file renders exactly that pre-poll state
// unless a view is handed in. The click-to-route-to-daemon path is `e2e/specs/settings-conductor.spec.ts`.

/** A state with no answer yet - what a static render is, and what a first paint is. */
function unanswered(): ConductorState {
  return { view: null, save: async () => true, recheck: async () => {}, checking: false, error: null };
}

function probe(over: Partial<PipelineProbe> = {}): PipelineProbe {
  return {
    provider: "ai-conductor",
    found: true,
    bin: "conduct-ts",
    binPath: "/Users/someone/.local/bin/conduct-ts",
    version: "0.101.1",
    registryPath: "/Users/someone/.ai-conductor/registry.json",
    projects: [{ name: "demo", path: "/Users/someone/workspace/demo", remote: null, status: "registered" }],
    error: null,
    checkedAt: 1_700_000_000_000,
    ...over,
  };
}

function answered(over: Partial<PipelinesView> = {}): ConductorState {
  return {
    view: {
      config: { enabled: false, repos: [] },
      probes: [probe()],
      status: [],
      ...over,
    },
    save: async () => true,
    recheck: async () => {},
    checking: false,
    error: null,
  };
}

function render(state: ConductorState): string {
  return renderToStaticMarkup(createElement(ConductorPanel, { state }));
}

test("with no answer from the daemon, the panel says so rather than showing defaults as fact", () => {
  const html = render(unanswered());
  assert.match(html, /conductor-unknown/);
  assert.match(html, /is unknown/);
  // And it must not assert an empty repository list, which would read as "the engine
  // manages nothing" on a machine where it manages six.
  assert.doesNotMatch(
    html,
    /No repositories registered with the engine/,
    "an unanswered panel must not assert an empty list",
  );
  assert.match(html, /The repository list is unknown until the daemon answers/);
});

test("every control is disabled until the first read lands", () => {
  // A live-looking switch in that window would let a click race the fetch and write a
  // config composed from defaults the daemon never sent.
  const html = render(unanswered());
  for (const control of html.match(/<(input|button)[^>]*>/g) ?? []) {
    assert.match(control, /disabled/, `control should be disabled pre-poll: ${control}`);
  }
});

test("the panel ships off, and says which of the three reasons applies", () => {
  // Nothing enabled, engine present. The sentence has to name the master switch rather than
  // the repositories, because that is the control an operator has to move first.
  const off = render(answered());
  assert.match(off, /Off - no pipeline state is being read/);
  const toggles = off.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? [];
  assert.ok(toggles.length > 0, "the panel has a master switch");
  assert.doesNotMatch(toggles[0]!, /checked/, "the master switch ships off");

  // Master on, nothing consented to: a different sentence, because the next move differs.
  const armedButEmpty = render(
    answered({ config: { enabled: true, repos: [] } }),
  );
  assert.match(armedButEmpty, /On, but no repository is switched on/);

  // Master on, one repository consented to.
  const live = render(
    answered({
      config: { enabled: true, repos: [{ provider: "ai-conductor", repoRoot: "/w/demo", enabled: true }] },
    }),
  );
  assert.match(live, /On - reading 1 repository/);
});

test("the panel says the integration never writes, which the word conductor invites you to assume", () => {
  const html = render(answered());
  assert.match(html, /never writes them/);
  assert.match(html, /never starts or stops a pipeline/);
});

test("detection names the engine, its version and where the registry was looked for", () => {
  const html = render(answered());
  assert.match(html, /Installed at \/Users\/someone\/\.local\/bin\/conduct-ts/);
  assert.match(html, /version 0\.101\.1/);
  // Always printed. A wrong `$AI_CONDUCTOR_REGISTRY` is the one misconfiguration that shows
  // up as an empty repository list with no error at all.
  assert.match(html, /\/Users\/someone\/\.ai-conductor\/registry\.json/);
});

test("an absent engine is reported once, in its own words, and not also as an error", () => {
  // A missing engine's `error` restates its state line verbatim. Rendering both puts the
  // same sentence on screen twice - once neutral, once in the error tone - which reads as
  // two problems and sends somebody looking for the second one.
  const html = render(
    answered({
      probes: [
        probe({
          found: false,
          binPath: null,
          version: null,
          projects: [],
          error: "conduct-ts is not on this daemon's PATH",
        }),
      ],
    }),
  );
  // React escapes the apostrophe, so the assertion is on the clause either side of it.
  assert.match(html, /Not installed - conduct-ts is not on this daemon/);
  assert.equal(
    (html.match(/is not on this daemon/g) ?? []).length,
    1,
    "the same sentence must not appear twice",
  );
  assert.doesNotMatch(html, /class="settings-error"/);
});

test("an engine that WAS found and then could not answer prints why", () => {
  const html = render(
    answered({
      probes: [probe({ error: "could not read /Users/someone/.ai-conductor/registry.json" })],
    }),
  );
  assert.match(html, /class="settings-error"/);
  assert.match(html, /could not read/);
});

test("a version this build could not derive says so rather than inventing one", () => {
  // There is no `--version` flag on the engine, so the version is derived from the
  // installation layout. A layout this build does not recognise must not become a number.
  const html = render(answered({ probes: [probe({ version: null })] }));
  assert.match(html, /version unknown/);
});

test("a repository row carries its path, its switch and its health", () => {
  const html = render(
    answered({
      config: { enabled: true, repos: [{ provider: "ai-conductor", repoRoot: "/w/demo", enabled: true }] },
      probes: [probe({ projects: [] })],
      status: [
        {
          provider: "ai-conductor",
          repoRoot: "/w/demo",
          daemon: "running",
          runs: 3,
          halted: 1,
          lastReadAt: 1_700_000_000_000,
          error: null,
        },
      ],
    }),
  );
  assert.match(html, /Observe pipelines in demo/, "the switch names the repository");
  assert.match(html, /\/w\/demo/);
  assert.match(html, /engine daemon running · 3 pipelines, 1 halted/);
});

test("the health line distinguishes not-read-yet from nothing-there", () => {
  // The distinction the Inspector panel's "unknown" state makes, applied per repository. A
  // just-enabled repository reporting `0 pipelines` sends an operator to debug an engine
  // that is working perfectly.
  assert.match(repoHealthLine(undefined, true), /not read yet/);
  assert.match(
    repoHealthLine(
      { provider: "ai-conductor", repoRoot: "/w/a", daemon: "running", runs: 0, halted: 0, lastReadAt: null, error: null },
      true,
    ),
    /not read yet/,
  );
  assert.match(
    repoHealthLine(
      { provider: "ai-conductor", repoRoot: "/w/a", daemon: "running", runs: 0, halted: 0, lastReadAt: 1, error: null },
      true,
    ),
    /0 pipelines/,
  );
  // And a repository the master switch has turned off says THAT, rather than reporting the
  // last figures it happened to hold.
  assert.match(repoHealthLine(undefined, false), /Not observed/);
});

test("the daemon state is named in words, per repository", () => {
  const line = (daemon: "running" | "paused" | "stopped" | "unknown"): string =>
    repoHealthLine(
      { provider: "ai-conductor", repoRoot: "/w/a", daemon, runs: 1, halted: 0, lastReadAt: 1, error: null },
      true,
    );
  assert.match(line("running"), /engine daemon running/);
  assert.match(line("paused"), /engine daemon paused/);
  // The one an operator acts on: nothing is going to advance, and that is not the same as
  // "nothing is happening right now".
  assert.match(line("stopped"), /no engine daemon running here/);
  assert.match(line("unknown"), /state unknown/);
});

test("a repository the engine has forgotten stays listed while its consent stands", () => {
  // Otherwise the consent would be in force with nothing on screen that could withdraw it.
  const repos = offeredRepos(
    { enabled: true, repos: [{ provider: "ai-conductor", repoRoot: "/w/de-registered", enabled: true }] },
    [probe({ projects: [{ name: "demo", path: "/w/demo", remote: null, status: "registered" }] })],
  );
  assert.deepEqual(repos.map((r) => r.repoRoot), ["/w/de-registered", "/w/demo"]);
  assert.equal(repos.find((r) => r.repoRoot === "/w/de-registered")?.enabled, true);
  // A repository the engine reports and nobody has consented to is offered, and OFF.
  assert.equal(repos.find((r) => r.repoRoot === "/w/demo")?.enabled, false);
});

test("detection before the first read is unknown, not absent", () => {
  // Reachable in production, not only pre-poll: the daemon answers an ordinary read from
  // its held probe rather than waiting for a subprocess, so the FIRST read of a fresh
  // daemon legitimately carries no probe at all and the next one carries the answer.
  assert.deepEqual(detectionReading(undefined), {
    tone: "unknown",
    text: "Looking for the engine…",
  });
  const html = render(answered({ probes: [] }));
  assert.match(html, /Looking for the engine/);
  // And it must not read as "not installed" - the two send an operator to different places.
  assert.doesNotMatch(html, /Not installed/);
});
