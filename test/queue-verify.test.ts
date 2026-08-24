import { test } from "node:test";
import assert from "node:assert/strict";
import type { z } from "zod";
import { QueueVerdictSchema } from "../src/server/foreman/queue-verify.ts";

// The verdict schema's bounds are a DEFENCE on text that ends up typed into a
// tool-enabled agent. They must CLAMP rather than reject: a rejected parse throws
// away an otherwise-valid verdict, runStructured retries the identical prompt, gets
// the identical answer, and the item escalates as "Foreman could not verify this
// item" after six `claude -p` spawns - over nothing but a verbose sentence.

function gap(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "g1",
    severity: "advisory",
    kind: "standards",
    path: "src/a.ts",
    detail: "the retry has no test",
    fix: "add one",
    ...over,
  };
}

/** Parse, asserting success, and hand back the verdict. */
function parseOk(input: unknown, why: string): z.infer<typeof QueueVerdictSchema> {
  const r = QueueVerdictSchema.safeParse(input);
  assert.ok(r.success, `${why} (got: ${r.success ? "" : r.error.message})`);
  return r.data;
}

/** The nth gap, asserted present so the test fails loudly rather than on undefined. */
function gapAt(v: z.infer<typeof QueueVerdictSchema>, n: number) {
  const g = v.gaps[n];
  assert.ok(g, `expected a gap at ${n}`);
  return g;
}

test("the additive unverified kind parses without changing the existing gap vocabulary", () => {
  for (const kind of ["incomplete", "untested", "standards", "regression", "unverified"] as const) {
    const verdict = parseOk(
      { complete: kind === "unverified", summary: "classified", gaps: [gap({ kind })] },
      `${kind} remains a valid gap kind`,
    );
    assert.equal(gapAt(verdict, 0).kind, kind);
  }
});

test("an over-long detail is clamped, not rejected - a COMPLETE verdict survives verbosity", () => {
  // The prompt never even states a `detail` cap: it documents `<= 600 chars` for
  // `fix` alone and asks for "what is missing, concretely", which invites length.
  // Rejecting here escalates finished work over a long sentence.
  const v = parseOk(
    {
      complete: true,
      summary: "the intent is satisfied",
      gaps: [gap({ detail: "x".repeat(700) })],
    },
    "a 700-char detail must not throw the whole verdict away",
  );

  assert.equal(v.complete, true);
  assert.equal(gapAt(v, 0).detail.length, 600, "it is clamped to the bound");
});

test("an over-long fix is clamped too - the cap is a bound, not a rejection", () => {
  const v = parseOk(
    { complete: false, summary: "not done", gaps: [gap({ fix: "y".repeat(900) })] },
    "a 900-char fix must not throw the verdict away",
  );

  assert.equal(gapAt(v, 0).fix.length, 600);
});

test("more than 3 gaps clamps to the most severe, rather than discarding the verdict", () => {
  // A plain slice would let three advisory nits crowd out the blocking gap - and
  // only blocking gaps drive a fix round, so that would silently turn real work into
  // a no-op.
  const v = parseOk(
    {
      complete: false,
      summary: "several problems",
      gaps: [
        gap({ id: "a1", severity: "advisory" }),
        gap({ id: "a2", severity: "advisory" }),
        gap({ id: "a3", severity: "advisory" }),
        gap({ id: "b1", severity: "blocking" }),
      ],
    },
    "a 4th gap must not throw the verdict away",
  );

  assert.equal(v.gaps.length, 3);
  assert.ok(
    v.gaps.some((g) => g.id === "b1"),
    "the only blocking gap must survive the trim",
  );
  assert.equal(gapAt(v, 0).id, "b1", "most severe first, as the prompt asks");
});

test("a verdict that genuinely doesn't parse is still rejected", () => {
  // Clamping is not permissiveness: the shape still has to be right.
  assert.equal(QueueVerdictSchema.safeParse({ summary: "no complete field" }).success, false);
  assert.equal(
    QueueVerdictSchema.safeParse({
      complete: false,
      summary: "s",
      gaps: [gap({ severity: "catastrophic" })],
    }).success,
    false,
    "an unknown severity is a real parse failure - it would break the blocking gate",
  );
  assert.equal(
    QueueVerdictSchema.safeParse({ complete: true, summary: "s", gaps: [gap({ detail: "" })] })
      .success,
    false,
    "an empty detail carries no information for the agent to act on",
  );
});

test("two gaps that collide on one id are BOTH kept, under distinct ids", () => {
  // The prompt asks for "a stable slug for this problem" and never says it must be
  // unique within one verdict, so two blocking gaps about two different files both
  // slugged `untested` is an ordinary answer. Round 0 has no prior gaps to reconcile
  // against, so duplicates land as-is and everything keyed on the id then speaks
  // about the wrong one: the panel renders `<li key={g.id}>` and React folds both
  // rows onto one slot, so the human sees ONE gap while the fix prompt (which lists
  // by index) tells the agent to fix TWO.
  const v = parseOk(
    {
      complete: false,
      summary: "two files, one slug",
      gaps: [
        gap({ id: "untested", severity: "blocking", path: "src/a.ts", detail: "a has no test" }),
        gap({ id: "untested", severity: "blocking", path: "src/b.ts", detail: "b has no test" }),
      ],
    },
    "a colliding slug is a naming problem, not a reason to discard the verdict",
  );
  assert.equal(v.gaps.length, 2, "neither gap may be dropped - they are about different files");
  assert.equal(new Set(v.gaps.map((g) => g.id)).size, 2, "and they must be distinguishable");
  assert.equal(gapAt(v, 0).id, "untested", "the first keeps the slug the model chose");
  assert.equal(gapAt(v, 0).path, "src/a.ts");
  assert.equal(gapAt(v, 1).path, "src/b.ts", "the reminted one keeps its own content");
});

test("a reminted id still respects the id cap it was reminted under", () => {
  // `clampTo` can itself CREATE the collision, by truncating two long distinct ids to
  // the same 120 chars. Suffixing without re-clamping would then push the survivor
  // back over the bound the cap exists to hold.
  const long = "x".repeat(200);
  const v = parseOk(
    {
      complete: false,
      summary: "two long ids that clamp to the same thing",
      gaps: [
        gap({ id: `${long}-a`, severity: "blocking", detail: "first" }),
        gap({ id: `${long}-b`, severity: "blocking", detail: "second" }),
      ],
    },
    "ids clamped into a collision are still two real gaps",
  );
  assert.equal(new Set(v.gaps.map((g) => g.id)).size, 2);
  for (const g of v.gaps) assert.ok(g.id.length <= 120, `id stayed within the cap: ${g.id.length}`);
});

test("uniqueness is applied AFTER the trim, so a dropped gap can't remint a survivor", () => {
  // The cap keeps the 3 most severe. A collision with a gap that didn't survive is
  // not a collision at all, and reminting over it would rename a gap the agent is
  // being asked to fix - resetting its strikes for no reason.
  const v = parseOk(
    {
      complete: false,
      summary: "one blocking, three advisory nits sharing its slug",
      gaps: [
        gap({ id: "dupe", severity: "advisory", detail: "nit one" }),
        gap({ id: "dupe", severity: "blocking", detail: "the real problem" }),
        gap({ id: "dupe", severity: "advisory", detail: "nit two" }),
        gap({ id: "dupe", severity: "advisory", detail: "nit three" }),
      ],
    },
    "a 4th gap is not worth discarding a verdict over",
  );
  assert.equal(v.gaps.length, 3);
  assert.equal(gapAt(v, 0).id, "dupe", "the blocking gap sorts first and keeps the slug");
  assert.equal(gapAt(v, 0).detail, "the real problem");
  assert.equal(new Set(v.gaps.map((g) => g.id)).size, 3);
});
