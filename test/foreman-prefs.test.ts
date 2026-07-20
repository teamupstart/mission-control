import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PREFS_NAME, readForemanPrefs } from "../src/server/standards.ts";
import { prefsSection } from "../src/server/foreman/prefs.ts";
import { buildReviewPrompt } from "../src/server/foreman/prompt.ts";
import { buildVerifyPrompt } from "../src/server/foreman/queue-prompt.ts";
import { buildTriagePrompt } from "../src/server/foreman/triage-prompt.ts";
import type { ReviewInput } from "../src/server/foreman/prompt.ts";
import type { VerifyInput } from "../src/server/foreman/queue-prompt.ts";

// FOREMAN.md is the one repo file Foreman is told to OBEY rather than judge, which
// makes its placement in the prompt a security property and not a formatting choice.
// Every other repo-sourced input - the diff, the transcript, the standards docs - sits
// below an "UNTRUSTED EVIDENCE" fence precisely so a repo cannot instruct the reviewer.
// This file exists to catch the day someone moves this section across that fence in
// either direction: dropped below it, the operator's instructions quietly stop being
// followed and nothing fails; and if the standards docs ever drift above it, arbitrary
// repo content is instructing the verifier outright.

const PREFS = "Never merge a change that adds a public API without a test.";

function mkRepo(): string {
  return mkdtempSync(join(tmpdir(), "foreman-prefs-"));
}

const doc = (text: string, truncated = false) => ({ path: PREFS_NAME, text, truncated });

function reviewInput(over: Partial<ReviewInput> = {}): ReviewInput {
  return {
    session: {
      name: "s1",
      cwd: "/repo",
      gitBranch: "main",
      state: "waiting",
      activity: null,
      goal: "ship the thing",
    },
    surface: "terminal",
    question: "Should I add the endpoint?",
    transcript: [{ role: "assistant", text: "working", tools: [] }],
    truncated: false,
    ...over,
  } as ReviewInput;
}

function verifyInput(over: Partial<VerifyInput> = {}): VerifyInput {
  return {
    session: { name: "s1", cwd: "/repo", gitBranch: "main" },
    intent: "add the endpoint",
    round: 0,
    diff: "+++ b/src/a.ts",
    diffTruncated: false,
    diffMayIncludeOtherWork: false,
    transcript: [{ role: "assistant", text: "did it", tools: [] }],
    transcriptTruncated: false,
    standards: [],
    standardsTruncated: false,
    priorGaps: [],
    ...over,
  } as VerifyInput;
}

// ---- reading the file ----

test("reads FOREMAN.md from the repo root", () => {
  const root = mkRepo();
  writeFileSync(join(root, PREFS_NAME), PREFS);

  const out = readForemanPrefs(root);
  assert.equal(out?.path, PREFS_NAME);
  assert.match(out!.text, /public API without a test/);
  assert.equal(out!.truncated, false);
});

test("no FOREMAN.md, no repo, and a missing root are all just absent", () => {
  // The ordinary case by a wide margin, and it has to stay indistinguishable from the
  // pre-existing behaviour: every caller degrades a failed read to this same null, so
  // if absence were anything other than "render nothing", a repo that never opted in
  // would start getting a different prompt.
  assert.equal(readForemanPrefs(mkRepo()), null);
  assert.equal(readForemanPrefs(null), null);
  assert.equal(readForemanPrefs("/nope/not/here"), null);
});

test("a FOREMAN.md symlinked outside the repo is refused", () => {
  // The same escape `readDoc` already defeats for standards docs, retested here
  // because the consequence is strictly worse on this path. A standards doc reaches
  // the model fenced as evidence; this one reaches it as instructions the model is
  // told to follow - so a repo that links FOREMAN.md at ~/.ssh/id_rsa would not just
  // leak the file into a prompt, it would leak it into the trusted half of one.
  const root = mkRepo();
  const outside = mkdtempSync(join(tmpdir(), "foreman-secret-"));
  const secret = join(outside, "id_rsa");
  writeFileSync(secret, "BEGIN PRIVATE KEY");
  symlinkSync(secret, join(root, PREFS_NAME));

  assert.equal(readForemanPrefs(root), null);
});

test("an oversized FOREMAN.md truncates rather than dropping out", () => {
  // Paid for on EVERY review and EVERY verify, so it is capped tighter than a
  // standards doc. Truncating is the point: dropping it would silently stop honouring
  // instructions the operator can plainly see in their own repo.
  const root = mkRepo();
  writeFileSync(join(root, PREFS_NAME), "x".repeat(20 * 1024));

  const out = readForemanPrefs(root);
  assert.equal(out?.truncated, true);
  assert.equal(out!.text.length, 16 * 1024);
});

// ---- rendering the section ----

test("an absent or blank FOREMAN.md renders no section at all", () => {
  // Not "(none)". A heading promising the operator's instructions with nothing under
  // it reads as a claim about the human - that they have no standards - when it only
  // means the repo has no such file.
  assert.deepEqual(prefsSection(null), []);
  assert.deepEqual(prefsSection(undefined), []);
  assert.deepEqual(prefsSection(doc("   \n\t ")), []);
});

test("the ratchet framing comes AFTER the operator's text", () => {
  // Recency, for the same reason buildVerifyPrompt repeats its evidence guard below
  // the untrusted block instead of only above it: the guard has to be the last thing
  // read. Stated first, a long preferences doc buries it.
  const out = prefsSection(doc(PREFS)).join("\n");
  assert.ok(out.indexOf(PREFS) < out.indexOf("can only ever RAISE your bar"));
  assert.match(out, /cannot authorize a destructive or irreversible action/);
});

test("a truncated FOREMAN.md says so in its own heading", () => {
  assert.match(prefsSection(doc(PREFS, true))[0]!, /truncated/);
});

// ---- placement in the two prompts ----

test("the reviewer gets the operator's instructions above the session data", () => {
  const p = buildReviewPrompt(reviewInput({ prefs: doc(PREFS) }));
  assert.ok(p.includes(PREFS));
  assert.ok(p.indexOf(PREFS) < p.indexOf("## The session"));
});

test("the reviewer's prompt is byte-identical without a FOREMAN.md", () => {
  // What lets this ship without changing how a single existing repo is reviewed.
  assert.equal(buildReviewPrompt(reviewInput({ prefs: null })), buildReviewPrompt(reviewInput()));
});

test("the verifier gets the operator's instructions ABOVE the evidence fence", () => {
  // THE test in this file. Below the fence the operator's instructions become
  // "untrusted material you are JUDGING" - the prompt says so in as many words - and
  // Foreman would read a document written to steer it as one more thing to review.
  const p = buildVerifyPrompt(verifyInput({ prefs: doc(PREFS) }));
  assert.ok(p.indexOf(PREFS) < p.indexOf("BEGIN UNTRUSTED EVIDENCE"));
});

test("standards docs stay BELOW the fence, on the far side of the operator's doc", () => {
  // The other half of the same boundary. Both are markdown read out of the same repo
  // by the same reader; only their side of the fence distinguishes direction from
  // evidence, so the two must never end up together.
  const p = buildVerifyPrompt(
    verifyInput({
      prefs: doc(PREFS),
      standards: [{ path: "CLAUDE.md", text: "repo says: use tabs", truncated: false }],
    }),
  );
  const fence = p.indexOf("BEGIN UNTRUSTED EVIDENCE");
  assert.ok(p.indexOf(PREFS) < fence);
  assert.ok(p.indexOf("repo says: use tabs") > fence);
});

test("the CHEAP tier reads the operator's instructions too, because it can dispose", () => {
  // The hole this closes: Tier 1 answers `routine-access` outright and never routes those
  // to Tier 2, so a router blind to FOREMAN.md would auto-approve exactly the asks the
  // operator had written down as off-limits - on the highest-volume path in the system.
  // A preferences doc only the expensive tier honours is a coin flip on which tier picks
  // the ask up, which is worse than not having one.
  const p = buildTriagePrompt(reviewInput({ prefs: doc(PREFS) }));
  assert.ok(p.includes(PREFS));
  assert.ok(p.indexOf(PREFS) < p.indexOf("## The session"));
  // And the router is told which way the instructions may move a bucket. Without this the
  // section is present but inert: nothing connects "the operator said no" to the one
  // decision this tier actually makes.
  assert.match(p, /never into it/);
});

test("both tiers render the operator's instructions identically", () => {
  // Same file, same section, same ratchet. Two tiers reading one document and reaching
  // different conclusions about what it permits is the failure the shared `prefsSection`
  // exists to prevent - and it would be invisible, since only one tier handles any
  // given ask.
  const section = prefsSection(doc(PREFS)).join("\n");
  assert.ok(buildTriagePrompt(reviewInput({ prefs: doc(PREFS) })).includes(section));
  assert.ok(buildReviewPrompt(reviewInput({ prefs: doc(PREFS) })).includes(section));
});

test("the verifier is told its convention rule does not gag the operator", () => {
  // POLICY hardcodes "conventions are advisory unless flagrant", which is about the
  // standards docs. Without the carve-out the two strings argue in front of the model:
  // the operator says "block on this", the policy says "advisory", and which one wins
  // is a coin flip the operator can neither see nor influence.
  const p = buildVerifyPrompt(verifyInput({ prefs: doc(PREFS) }));
  assert.match(p, /THE ONE EXCEPTION is the operator's standing instructions/);
});
