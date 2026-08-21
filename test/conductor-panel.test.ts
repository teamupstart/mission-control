import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ConductorPanel, detectionReading, offeredRepos, repoHealthLine } from "../src/web/components/ConductorPanel.tsx";
import {
  PipelineDispatchConstraint,
  pipelineAgentForKindTransition,
} from "../src/web/components/DispatchModal.tsx";
import { configWithObservation, type ConductorState } from "../src/web/useConductor.ts";
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
  return {
    view: null,
    workspaceRepos: [],
    save: async () => true,
    registerAndObserve: async () => true,
    enableObservation: async () => true,
    recheck: async () => {},
    checking: false,
    setup: null,
    setupNotice: null,
    installers: null,
    installersLoading: false,
    installerError: null,
    openingInstaller: null,
    installerNotice: null,
    openInstaller: async () => true,
    error: null,
  };
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
      config: { enabled: false, launchRuntime: "agent-sdk", foremanMechanicalTriage: false, repos: [] },
      probes: [probe()],
      status: [],
      ...over,
    },
    workspaceRepos: ["/Users/someone/workspace/demo"],
    save: async () => true,
    registerAndObserve: async () => true,
    enableObservation: async () => true,
    recheck: async () => {},
    checking: false,
    setup: null,
    setupNotice: null,
    installers: null,
    installersLoading: false,
    installerError: null,
    openingInstaller: null,
    installerNotice: null,
    openInstaller: async () => true,
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
  assert.match(off, /Foreman does not act on pipeline halts/);

  // Master on, nothing consented to: a different sentence, because the next move differs.
  const armedButEmpty = render(
    answered({ config: { enabled: true, launchRuntime: "agent-sdk", foremanMechanicalTriage: false, repos: [] } }),
  );
  assert.match(armedButEmpty, /On, but no repository is switched on/);

  // Master on, one repository consented to.
  const live = render(
    answered({
      config: { enabled: true, launchRuntime: "agent-sdk", foremanMechanicalTriage: false, repos: [{ provider: "ai-conductor", repoRoot: "/w/demo", enabled: true }] },
    }),
  );
  assert.match(live, /On - reading 1 repository/);
});

test("Launch runtime renders SDK as the default and Terminal as an explicit stored choice", () => {
  const sdk = render(answered());
  const sdkRadio = (sdk.match(/<input[^>]*name="conductor-launch-runtime"[^>]*value="agent-sdk"[^>]*>/) ?? [])[0] ?? "";
  assert.match(sdkRadio, /checked/);
  assert.match(sdk, /Managed Agent SDK - the shipped default, with no Terminal fallback/);
  assert.match(sdk, /background build daemon keeps its own tmux supervision/);

  const terminal = render(
    answered({
      config: {
        enabled: false,
        launchRuntime: "terminal",
        foremanMechanicalTriage: false,
        repos: [],
      },
    }),
  );
  const terminalRadio = (terminal.match(/<input[^>]*name="conductor-launch-runtime"[^>]*value="terminal"[^>]*>/) ?? [])[0] ?? "";
  assert.match(terminalRadio, /checked/);
  assert.match(terminal, /Terminal - the explicit Claude-only compatibility host/);
});

test("pipeline dispatch renders the selected host contract without offering a fallback", () => {
  const sdk = renderToStaticMarkup(
    createElement(PipelineDispatchConstraint, { runtime: "agent-sdk" }),
  );
  assert.match(sdk, /selected Claude or Codex host with its Engineer skill as turn one/);
  assert.match(sdk, /harness&#x27;s configured defaults/);
  assert.match(sdk, /managed launch failure does not fall back to Terminal/);
  assert.match(sdk, /provider projection owns task completion/);
  assert.match(sdk, /background build daemon keeps its own tmux supervision/);
  assert.doesNotMatch(sdk, /fallback/i);

  const terminal = renderToStaticMarkup(
    createElement(PipelineDispatchConstraint, { runtime: "terminal" }),
  );
  assert.match(terminal, /conduct-ts engineer --idea in a real terminal with live stdin/);
  assert.match(terminal, /inherited Claude nesting marker/);
  assert.match(terminal, /provider projection owns task completion/);
});

test("pipeline kind transitions keep only agents the effective host can launch", () => {
  assert.equal(pipelineAgentForKindTransition("pipeline", "terminal", "codex"), "claude");
  assert.equal(pipelineAgentForKindTransition("pipeline", "terminal", "pi"), "claude");
  assert.equal(pipelineAgentForKindTransition("pipeline", "terminal", "claude"), "claude");

  assert.equal(pipelineAgentForKindTransition("pipeline", "agent-sdk", "pi"), "claude");
  assert.equal(pipelineAgentForKindTransition("pipeline", "agent-sdk", "codex"), "codex");
  assert.equal(pipelineAgentForKindTransition("pipeline", "agent-sdk", "claude"), "claude");

  assert.equal(pipelineAgentForKindTransition("ship", "terminal", "codex"), "codex");
  assert.equal(pipelineAgentForKindTransition("pipeline", null, "pi"), "pi");
});

test("the panel says the integration never writes, which the word conductor invites you to assume", () => {
  const html = render(answered());
  assert.match(html, /never edits Conductor/);
  assert.match(html, /through Conductor&#x27;s own CLI/);
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
  assert.match(html, /Setup needed - conduct-ts is not on this daemon/);
  assert.equal(
    (html.match(/is not on this daemon/g) ?? []).length,
    1,
    "the same sentence must not appear twice",
  );
  assert.doesNotMatch(html, /class="settings-error"/);
});

test("a missing engine with no verified checkout gives copyable manual instructions", () => {
  const state = answered({
    probes: [probe({ found: false, binPath: null, version: null, projects: [] })],
  });
  state.installers = {
    provider: "ai-conductor",
    supported: true,
    detail: "No verified local installer checkout was found in the workspace catalog.",
    candidates: [],
  };
  const html = render(state);
  assert.match(html, /Install Conductor once on this machine/);
  assert.match(html, /git clone https:\/\/github\.com\/mancej\/ai-conductor\.git/);
  assert.match(html, /cd ai-conductor &amp;&amp; \.\/bin\/install/);
  assert.match(html, /Copy clone/);
  assert.match(html, /Copy install/);
  assert.match(html, /I installed it, check again/);
});

test("a verified local main checkout is offered for review before any installer action", () => {
  const state = answered({
    probes: [probe({ found: false, binPath: null, version: null, projects: [] })],
  });
  state.installers = {
    provider: "ai-conductor",
    supported: true,
    detail: "1 verified local installer checkout found.",
    candidates: [
      {
        provider: "ai-conductor",
        checkout: "/Users/someone/workspace/ai-conductor",
        remote: "github.com/mancej/ai-conductor",
        version: "0.101.1",
        changes: [
          "build-checkout",
          "link-local-bin",
          "link-agent-skills",
          "update-claude-settings",
          "write-user-config",
          "optional-global-tools",
        ],
      },
    ],
  };
  const html = render(state);
  assert.match(html, /Verified upstream main checkout/);
  assert.match(html, /github\.com\/mancej\/ai-conductor/);
  assert.match(html, /\/Users\/someone\/workspace\/ai-conductor/);
  assert.match(html, /Review installer/);
  assert.doesNotMatch(html, />Open installer</, "launch requires the second confirmation click");
});

test("installer launch outcomes say only what the hosted terminal established", () => {
  const state = answered();
  state.installerNotice = {
    tone: "ok",
    detail: "Installer terminal opened. Finish the interactive installer there, then check again.",
  };
  const html = render(state);
  assert.match(html, /Installer terminal opened/);
  assert.doesNotMatch(html, /installation complete|Conductor installed/i);
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
      config: { enabled: true, launchRuntime: "agent-sdk", foremanMechanicalTriage: false, repos: [{ provider: "ai-conductor", repoRoot: "/w/demo", enabled: true }] },
      probes: [
        probe({
          projects: [{ name: "demo", path: "/w/demo", remote: null, status: "registered" }],
        }),
      ],
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
  assert.match(repoHealthLine(undefined, "on"), /not read yet/);
  assert.match(
    repoHealthLine(
      { provider: "ai-conductor", repoRoot: "/w/a", daemon: "running", runs: 0, halted: 0, lastReadAt: null, error: null },
      "on",
    ),
    /not read yet/,
  );
  assert.match(
    repoHealthLine(
      { provider: "ai-conductor", repoRoot: "/w/a", daemon: "running", runs: 0, halted: 0, lastReadAt: 1, error: null },
      "on",
    ),
    /0 pipelines/,
  );
  // And a repository that is off says THAT, rather than reporting the last figures it
  // happened to hold.
  assert.match(repoHealthLine(undefined, "repo-off"), /Not observed/);
});

test("an off repository is told which switch is the one that is off", () => {
  // The row draws its own checkbox from `repo.enabled`, so a repository switched on under a
  // master switch that is off renders a CHECKED box. Telling that operator to "switch this
  // repository on" names a control that is already on, and they go looking for a second one
  // that does not exist. The master switch is the blocker whenever it is off, so it is what
  // the sentence names - and only once it is on does the row's own switch become the ask.
  assert.match(
    repoHealthLine(undefined, "master-off"),
    /Observe pipelines is off/,
  );
  assert.doesNotMatch(
    repoHealthLine(undefined, "master-off"),
    /switch this repository on/,
  );
  assert.match(
    repoHealthLine(undefined, "repo-off"),
    /switch this repository on/,
  );
});

test("the daemon state is named in words, per repository", () => {
  const line = (daemon: "running" | "paused" | "stopped" | "unknown"): string =>
    repoHealthLine(
      { provider: "ai-conductor", repoRoot: "/w/a", daemon, runs: 1, halted: 0, lastReadAt: 1, error: null },
      "on",
    );
  assert.match(line("running"), /engine daemon running/);
  assert.match(line("paused"), /engine daemon paused/);
  // The one an operator acts on: nothing is going to advance, and that is not the same as
  // "nothing is happening right now".
  assert.match(line("stopped"), /no engine daemon running here/);
  assert.match(line("unknown"), /state unknown/);
});

test("the health line says how observation is arriving, in all three states", () => {
  // Three states because three things are true at different times, and the operator acting
  // on them acts differently: nothing to do, it is working, it stopped. The third is the one
  // that must not collapse into the first - a revoked token and a crashed engine both look
  // exactly like `quiet`, and reading that as `never` would hide a working install failing.
  const line = (ingest?: "never" | "live" | "quiet"): string =>
    repoHealthLine(
      { provider: "ai-conductor", repoRoot: "/w/a", daemon: "running", runs: 1, halted: 0, lastReadAt: 1, error: null, ingest },
      "on",
    );
  assert.match(line("never"), /file tail$/);
  assert.match(line("live"), /live events$/);
  assert.match(line("quiet"), /file tail \(plugin quiet\)$/);
  // Absent reads as the tail, which is exact rather than defensive: a status assembled by a
  // build with no ingest at all was produced by a daemon reading files.
  assert.match(line(undefined), /file tail$/);
  // And it never displaces what the line already said. The engine's own daemon and the run
  // counts are what an operator reads first; this is a clause, not a replacement.
  assert.match(line("live"), /engine daemon running · 1 pipeline · live events/);
});

test("the panel names where the plugin is installed, without offering a control for it", () => {
  const html = render(answered({}));
  assert.match(html, /~\/\.ai-conductor\/plugins\/mission-control\//);
  assert.match(html, /integrations\/ai-conductor\/mission-control\//);
  assert.match(html, /needs nothing installed/);
});

test("a repository the engine has forgotten stays listed while its consent stands", () => {
  // Otherwise the consent would be in force with nothing on screen that could withdraw it.
  const repos = offeredRepos(
    ["/w/workspace-only", "/w/demo"],
    { enabled: true, launchRuntime: "agent-sdk", foremanMechanicalTriage: false, repos: [{ provider: "ai-conductor", repoRoot: "/w/de-registered", enabled: true }] },
    [probe({ projects: [{ name: "demo", path: "/w/demo", remote: null, status: "registered" }] })],
  );
  assert.deepEqual(repos.map((r) => r.repoRoot), ["/w/de-registered", "/w/demo", "/w/workspace-only"]);
  assert.equal(repos.find((r) => r.repoRoot === "/w/de-registered")?.enabled, true);
  assert.equal(repos.find((r) => r.repoRoot === "/w/de-registered")?.registered, false);
  // A repository the engine reports and nobody has consented to is offered, and OFF.
  assert.equal(repos.find((r) => r.repoRoot === "/w/demo")?.enabled, false);
  assert.equal(repos.find((r) => r.repoRoot === "/w/demo")?.registered, true);
  assert.equal(repos.find((r) => r.repoRoot === "/w/workspace-only")?.workspace, true);
});

test("the combined action composes observation onto the latest whole config", () => {
  assert.deepEqual(
    configWithObservation(
      {
        enabled: false,
        launchRuntime: "terminal",
        foremanMechanicalTriage: true,
        repos: [
          { provider: "ai-conductor", repoRoot: "/w/other", enabled: false },
          { provider: "ai-conductor", repoRoot: "/w/demo", enabled: false },
        ],
      },
      "ai-conductor",
      "/w/demo",
    ),
    {
      enabled: true,
      launchRuntime: "terminal",
      foremanMechanicalTriage: true,
      repos: [
        { provider: "ai-conductor", repoRoot: "/w/other", enabled: false },
        { provider: "ai-conductor", repoRoot: "/w/demo", enabled: true },
      ],
    },
  );
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
