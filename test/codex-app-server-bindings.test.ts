import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CODEX_APP_SERVER_BINDINGS_VERSION } from "../src/server/harness/codex/app-server/protocol.ts";

// What is at stake: `protocol.ts` is GENERATED, and generated code that nobody can tell
// apart from hand-written code is code the next person edits by hand. It then survives
// exactly until someone regenerates it, at which point their fix silently disappears.
//
// So this pins the two things that make it re-derivable: the Codex build it came from, and
// the script that produced it. The types themselves are checked by `npm run typecheck` -
// `harness/codex/sdk.ts` is their only consumer, and it stops compiling when a field it
// reads moves, which is the whole reason a pruned subset is safe to pin.

const here = fileURLToPath(new URL(".", import.meta.url));
const protocol = readFileSync(`${here}../src/server/harness/codex/app-server/protocol.ts`, "utf8");

test("the bindings record the Codex build they were generated from", () => {
  assert.match(CODEX_APP_SERVER_BINDINGS_VERSION, /^\d+\.\d+\.\d+/);
  // The constant and the header have to agree, because the header is what a reviewer reads
  // and the constant is what code can assert against.
  assert.ok(
    protocol.includes(`from codex-cli ${CODEX_APP_SERVER_BINDINGS_VERSION}`),
    "the file header names a different Codex version from the exported constant",
  );
});

test("the bindings say how to regenerate them, and not to edit them", () => {
  assert.ok(protocol.includes("scripts/codex-app-server-bindings.mjs"));
  assert.ok(protocol.includes("DO NOT EDIT"));
});

test("the types the adapter speaks are all present", () => {
  // A regeneration whose roots drifted would drop one of these and fail typecheck; this
  // says out loud which declarations the driver depends on existing.
  for (const name of [
    "InitializeParams",
    "ThreadStartParams",
    "ThreadStartResponse",
    "ThreadResumeParams",
    "TurnStartParams",
    "TurnSteerParams",
    "TurnInterruptParams",
    "CommandExecutionRequestApprovalParams",
    "CommandExecutionApprovalDecision",
    "FileChangeRequestApprovalParams",
    "ToolRequestUserInputParams",
    "ToolRequestUserInputResponse",
    "ThreadItem",
    "ThreadTokenUsageUpdatedNotification",
    "SandboxMode",
    "SandboxPolicy",
    "AskForApproval",
    "ApprovalsReviewer",
  ]) {
    assert.ok(protocol.includes(`export type ${name}`), `the bindings no longer declare ${name}`);
  }
});

test("only the two dedicated Codex adapters speak app-server", async () => {
  // C10: the protocol is spoken only inside the interactive Codex adapter and the isolated
  // Persona workload adapter. A `thread/start` anywhere else is a place the vendor's
  // vocabulary leaks to, instead of remaining behind one of those provider-specific seams.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  // Quoted, because that is what SPEAKING the protocol looks like: `ControlSpec`'s doc
  // comment names `turn/steer` in prose to explain why delivery is a capability, and prose
  // about a method is not a call to it.
  const { stdout } = await run(
    "git",
    [
      "grep", "--untracked", "-l", "-E",
      String.raw`"(thread/start|thread/resume|turn/start|turn/steer|turn/interrupt|item/[a-zA-Z]+/request[A-Za-z]+)"`,
      "--", "src", "hooks",
    ],
    { cwd: `${here}..` },
  ).catch((err: { stdout?: string }) => ({ stdout: err.stdout ?? "" }));
  // The pruned binding roots are params and results, so no method name survives into
  // `protocol.ts` itself.
  assert.deepEqual(stdout.split("\n").filter(Boolean).sort(), [
    "src/server/harness/codex/sdk.ts",
    "src/server/workflows/persona-workload/codex.ts",
  ]);
});
