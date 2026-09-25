// What is at stake: the dispatch form does four different jobs, and until now it worked out
// which one from a handful of independent optional props - an edit target, a guided pass, a
// launch mode, an Ensemble draft, a tour preview. Those combine into openings that mean
// nothing ("edit this task, as an Ensemble, during the tour"), and the form had to invent a
// precedence to render at all. The failure this guards against is that precedence coming back:
// a contradictory opening that renders SOMETHING - fields from one job, a submit path from
// another - instead of being refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { withOverlayHost } from "./helpers/overlay-host.ts";
import { mkTask } from "./helpers/session-fixture.ts";
import { DispatchLayer } from "../src/web/components/DispatchModal.tsx";
import {
  DispatchModeSchema,
  DispatchOpeningSchema,
  dispatchModeProblem,
  dispatchOpeningProblem,
  resolveDispatchOpening,
  type DispatchMode,
  type DispatchOpening,
  type DispatchRequest,
} from "../src/web/lib/dispatch-mode.ts";
import { NO_GUIDED_PASS } from "../src/web/lib/guided-dispatch-steps.ts";
import { freshEnsembleDraft } from "../src/web/ensembles/dispatch/config.ts";

const demo = {
  id: "run-1",
  briefReady: true,
  repoRoot: "/repos/demo",
  dispatch: async () => ({ ok: true as const }),
};

/**
 * Every opening a caller can legitimately ask for. The point of the list is exhaustiveness:
 * a fifth opening has to be added here to be considered valid, which is the same edit as
 * teaching the layer what to do with it.
 */
const VALID_OPENINGS: DispatchOpening[] = [
  { kind: "new" },
  { kind: "ensemble", strategyId: "best_of_n" },
  { kind: "edit", task: mkTask() },
  { kind: "tour", demo },
];

const VALID_MODES: DispatchMode[] = [
  {
    kind: "single",
    guidedPass: null,
    onGuidedPassChange: () => {},
    onLaunchModeChange: () => {},
  },
  {
    kind: "ensemble",
    onLaunchModeChange: () => {},
    ensemble: freshEnsembleDraft(),
    onEnsembleChange: () => {},
    onEnsembleClear: () => {},
    onEnsembleLaunched: () => {},
    personas: [],
  },
  { kind: "edit", task: mkTask(), onDeleted: () => {} },
  { kind: "tour", demo },
];

test("every supported opening and mode is accepted", () => {
  for (const opening of VALID_OPENINGS) {
    assert.equal(dispatchOpeningProblem(opening), null, `${opening.kind} opening was refused`);
  }
  for (const mode of VALID_MODES) {
    assert.equal(dispatchModeProblem(mode), null, `${mode.kind} mode was refused`);
  }
  // A closed form is not a contradiction.
  assert.equal(dispatchOpeningProblem(null), null);
});

test("an edit mode may carry its optional schedule door, and nothing else optional to it", () => {
  assert.equal(
    dispatchModeProblem({
      kind: "edit",
      task: mkTask(),
      onDeleted: () => {},
      onOpenSchedule: () => {},
    }),
    null,
  );
});

test("an opening naming two jobs at once is refused, and says which fields disagree", () => {
  // The exact shapes the old prop list could spell. Each is cast, because the union these
  // tests defend has already made them uncompilable - which is the point: what is left to
  // check is the value that never went through the compiler.
  const contradictions: Array<[unknown, RegExp]> = [
    [{ kind: "edit", task: mkTask(), strategyId: "best_of_n" }, /strategyId, which belongs to ensemble/],
    [{ kind: "tour", demo, task: mkTask() }, /task, which belongs to edit/],
    [{ kind: "new", demo }, /demo, which belongs to tour/],
    [{ kind: "ensemble", strategyId: "best_of_n", demo }, /demo, which belongs to tour/],
  ];
  for (const [opening, expected] of contradictions) {
    const problem = dispatchOpeningProblem(opening as DispatchOpening);
    assert.ok(problem, `${JSON.stringify(Object.keys(opening as object))} was accepted`);
    assert.match(problem, expected);
  }
});

test("a mode carrying another mode's inputs is refused", () => {
  const contradictions: Array<[unknown, RegExp]> = [
    // The reported shape: an edit that also thinks it is an Ensemble.
    [
      { kind: "edit", task: mkTask(), onDeleted: () => {}, ensemble: freshEnsembleDraft() },
      /the edit dispatch mode carrying ensemble, which belongs to ensemble/,
    ],
    // A tour with a guided pass: the tour's draft is server-owned, so a pass has nothing to ask.
    [
      { kind: "tour", demo, guidedPass: NO_GUIDED_PASS },
      /the tour dispatch mode carrying guidedPass, which belongs to single/,
    ],
    // Single with the Ensemble launch callback: a Launch that would fire from a form with no
    // plan behind it.
    [
      {
        kind: "single",
        guidedPass: null,
        onGuidedPassChange: () => {},
        onLaunchModeChange: () => {},
        onEnsembleLaunched: () => {},
      },
      /carrying onEnsembleLaunched, which belongs to ensemble/,
    ],
    // An edit offering the Single/Ensemble toggle, which is what it looked like before the
    // toggle rode with the modes that can actually move between them.
    [
      { kind: "edit", task: mkTask(), onDeleted: () => {}, onLaunchModeChange: () => {} },
      /carrying onLaunchModeChange, which belongs to single or ensemble/,
    ],
  ];
  for (const [mode, expected] of contradictions) {
    const problem = dispatchModeProblem(mode as DispatchMode);
    assert.ok(problem, `${JSON.stringify(Object.keys(mode as object))} was accepted`);
    assert.match(problem, expected);
  }
});

test("a mode missing an input its own job needs is refused, not defaulted", () => {
  // The old props all had defaults, so this shape rendered an Ensemble body with no draft
  // behind it. `guidedPass` is checked with `in` rather than by truthiness, because `null`
  // is its legitimate untouched-draft value.
  assert.match(
    dispatchModeProblem({ kind: "ensemble", onLaunchModeChange: () => {} } as unknown as DispatchMode) ?? "",
    /the ensemble dispatch mode without its ensemble/,
  );
  assert.match(
    dispatchModeProblem({
      kind: "single",
      onGuidedPassChange: () => {},
      onLaunchModeChange: () => {},
    } as unknown as DispatchMode) ?? "",
    /without its guidedPass/,
  );
  assert.equal(
    dispatchModeProblem({
      kind: "single",
      guidedPass: null,
      onGuidedPassChange: () => {},
      onLaunchModeChange: () => {},
    }),
    null,
  );
});

test("an unrecognised kind is refused rather than treated as a fresh dispatch", () => {
  for (const kind of ["swarm", "", undefined]) {
    assert.match(
      dispatchOpeningProblem({ kind } as unknown as DispatchOpening) ?? "",
      /an unsupported dispatch opening .*expected one of new, ensemble, edit, tour/,
    );
  }
  assert.match(dispatchOpeningProblem("new" as unknown as DispatchOpening) ?? "", /not an object/);
  assert.match(dispatchOpeningProblem([] as unknown as DispatchOpening) ?? "", /not an object/);
});

test("a contradictory opening renders no form at all", () => {
  const errors: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
  try {
    const html = renderToStaticMarkup(
      withOverlayHost(
        createElement(DispatchLayer, {
          opening: { kind: "edit", task: mkTask(), demo } as unknown as DispatchOpening,
          onClose: () => {},
        }),
      ),
    );
    // Not "an edit form with the tour's draft", and not a new-dispatch form either. Nothing.
    assert.doesNotMatch(html, /Edit backlog task/);
    assert.doesNotMatch(html, /Dispatch an agent/);
  } finally {
    console.error = real;
  }
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /Dispatch did not open: it was given the edit dispatch opening carrying demo/);
});

test("each valid opening renders its own form, and only its own", () => {
  const render = (opening: DispatchOpening): string =>
    renderToStaticMarkup(
      withOverlayHost(createElement(DispatchLayer, { opening, onClose: () => {} })),
    );

  const fresh = render({ kind: "new" });
  assert.match(fresh, /aria-label="Dispatch an agent"/);
  assert.match(fresh, /dispatch-mode-toggle/);
  assert.doesNotMatch(fresh, /Delete this task from the backlog/);

  const editing = render({ kind: "edit", task: mkTask({ status: "backlog" }) });
  assert.match(editing, /aria-label="Edit a backlog task"/);
  // No way into Ensemble from a row that already exists, and no Launch control.
  assert.doesNotMatch(editing, /dispatch-mode-toggle/);
  assert.match(editing, /Delete this task from the backlog/);

  const ensemble = render({ kind: "ensemble", strategyId: "best_of_n" });
  // A strategy launcher arms Ensemble for its own opening: the mode toggle is there and sits
  // on Ensemble, and the Single-only backlog bookkeeping is gone rather than merely hidden.
  assert.match(ensemble, /dispatch-modal-ensemble/);
  assert.match(ensemble, /aria-checked="true"[^>]*>Ensemble</);
  assert.doesNotMatch(ensemble, /Backlog details/);

  const tour = render({ kind: "tour", demo });
  // The tour drives a fixed form: no mode toggle and no guided pass to start.
  assert.doesNotMatch(tour, /dispatch-mode-toggle/);
  assert.doesNotMatch(tour, /Guided/);
  // And it is the tour's own draft, not the operator's.
  assert.match(tour, /value="Tour demo"/);
});

test("the refusal names owners read off the schema itself, not a second list", () => {
  // Every field any mode variant declares, straight from the schema. If a refusal ever names an
  // owner this does not, the message and the contract have come apart.
  for (const option of DispatchModeSchema.options) {
    for (const field of Object.keys(option.shape)) {
      if (field === "kind") continue;
      const owners = DispatchModeSchema.options
        .filter((other) => field in other.shape)
        .map((other) => other.shape.kind.value);
      const stranger = DispatchModeSchema.options.find((other) => !(field in other.shape));
      if (!stranger) continue;
      const problem = dispatchModeProblem({
        ...VALID_MODES.find((mode) => mode.kind === stranger.shape.kind.value)!,
        [field]: () => {},
      } as DispatchMode);
      assert.match(problem ?? "", new RegExp(`carrying ${field}, which belongs to ${owners.join(" or ")}$`));
    }
  }
  // And every opening kind the schema declares is one the refusal lists, in the schema's order.
  const kinds = DispatchOpeningSchema.options.map((option) => option.shape.kind.value).join(", ");
  assert.match(dispatchOpeningProblem({ kind: "nope" } as unknown as DispatchOpening) ?? "", new RegExp(`expected one of ${kinds}$`));
});

test("one request resolves to one opening, and the tour's claim is on the fresh form only", () => {
  const task = mkTask({ id: "task-1", status: "backlog" });
  const idle = { editTask: null, tourDemo: null };
  const touring = { editTask: null, tourDemo: demo };

  assert.deepEqual(resolveDispatchOpening(null, idle), { opening: null, problem: null });
  assert.deepEqual(resolveDispatchOpening({ kind: "new" }, idle), { opening: { kind: "new" }, problem: null });
  assert.deepEqual(
    resolveDispatchOpening({ kind: "ensemble", strategyId: "panel_vote" }, idle),
    { opening: { kind: "ensemble", strategyId: "panel_vote" }, problem: null },
  );
  assert.deepEqual(
    resolveDispatchOpening({ kind: "edit", taskId: "task-1" }, { editTask: task, tourDemo: null }),
    { opening: { kind: "edit", task }, problem: null },
  );

  // The tour runs its preview through the fresh-dispatch form: a new request IS its opening.
  assert.deepEqual(
    resolveDispatchOpening({ kind: "new" }, touring),
    { opening: { kind: "tour", demo }, problem: null },
  );
  // It does not claim the backlog editor, which is a different form over an existing row.
  assert.deepEqual(
    resolveDispatchOpening({ kind: "edit", taskId: "task-1" }, { editTask: task, tourDemo: demo }),
    { opening: { kind: "edit", task }, problem: null },
  );
});

test("an Ensemble request while the tour holds the fresh form is refused, not won", () => {
  // The one collision left once the request is a single value. The old precedence chain let the
  // tour win and dropped the Ensemble the operator asked for without a word.
  const resolved = resolveDispatchOpening(
    { kind: "ensemble", strategyId: "best_of_n" },
    { editTask: null, tourDemo: demo },
  );
  assert.equal(resolved.opening, null);
  assert.match(
    resolved.problem ?? "",
    /an Ensemble request for best_of_n while the See the work tour holds the fresh-dispatch form/,
  );
});

test("an edit whose row has left resolves to a closed form, not a refusal", () => {
  // A task launched or deleted under its editor is a reconciliation the caller already makes;
  // it is not a contradiction and must not log as one.
  for (const editTask of [null, mkTask({ id: "some-other-task" })]) {
    assert.deepEqual(
      resolveDispatchOpening({ kind: "edit", taskId: "task-1" }, { editTask, tourDemo: null }),
      { opening: null, problem: null },
    );
  }
});

test("every opening the resolver produces passes the opening contract", () => {
  const task = mkTask({ id: "task-1", status: "backlog" });
  const requests: Array<DispatchRequest | null> = [
    null,
    { kind: "new" },
    { kind: "edit", taskId: "task-1" },
    ...(["best_of_n", "consensus", "panel_vote"] as const).map(
      (strategyId) => ({ kind: "ensemble", strategyId }) as const,
    ),
  ];
  for (const request of requests) {
    for (const tourDemo of [null, demo]) {
      const { opening } = resolveDispatchOpening(request, { editTask: task, tourDemo });
      assert.equal(dispatchOpeningProblem(opening), null, JSON.stringify({ request, tour: !!tourDemo }));
    }
  }
});
