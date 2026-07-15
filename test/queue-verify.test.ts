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
