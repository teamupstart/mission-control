import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What is at stake: "how is one of this harness's conversations reopened in a terminal" is
// ONE FACT written in two files, and it spent its whole life in the wrong one.
//
// The argv lived on `SdkSpec`, so only a harness that ALSO had an embedded driver could
// answer it. Claude had one; Codex and pi declared `sdk: null` and were therefore unable to
// say how to continue themselves - not because their CLIs cannot (all three can, measured
// below) but because the slot was welded to an unrelated capability. Anything reading
// "can this session be reopened" got Claude and two false negatives.
//
// Both halves now have to agree. `HarnessCapabilities.resumes` is the pure boolean the
// BROWSER reads to shape the agent launcher on the conversation pane; `Harness.resume` is
// the server-side spec that composes the argv. The two failures are opposite and both
// silent: a capability claiming `resumes: true` over a null spec draws a live button whose
// route always 409s, and a spec shipped under `resumes: false` is a command line nothing
// can reach.

const home = mkdtempSync(join(tmpdir(), "harness-resume-"));
// Set before importing anything that resolves the state dir: the harness registry reaches
// specs that read config paths.
process.env.HARNESS_HOME = join(home, "state");

const { AGENT_TYPES } = await import("../src/shared/types.ts");
const { HARNESS_CAPABILITIES } = await import("../src/shared/harness-capabilities.ts");
const { HARNESSES, resumeFor, resumeArgvFor } = await import("../src/server/harness/index.ts");

after(() => rmSync(home, { recursive: true, force: true }));

test("every agent declares a resume slot, and the two halves agree", () => {
  for (const agent of AGENT_TYPES) {
    const capability = HARNESS_CAPABILITIES[agent].resumes;
    const spec = HARNESSES[agent].resume;
    assert.equal(
      capability,
      spec !== null,
      `${agent}: resumes=${capability} but resume spec is ${spec === null ? "null" : "present"}`,
    );
    assert.equal(resumeFor(agent), spec, `${agent}: resumeFor must read the record`);
  }
});

test("resume is independent of having an embedded driver", () => {
  // The whole reason this capability moved. Codex has no driver and has always been able to
  // reopen a rollout; if these two ever have to agree again, the split has been undone.
  assert.equal(HARNESSES.codex.sdk, null);
  assert.notEqual(HARNESSES.codex.resume, null);
  assert.equal(HARNESSES.pi.sdk, null);
  assert.notEqual(HARNESSES.pi.resume, null);
});

// Each of these was read off `--help` on a real install, not off release notes. They are
// three DIFFERENT shapes - a flag, a subcommand, another flag - so the only way to get one
// right is to have looked. `HARNESSES.codex.tui` is what assuming a capability costs.
test("claude resumes with a flag", () => {
  // No `--model` or mode flags ride along: a resumed session carries its own, and re-stating
  // them would silently change a conversation the operator asked to CONTINUE.
  assert.deepEqual([...HARNESSES.claude.resume!.argv("agent-9")], ["--resume", "agent-9"]);
});

test("codex resumes with a subcommand and a positional id", () => {
  // `codex resume --help`: "Session id (UUID) or session name". NOT a flag - `--resume` is
  // not a thing on codex, and passing one would be read as a prompt.
  assert.deepEqual([...HARNESSES.codex.resume!.argv("01JF-abc")], ["resume", "01JF-abc"]);
});

test("pi resumes with --session, not the two flags beside it", () => {
  // `pi --help` lists `--session <path|id>`, `--resume` (an interactive PICKER that takes no
  // id) and `--fork` (which BRANCHES the conversation) adjacently. Only the first continues
  // a known conversation, and picking either neighbour fails in a way a user would report as
  // "it opened the wrong thing" rather than as an error.
  assert.deepEqual([...HARNESSES.pi.resume!.argv("sess-3")], ["--session", "sess-3"]);
});

test("the composed argv leads with the harness binary", () => {
  // One composer, so no caller pairs `resolveAgentBin` with a hand-written flag. The two
  // readers - the embedded handoff and the conversation pane's launcher - must spawn the
  // same command line, and they only do if neither builds it itself.
  const argv = resumeArgvFor("claude", "agent-9");
  assert.ok(argv);
  assert.equal(argv.length, 3);
  assert.match(argv[0]!, /claude/);
  assert.deepEqual(argv.slice(1), ["--resume", "agent-9"]);
});

test("the handoff route composes its argv from the harness, not from the driver", () => {
  // A source grep, because the failure it guards is invisible at runtime until a harness
  // that has a resume spec but no driver reaches this path. If the handoff goes back to
  // reading the spec off `sdkFor`, the second reader of this capability silently diverges
  // from the first.
  const src = readFileSync(new URL("../src/server/sdk/handoff.ts", import.meta.url), "utf8");
  assert.match(src, /resumeArgvFor\(session\.agent, session\.agentSessionId\)/);
  assert.doesNotMatch(src, /\.resumeArgv\(/);
});
