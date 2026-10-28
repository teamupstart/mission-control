import assert from "node:assert/strict";
import test from "node:test";

import { AGENT_TYPES } from "../src/shared/types.ts";
import { capabilitiesFor } from "../src/shared/harness-capabilities.ts";
import { artifactPublishState } from "../src/web/lib/artifactPublish.ts";

const REPORT = "docs/reports/auth-flow/report.html";

function session(overrides: Record<string, unknown> = {}) {
  return {
    agent: "claude" as const,
    runtime: "sdk" as const,
    terminals: [],
    pipeline: null,
    ...overrides,
  };
}

test("a Claude session is asked to publish the exact file, unchanged, with the Artifact tool", () => {
  const state = artifactPublishState(session(), REPORT, false);
  assert.equal(state.ok, true);
  if (!state.ok) return;
  assert.equal(state.label, "Claude artifact");
  assert.match(state.prompt, /^Publish docs\/reports\/auth-flow\/report\.html as a Claude artifact\./);
  assert.match(state.prompt, /Artifact tool with file_path set to exactly that file/);
  assert.match(state.prompt, /do not edit, rewrite, reformat, regenerate or copy it first/);
  assert.match(state.prompt, /If the Artifact tool is not available in this session, say so and stop/);
  assert.match(state.prompt, /Reply with the artifact's claude\.ai link\./);
});

test("Markdown and .htm sources publish; other files say which types can", () => {
  assert.equal(artifactPublishState(session(), "notes/Plan.MD", false).ok, true);
  assert.equal(artifactPublishState(session(), "site/index.htm", false).ok, true);
  assert.deepEqual(artifactPublishState(session(), "src/server/auth.ts", false), {
    ok: false,
    label: "Claude artifact",
    reason: "Only .html, .htm and .md files can be published as a Claude artifact",
  });
});

test("Codex and Pi sessions name why they cannot publish, whatever the file", () => {
  const codex = artifactPublishState(session({ agent: "codex" }), REPORT, false);
  assert.equal(codex.ok, false);
  if (!codex.ok) assert.match(codex.reason, /^Codex cannot publish files from a session/);
  const pi = artifactPublishState(session({ agent: "pi" }), REPORT, false);
  assert.equal(pi.ok, false);
  if (!pi.ok) assert.match(pi.reason, /^Pi has no tool/);
});

test("every harness declares a publishing answer, and a publisher declares a prompt", () => {
  for (const agent of AGENT_TYPES) {
    const spec = capabilitiesFor(agent).artifactPublishing;
    if (spec.publishes) {
      assert.ok(spec.sourceExtensions.length > 0, `${agent} lists its source types`);
      assert.ok(spec.prompt(REPORT).includes(REPORT), `${agent} names the file in its prompt`);
    } else {
      assert.ok(spec.unavailable.length > 0, `${agent} says why it cannot publish`);
    }
  }
});

test("a session that cannot take a turn, or a file with unsaved edits, is refused with a reason", () => {
  assert.deepEqual(artifactPublishState(session({ runtime: "terminal" }), REPORT, false), {
    ok: false,
    label: "Claude artifact",
    reason: "This session has no pane to send a publish request to",
  });
  const engine = artifactPublishState(
    session({ pipeline: { runId: "run-1" } }),
    REPORT,
    false,
  );
  assert.equal(engine.ok, false);
  if (!engine.ok) assert.match(engine.reason, /workflow engine drives this session/);
  assert.deepEqual(artifactPublishState(session(), REPORT, true), {
    ok: false,
    label: "Claude artifact",
    reason: "Save this file first, so the published page is the file on disk",
  });
  assert.deepEqual(artifactPublishState(session(), null, false), {
    ok: false,
    label: "Claude artifact",
    reason: "Open a file to publish it as a Claude artifact",
  });
});
