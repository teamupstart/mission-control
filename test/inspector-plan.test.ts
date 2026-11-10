import { test } from "node:test";
import assert from "node:assert/strict";
import { commentableLines } from "../src/server/inspector/diff-lines.ts";
import { fingerprint } from "../src/server/inspector/marker.ts";
import { planReview } from "../src/server/inspector/verdict.ts";
import type { InspectorVerdict, OurThread, PlanInput } from "../src/server/inspector/verdict.ts";
import type { InspectorComment } from "../src/shared/types.ts";

// Everything the Inspector does to a pull request is decided here, by a pure function,
// on purpose: these are the rules that decide whether an automated reviewer is useful
// or is the thing everyone mutes, and they should be checkable without a network.
//
// Four of them are load-bearing enough to be worth stating out loud:
//   - a finding about a file the PR never touched is DROPPED (leak-defence layer 4);
//   - an issue already raised and still open is never raised again;
//   - a dry-run preview is not a posted comment, and must post when you go live;
//   - resolving is narrowing only - it can close a thread we own and nothing else.

const DIFF = `--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,5 @@
 import { x } from "./x.ts";
+const added = 1;
+const more = 2;
 export { x };
`;

let ids = 0;
function base(over: Partial<PlanInput> = {}): PlanInput {
  return {
    mode: "live",
    live: true,
    maxComments: 8,
    round: 1,
    verdict: { summary: "Looks reasonable.", findings: [], resolved: [] },
    lines: commentableLines(DIFF),
    existing: new Map(),
    threads: new Map(),
    newId: () => `id-${++ids}`,
    ...over,
    // By default the prompt listed every seeded row, as it does below its length cap.
    prompted: over.prompted ?? new Set(over.existing?.keys() ?? []),
  };
}

function finding(over: Partial<InspectorVerdict["findings"][number]> = {}) {
  return {
    path: "src/a.ts",
    line: 2 as number | null,
    severity: "major" as const,
    title: "Reaches into the concrete type",
    body: "Depend on the interface instead.",
    ...over,
  };
}

function row(over: Partial<InspectorComment> = {}): InspectorComment {
  return {
    id: "row-1",
    prKey: "o/r#1",
    fingerprint: "fp",
    path: "src/a.ts",
    line: 2,
    title: "Reaches into the concrete type",
    body: null,
    severity: "major",
    round: 1,
    status: "open",
    replies: 0,
    answeredCommentId: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

// ---- leak-defence layer 4 ----

// The structural answer to a diff that tries to talk the reviewer into reading a secret
// and repeating it: the resulting comment is about a file the PR never changed, and
// there is nowhere for it to land. Not a warning, not a demotion into the body - a drop.
test("a finding about a file the PR never touched is dropped", () => {
  const plan = planReview(
    base({
      verdict: {
        summary: "",
        findings: [
          finding(),
          finding({ path: ".env", line: null, title: "Config contains a live key" }),
          finding({ path: "../../etc/passwd", line: null, title: "Interesting" }),
        ],
        resolved: [],
      },
    }),
  );
  assert.equal(plan.droppedOffDiff, 2);
  assert.equal(plan.inline.length, 1);
  assert.equal(plan.inline[0]!.path, "src/a.ts");
  assert.ok(!plan.body.includes(".env"), "a dropped finding must not leak into the body either");
});

// ---- dedup ----

test("an issue already raised and still open is not raised again", () => {
  const fp = fingerprint("src/a.ts", "Reaches into the concrete type");
  const plan = planReview(
    base({
      verdict: { summary: "", findings: [finding()], resolved: [] },
      existing: new Map([[fp, row({ fingerprint: fp, status: "open" })]]),
    }),
  );
  assert.equal(plan.inline.length, 0, "re-posting a live complaint is how a reviewer becomes noise");
});

test("the model rewording itself does not produce a second comment", () => {
  const fp = fingerprint("src/a.ts", "Reaches into the concrete type");
  const plan = planReview(
    base({
      verdict: {
        summary: "",
        findings: [finding({ title: "reaches into the concrete type." })],
        resolved: [],
      },
      existing: new Map([[fp, row({ fingerprint: fp, status: "open" })]]),
    }),
  );
  assert.equal(plan.inline.length, 0);
});

test("the same finding twice in one verdict posts once", () => {
  const plan = planReview(
    base({ verdict: { summary: "", findings: [finding(), finding()], resolved: [] } }),
  );
  assert.equal(plan.inline.length, 1);
});

// A regression IS worth saying again. The ledger's unique index is on (pr, fingerprint),
// so the row has to come back rather than block - and it keeps its original id, so the
// history of that issue stays one row.
test("an issue that was resolved and has come back is raised again, on the same row", () => {
  const fp = fingerprint("src/a.ts", "Reaches into the concrete type");
  const plan = planReview(
    base({
      verdict: { summary: "", findings: [finding()], resolved: [] },
      existing: new Map([[fp, row({ id: "original-row", fingerprint: fp, status: "resolved" })]]),
    }),
  );
  assert.equal(plan.inline.length, 1);
  assert.equal(plan.inline[0]!.id, "original-row");
});

// ---- dry-run must not become a trap ----

// A dry-run round writes `drafted` rows so the preview is stable across ticks. Those
// rows occupy the fingerprint slot, so if `drafted` counted as "already posted", turning
// the feature on would silently suppress every finding it had previewed - the exact
// findings the operator turned it on to see.
test("a dry-run preview is still unposted, so going live posts it", () => {
  const fp = fingerprint("src/a.ts", "Reaches into the concrete type");
  const plan = planReview(
    base({
      verdict: { summary: "", findings: [finding()], resolved: [] },
      existing: new Map([[fp, row({ fingerprint: fp, status: "drafted" })]]),
    }),
  );
  assert.equal(plan.inline.length, 1, "a previewed finding must still be postable");
});

test("a dry-run review says so in its own body", () => {
  const plan = planReview(base({ mode: "dry-run", verdict: { summary: "x", findings: [], resolved: [] } }));
  assert.match(plan.body, /dry run/i);
});

// ---- resolution is narrowing only ----

test("only threads we own are ever resolved", () => {
  const mine = fingerprint("src/a.ts", "Mine");
  const plan = planReview(
    base({
      verdict: { summary: "", findings: [], resolved: [mine, "not-a-thread-we-know", "fp-theirs"] },
      threads: new Map<string, OurThread>([
        [mine, { fingerprint: mine, threadId: "T_mine", isResolved: false }],
      ]),
    }),
  );
  assert.deepEqual(plan.resolve, [{ fingerprint: mine, threadId: "T_mine" }]);
});

test("an already-resolved thread is not resolved twice", () => {
  const fp = fingerprint("src/a.ts", "Mine");
  const plan = planReview(
    base({
      verdict: { summary: "", findings: [], resolved: [fp] },
      threads: new Map<string, OurThread>([
        [fp, { fingerprint: fp, threadId: "T", isResolved: true }],
      ]),
    }),
  );
  assert.deepEqual(plan.resolve, []);
});

// A model that both closes an issue and raises it in the same breath has contradicted
// itself. Believing the close would silently bury a live finding; believing the raise
// costs at most one redundant comment.
test("when the model both closes and raises an issue, the raise wins", () => {
  const fp = fingerprint("src/a.ts", "Reaches into the concrete type");
  const plan = planReview(
    base({
      verdict: { summary: "", findings: [finding()], resolved: [fp] },
      threads: new Map<string, OurThread>([
        [fp, { fingerprint: fp, threadId: "T", isResolved: false }],
      ]),
    }),
  );
  assert.deepEqual(plan.resolve, []);
  assert.equal(plan.inline.length, 1);
});

// ---- anchoring ----

test("a line that isn't in the diff snaps to the nearest one that is", () => {
  // Left alone this is a 422 that discards the WHOLE review, not just this comment.
  const plan = planReview(
    base({ verdict: { summary: "", findings: [finding({ line: 900 })], resolved: [] } }),
  );
  assert.equal(plan.inline.length, 1);
  assert.equal(plan.inline[0]!.line, 4, "should snap to the closest commentable line");
});

test("a finding with no line at all still lands somewhere valid", () => {
  const plan = planReview(
    base({ verdict: { summary: "", findings: [finding({ line: null })], resolved: [] } }),
  );
  assert.equal(plan.inline.length, 1);
  assert.notEqual(plan.inline[0]!.line, null);
});

test("a file with nothing commentable is folded into the body, not lost", () => {
  const deletionOnly = `--- a/src/gone.ts
+++ b/src/gone.ts
@@ -1,2 +1,0 @@
-const a = 1;
-const b = 2;
`;
  const plan = planReview(
    base({
      lines: commentableLines(deletionOnly),
      verdict: {
        summary: "s",
        findings: [finding({ path: "src/gone.ts", line: null, title: "Removed the only caller" })],
        resolved: [],
      },
    }),
  );
  assert.equal(plan.inline.length, 0);
  assert.equal(plan.demoted.length, 1);
  assert.match(plan.body, /Removed the only caller/);
});

// ---- the cap ----

test("the cap keeps the worst findings and admits it held the rest back", () => {
  const findings = [
    finding({ title: "nit one", severity: "nit" }),
    finding({ title: "blocker one", severity: "blocker" }),
    finding({ title: "minor one", severity: "minor" }),
    finding({ title: "major one", severity: "major" }),
  ];
  const plan = planReview(base({ maxComments: 2, verdict: { summary: "s", findings, resolved: [] } }));
  assert.deepEqual(
    plan.inline.map((c) => c.title),
    ["blocker one", "major one"],
    "severity, not the order the model happened to emit",
  );
  assert.equal(plan.droppedOverCap, 2);
  // Silence here would read as "that's everything I found", which is the one thing a
  // reviewer must never imply when it isn't true.
  assert.match(plan.body, /held back/i);
});

test("a clean review says nothing about caps or held-back findings", () => {
  const plan = planReview(base({ verdict: { summary: "Nothing to flag.", findings: [], resolved: [] } }));
  assert.equal(plan.inline.length, 0);
  assert.equal(plan.droppedOverCap, 0);
  assert.equal(plan.clean, true, "only an explicit empty finding list may produce the clean review");
  assert.ok(!/held back/i.test(plan.body));
});

test("a review with any finding is not clean, even when that finding is dropped", () => {
  const plan = planReview(
    base({ verdict: { summary: "", findings: [finding({ path: "not-in-the-pr.ts" })], resolved: [] } }),
  );
  assert.equal(plan.clean, false, "an unreviewable finding must not turn into a merge-safe claim");
});

// ---- layer 5 reaches every outbound string ----

test("secrets are scrubbed from finding bodies AND from the summary", () => {
  const leak = "the key is ghp_AbCdEf0123456789AbCdEf0123456789abcd";
  const plan = planReview(
    base({
      verdict: {
        summary: `Summary: ${leak}`,
        findings: [finding({ body: `Body: ${leak}` })],
        resolved: [],
      },
    }),
  );
  assert.ok(!plan.inline[0]!.body.includes("ghp_AbCdEf"), "inline bodies are scrubbed");
  // The summary is the one output layer 4 does NOT constrain, since it is not anchored
  // to a changed file - so it is the one that most needs layer 5.
  assert.ok(!plan.body.includes("ghp_AbCdEf"), "the summary is scrubbed too");
});

// ---- leak-defence layer 5, on the title as well as the body ----

// `renderComment` interpolates the title into every published inline comment. Scrubbing
// the body while letting the title through means the one string that is guaranteed to
// appear in a public comment is the one string nobody cleaned.
test("a finding's title is scrubbed, not just its body", () => {
  const plan = planReview(
    base({
      verdict: {
        summary: "",
        findings: [
          finding({
            title: "Token ghp_AbCdEf0123456789AbCdEf0123456789abcd is committed",
            body: "Move it out.",
          }),
        ],
        resolved: [],
      },
    }),
  );
  assert.equal(plan.inline.length, 1);
  assert.doesNotMatch(plan.inline[0]!.title, /ghp_AbCdEf/, "the title reaches a public comment");
});

// ---- a round that may already be public is never raised again ----

// A `posting` row means a review carrying this finding was handed to GitHub and we do
// not know whether the response was lost. Re-raising it is how the same comment gets
// posted twice under the operator's name.
test("a finding mid-post is treated as already raised", () => {
  const fp = fingerprint("src/a.ts", "Reaches into the concrete type");
  const plan = planReview(
    base({
      verdict: { summary: "", findings: [finding()], resolved: [] },
      existing: new Map([[fp, row({ fingerprint: fp, status: "posting" })]]),
    }),
  );
  assert.equal(plan.inline.length, 0);
});

// ---- closing what has no thread to close ----

// In dry run nothing was posted, so there are no threads - and because a raised row is
// never re-raised, a drafted finding the next push fixes would stay open forever. The
// settings panel counts drafted rows as open, so the one number the operator can read
// while evaluating the feature would only ever grow.
test("a dry-run finding the next push fixed is closed in the ledger", () => {
  const fp = fingerprint("src/a.ts", "Mine");
  const plan = planReview(
    base({
      mode: "dry-run",
      verdict: { summary: "", findings: [], resolved: [fp] },
      existing: new Map([[fp, row({ fingerprint: fp, status: "drafted" })]]),
      threads: new Map(),
    }),
  );
  assert.deepEqual(plan.resolve, [], "there is no thread to ask GitHub about");
  assert.deepEqual(plan.resolveLocal, [fp]);
});

// Same shape in live mode: a finding with nowhere to anchor goes in the review body, so
// it has no thread either and was equally unclosable.
test("a demoted finding the next push fixed is closed in the ledger", () => {
  const fp = fingerprint("src/a.ts", "Mine");
  const plan = planReview(
    base({
      verdict: { summary: "", findings: [], resolved: [fp] },
      existing: new Map([[fp, row({ fingerprint: fp, line: null, status: "open" })]]),
      threads: new Map(),
    }),
  );
  assert.deepEqual(plan.resolveLocal, [fp]);
});

test("a fingerprint we have no row for is not closed anywhere", () => {
  const plan = planReview(
    base({ verdict: { summary: "", findings: [], resolved: ["fp-we-never-raised"] } }),
  );
  assert.deepEqual(plan.resolve, []);
  assert.deepEqual(plan.resolveLocal, []);
});

// ---- carried drafts: posting dry-run findings after a switch to live ----
//
// A draft the model leaves alone is posted by the planner, not by the model, so the checks a
// new finding gets have to hold for it too: still in the diff, a line that snaps, the scrub,
// the cap. And a draft GitHub keeps refusing has to stop being offered.

function draft(over: Partial<InspectorComment> = {}): InspectorComment {
  const title = over.title ?? "Previewed in dry run";
  const path = over.path ?? "src/a.ts";
  return row({
    id: `draft-${title}`,
    fingerprint: fingerprint(path ?? "", title),
    path,
    line: 2,
    title,
    body: "What the dry run found.",
    status: "drafted",
    postRefusals: 0,
    ...over,
  });
}

function existingOf(...rows: InspectorComment[]): Map<string, InspectorComment> {
  return new Map(rows.map((r) => [r.fingerprint, r]));
}

test("a live round carries a draft the model neither resolved nor raised again", () => {
  const d = draft();
  const plan = planReview(base({ existing: existingOf(d) }));
  assert.deepEqual(plan.inline.map((c) => [c.id, c.fingerprint, c.line, c.carried]), [[d.id, d.fingerprint, 2, true]]);
  assert.equal(plan.inline[0]!.body, "What the dry run found.");
  assert.equal(plan.clean, true, "the model still reported nothing new");
});

test("a round that will not publish carries nothing", () => {
  const plan = planReview(base({ live: false, existing: existingOf(draft()) }));
  assert.equal(plan.inline.length, 0);
});

test("a draft the model resolved is closed, not carried", () => {
  const d = draft();
  const plan = planReview(base({
    existing: existingOf(d),
    verdict: { summary: "", findings: [], resolved: [d.fingerprint] },
  }));
  assert.equal(plan.inline.length, 0);
  assert.deepEqual(plan.resolveLocal, [d.fingerprint]);
});

test("a draft the model raised again is a new finding, and the refusal cap does not apply to it", () => {
  const d = draft({ title: "Reaches into the concrete type", postRefusals: 3 });
  const plan = planReview(base({
    existing: existingOf(d),
    verdict: { summary: "", findings: [finding()], resolved: [] },
  }));
  assert.equal(plan.inline.length, 1);
  assert.equal(plan.inline[0]!.carried, undefined, "raised this round, so not carried");
  assert.equal(plan.inline[0]!.id, d.id, "on its own row");
});

test("a draft whose file left the diff is not carried", () => {
  const plan = planReview(base({ existing: existingOf(draft({ path: "src/gone.ts" })) }));
  assert.equal(plan.inline.length + plan.demoted.length, 0);
  assert.equal(plan.droppedOffDiff, 0, "it was never a finding of this round to drop");
});

test("a carried draft's line snaps to one the diff can anchor", () => {
  const plan = planReview(base({ existing: existingOf(draft({ line: 40 })) }));
  // The diff's right side runs to line 4, its trailing context line.
  assert.equal(plan.inline[0]!.line, 4);
});

test("a draft is carried below the refusal cap and not at it", () => {
  const twice = draft({ title: "Refused twice", postRefusals: 2 });
  const thrice = draft({ title: "Refused three times", postRefusals: 3 });
  const plan = planReview(base({ existing: existingOf(twice, thrice) }));
  assert.deepEqual(plan.inline.map((c) => c.title), ["Refused twice"]);
});

test("a legacy draft with no persisted body is not carried", () => {
  const plan = planReview(base({ existing: existingOf(draft({ body: null })) }));
  assert.equal(plan.inline.length, 0);
});

test("only drafted rows are carried", () => {
  const plan = planReview(base({
    existing: existingOf(
      draft({ title: "Open", status: "open" }),
      draft({ title: "Posting", status: "posting" }),
      draft({ title: "Resolved", status: "resolved" }),
    ),
  }));
  assert.equal(plan.inline.length, 0);
});

test("carried drafts share the cap, new findings first at equal severity", () => {
  const carriedMajor = draft({ title: "Carried major", severity: "major" });
  const carriedBlocker = draft({ title: "Carried blocker", severity: "blocker" });
  const plan = planReview(base({
    maxComments: 2,
    existing: existingOf(carriedMajor, carriedBlocker),
    verdict: { summary: "", findings: [finding({ title: "New major" })], resolved: [] },
  }));
  assert.deepEqual(plan.inline.map((c) => c.title), ["Carried blocker", "New major"]);
  assert.equal(plan.droppedOverCap, 1, "the carried major is held back, and the body says so");
  assert.match(plan.body, /held back/);
});

test("a draft the prompt cut for length is not carried, since the model never saw it", () => {
  const shown = draft({ title: "Listed in the prompt" });
  const cut = draft({ title: "Cut from the prompt" });
  const plan = planReview(base({
    existing: existingOf(shown, cut),
    prompted: new Set([shown.fingerprint]),
  }));
  assert.deepEqual(plan.inline.map((c) => c.title), ["Listed in the prompt"]);
});

test("a carried draft is scrubbed on the way out like any other comment", () => {
  const plan = planReview(base({
    existing: existingOf(draft({ body: "Leaked ghp_abcdefghijklmnopqrstuvwxyz0123456789 here." })),
  }));
  assert.doesNotMatch(plan.inline[0]!.body, /ghp_abcdefghijklmnopqrstuvwxyz0123456789/);
});
