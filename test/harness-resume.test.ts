import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What is at stake: "how is one of this harness's conversations reopened in a terminal" is
// ONE FACT written in two files, and it spent its whole life in the wrong one.
//
// The argv lived on `SdkSpec`, so only a harness that ALSO had an embedded driver could
// answer it. Pi remains the demonstration that those capabilities are independent: its CLI
// can continue a session although it has no embedded driver. Codex now supports both, which
// is equally valid; the slot was still welded to an unrelated capability.
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
  // The whole reason this capability moved off `SdkSpec`. Pi was the counterexample - a
  // harness that could reopen its conversation with no driver at all - and now that it has
  // one, the SHAPE is what has to be pinned instead: the two slots are read separately, and
  // nothing composes one from the other.
  for (const agent of AGENT_TYPES) {
    const resume = HARNESSES[agent].resume;
    assert.notEqual(resume, null, `${agent}: every shipped harness can reopen a conversation`);
    // `resumeFor` reads the record's own slot rather than reaching through `sdk`, which is
    // the arrangement that let Pi answer this question while `sdk` was null.
    assert.equal(resumeFor(agent), resume);
    assert.equal(
      Object.prototype.hasOwnProperty.call(HARNESSES[agent].sdk ?? {}, "argv"),
      false,
      `${agent}: an SdkSpec must not carry a resume argv - that is what the split undid`,
    );
  }
});

// Each of these was read off `--help` on a real install, not off release notes. They are
// three DIFFERENT shapes - a flag, a subcommand, another flag - so the only way to get one
// right is to have looked. `HARNESSES.codex.tui` is what assuming a capability costs.
//
// The MODE is the one setting that rides along, and the exception is deliberate: no
// `--model` or effort flags, because the resumed conversation carries those itself and
// re-stating them would silently change a conversation the operator asked to CONTINUE. The
// mode is the setting neither CLI restores - an embedded session's mode lived in driver
// options, nothing on disk records it - so without the flag a session running in auto
// reopens in the CLI's default and the operator has to notice and re-set it by hand.
test("claude resumes with a flag, carrying the mode it was running in", () => {
  assert.deepEqual([...HARNESSES.claude.resume!.argv("agent-9", null)], ["--resume", "agent-9"]);
  assert.deepEqual(
    [...HARNESSES.claude.resume!.argv("agent-9", "auto")],
    ["--resume", "agent-9", "--permission-mode", "auto"],
  );
  // The CLI spells the default mode `manual` (verified against 2.1.222) - the same bridge
  // the dispatch path's `launchArgs` renders, because it IS that renderer.
  assert.deepEqual(
    [...HARNESSES.claude.resume!.argv("agent-9", "default")],
    ["--resume", "agent-9", "--permission-mode", "manual"],
  );
  // A Codex profile on a Claude session cannot happen in practice, but the union is shared
  // and `--permission-mode readOnly` would abort the resume rather than open it - so a mode
  // outside Claude's vocabulary rides as no flag, never as a guess.
  assert.deepEqual(
    [...HARNESSES.claude.resume!.argv("agent-9", "approveForMe")],
    ["--resume", "agent-9"],
  );
});

test("codex resumes with a subcommand, re-asserting its posture as flags", () => {
  // `codex resume --help` (0.145.0): "Session id (UUID) or session name". NOT a flag -
  // `--resume` is not a thing on codex, and passing one would be read as a prompt. The
  // subcommand takes `--sandbox` and `--ask-for-approval` directly; the reviewer has no
  // flag and rides as a `-c` override of the top-level `approvals_reviewer` config key.
  assert.deepEqual([...HARNESSES.codex.resume!.argv("01JF-abc", null)], ["resume", "01JF-abc"]);
  assert.deepEqual(
    [...HARNESSES.codex.resume!.argv("01JF-abc", "approveForMe")],
    [
      "resume",
      "01JF-abc",
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "on-request",
      "-c",
      'approvals_reviewer="auto_review"',
    ],
  );
  // `askForApproval` differs from `approveForMe` ONLY in the reviewer, so the `-c`
  // override is load-bearing even at its default value: dropping it would let an operator
  // config naming `auto_review` silently flip which of the two profiles reopens.
  assert.deepEqual(
    [...HARNESSES.codex.resume!.argv("01JF-abc", "askForApproval")],
    [
      "resume",
      "01JF-abc",
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "on-request",
      "-c",
      'approvals_reviewer="user"',
    ],
  );
  assert.deepEqual(
    [...HARNESSES.codex.resume!.argv("01JF-abc", "fullAccess")],
    [
      "resume",
      "01JF-abc",
      "--sandbox",
      "danger-full-access",
      "--ask-for-approval",
      "never",
      "-c",
      'approvals_reviewer="user"',
    ],
  );
  // A Claude mode on a Codex session renders nothing - `codexPosture` has no row for it,
  // and a posture nobody picked is worse than the operator's own default.
  assert.deepEqual([...HARNESSES.codex.resume!.argv("01JF-abc", "auto")], ["resume", "01JF-abc"]);
});

test("pi resumes with --session, not the two flags beside it, and has no mode to carry", () => {
  // `pi --help` lists `--session <path|id>`, `--resume` (an interactive PICKER that takes no
  // id) and `--fork` (which BRANCHES the conversation) adjacently. Only the first continues
  // a known conversation, and picking either neighbour fails in a way a user would report as
  // "it opened the wrong thing" rather than as an error.
  assert.deepEqual([...HARNESSES.pi.resume!.argv("sess-3", null)], ["--session", "sess-3"]);
  // `permissionModes: null` - a mode arriving anyway must not invent a flag pi cannot spell.
  assert.deepEqual([...HARNESSES.pi.resume!.argv("sess-3", "auto")], ["--session", "sess-3"]);
});

test("the composed argv leads with the resolved harness binary", async () => {
  // One composer, so no caller pairs `resolveAgentBin` with a hand-written flag. The two
  // readers - the embedded handoff and the conversation pane's launcher - must spawn the
  // same command line, and they only do if neither builds it itself.
  const previousClaudeBin = process.env.MISSION_CLAUDE_BIN;
  process.env.MISSION_CLAUDE_BIN = process.execPath;
  try {
    const argv = await resumeArgvFor("claude", "agent-9", null);
    assert.ok(argv);
    assert.equal(argv.length, 3);
    assert.equal(argv[0], process.execPath);
    assert.deepEqual(argv.slice(1), ["--resume", "agent-9"]);

    const withMode = await resumeArgvFor("claude", "agent-9", "auto");
    assert.ok(withMode);
    assert.deepEqual(withMode.slice(1), ["--resume", "agent-9", "--permission-mode", "auto"]);
  } finally {
    if (previousClaudeBin === undefined) delete process.env.MISSION_CLAUDE_BIN;
    else process.env.MISSION_CLAUDE_BIN = previousClaudeBin;
  }
});

test("both resume readers compose from the harness and pass the session's stored mode", () => {
  // A source grep, because the failure it guards is invisible at runtime until a harness
  // that has a resume spec but no driver reaches this path. If the handoff goes back to
  // reading the spec off `sdkFor`, the second reader of this capability silently diverges
  // from the first. The mode argument is pinned for the same reason: dropping it from
  // either call site would compile fine only if the parameter went optional, and the
  // symptom - a resumed session opening in the wrong mode - reproduces only with a real
  // CLI at the other end.
  const src = readFileSync(new URL("../src/server/sdk/handoff.ts", import.meta.url), "utf8");
  assert.match(src, /resumeArgvFor\(session\.agent, session\.agentSessionId, session\.permissionMode\)/);
  assert.doesNotMatch(src, /\.resumeArgv\(/);
  const routes = readFileSync(new URL("../src/server/routes.ts", import.meta.url), "utf8");
  assert.match(
    routes,
    /resumeArgvFor\(\s*session\.agent,\s*session\.agentSessionId!,\s*session\.permissionMode,?\s*\)/,
  );
});
