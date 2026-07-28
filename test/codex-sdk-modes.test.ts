import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CODEX_POSTURES,
  codexPosture,
  sandboxModeOf,
  type CodexPosture,
} from "../src/server/harness/codex/sdk.ts";
import { parseRolloutPermissionModeRead } from "../src/server/harness/codex/rollout.ts";
import { HARNESS_CAPABILITIES } from "../src/shared/harness-capabilities.ts";

// What is at stake: the posture an embedded Codex session is LAUNCHED with and the mode its
// card DISPLAYS are computed by two different pieces of code from two different sources -
// this table writes a sandbox and an approval policy onto a thread, and
// `parseRolloutPermissionModeRead` reads them back out of the rollout Codex then writes.
//
// If the two ever disagree, nothing fails: the session runs in the posture we asked for and
// the chip shows a different mode, or none at all. So they are checked against each other
// here rather than each against a comment. This is the single statement of Codex mode
// posture for SDK sessions that phase 5 is told it may rely on.

/** The `turn_context` record a rollout carries, as the reader expects to find it. */
function turnContext(posture: CodexPosture): string {
  return JSON.stringify({
    type: "turn_context",
    timestamp: "2026-07-25T20:58:22.925Z",
    payload: {
      sandbox_policy: { type: posture.sandbox },
      approval_policy: posture.approvalPolicy,
      approvals_reviewer: posture.approvalsReviewer,
    },
  });
}

test("every mode the panel offers has a posture, and every posture reads back as its mode", () => {
  const pickable = HARNESS_CAPABILITIES.codex.permissionModes?.pickable ?? [];
  assert.ok(pickable.length > 0);
  for (const mode of pickable) {
    const posture = codexPosture(mode);
    assert.ok(posture, `${mode} is offered in the panel with no posture behind it`);
    assert.equal(
      parseRolloutPermissionModeRead([turnContext(posture)])?.mode,
      mode,
      `launching in ${mode} writes a turn_context the card would read as something else`,
    );
  }
});

test("the mode a dispatch arms is one this driver can actually launch", () => {
  // `onDispatch` costs the terminal path nothing (`launchArgs` is null there, so
  // `dispatchPermissionModeArgs` still renders no flags) and is the ONLY channel the
  // embedded runtime has for "auto mode on dispatch". A mode with no posture would make an
  // auto dispatch silently fall back to the operator's own config.
  const onDispatch = HARNESS_CAPABILITIES.codex.permissionModes?.onDispatch;
  assert.equal(onDispatch, "approveForMe");
  const posture = codexPosture(onDispatch!);
  // The same posture `prepareCodexLaunch` gives an auto terminal launch
  // (`--sandbox workspace-write --ask-for-approval on-request`), so flipping the runtime
  // does not change what a dispatched Codex is allowed to do.
  assert.equal(posture?.sandbox, "workspace-write");
  assert.equal(posture?.approvalPolicy, "on-request");
  // ...with eligible approvals routed through Codex's native auto reviewer. Requests it
  // does not approve still arrive on the embedded session's card.
  assert.equal(posture?.approvalsReviewer, "auto_review");
});

test("the two profiles that share a sandbox are separated only by their reviewer", () => {
  // This is why the table carries a reviewer at all: leaving it unset would make "Approve
  // for me" a row that applies whatever `~/.codex/config.toml` already said.
  assert.equal(CODEX_POSTURES.askForApproval.sandbox, CODEX_POSTURES.approveForMe.sandbox);
  assert.equal(
    CODEX_POSTURES.askForApproval.approvalPolicy,
    CODEX_POSTURES.approveForMe.approvalPolicy,
  );
  assert.notEqual(
    CODEX_POSTURES.askForApproval.approvalsReviewer,
    CODEX_POSTURES.approveForMe.approvalsReviewer,
  );
});

test("a mode this driver has nothing to say about gets no posture at all", () => {
  // Claude's modes share one `PermissionMode` union with Codex's. Translating one into the
  // nearest Codex profile would run a session in a posture nobody picked; null means "send
  // no overrides", which leaves the operator's own config in force.
  assert.equal(codexPosture(null), null);
  assert.equal(codexPosture("acceptEdits"), null);
  assert.equal(codexPosture("bypassPermissions"), null);
});

test("a reported sandbox policy maps back to the mode token that creates it", () => {
  // Two spellings of one idea, both the vendor's: threads are created with the kebab-case
  // token and report back the camelCase resolved policy. `setPermissionMode` compares
  // across that gap before it claims a change is possible.
  assert.equal(sandboxModeOf({ type: "readOnly", networkAccess: false }), "read-only");
  assert.equal(
    sandboxModeOf({
      type: "workspaceWrite",
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    }),
    "workspace-write",
  );
  assert.equal(sandboxModeOf({ type: "dangerFullAccess" }), "danger-full-access");
  // No creation-time counterpart, so no mode change can be honestly offered against it.
  assert.equal(sandboxModeOf({ type: "externalSandbox", networkAccess: "restricted" }), null);
  assert.equal(sandboxModeOf(null), null);
});
