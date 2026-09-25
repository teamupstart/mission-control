/**
 * What a dispatch form opening IS, as one value rather than a handful of independent flags.
 *
 * The dispatch modal does four different jobs - a single dispatch, an Ensemble launch, editing
 * a shelved task, and the See the work tour's fixed preview - and for a long time it learned
 * which one it was doing by reading four optional inputs and working out a precedence between
 * them. That arrangement can spell things that mean nothing: a task to edit AND an armed
 * Ensemble strategy, a tour preview AND a guided pass, an Ensemble draft on a form whose
 * footer has no Launch button. None of those combinations had a defined answer, and the answer
 * a reader would have guessed was not always the one the precedence chain produced.
 *
 * So each job is one variant of a discriminated union, and the inputs it needs ride INSIDE that
 * variant. A caller cannot hand the form an edit target and an Ensemble draft together, because
 * there is no shape that holds both.
 *
 * ONE definition per shape, and it is the schema. The TypeScript types below are inferred from
 * it, and the runtime check is a parse against it, so a field added to a mode is added to both
 * at once and a variant cannot be typed one way and validated another. Every variant is
 * `.strict()`, which is what turns "an edit carrying an Ensemble draft" from an ignored extra
 * key into a refusal; and which mode a stray field belongs to is read back off the same schemas,
 * so the refusal can say so. The parse is only ever used to CHECK a value, never to replace it:
 * the functions and records inside are handed to the form exactly as the caller built them.
 *
 * Browser-safe and free of React on purpose: the rule is a pure function of a value, so it is
 * covered in `test/` in milliseconds instead of through a DOM. Zod already reaches the
 * dashboard through `@shared/protocol.ts`, so this costs the bundle nothing.
 */
import { z } from "zod";

import type { Task } from "@shared/types.ts";
import { ENSEMBLE_STRATEGY_IDS, type EnsembleStrategyId } from "@shared/ensemble.ts";
import type { PersonaView } from "@shared/workflow.ts";
import type { ActionResult } from "./api.ts";
import type { DispatchDraft } from "./task-draft.ts";
import type { GuidedPass } from "./guided-dispatch-steps.ts";
import type { EnsembleDispatchDraft } from "../ensembles/dispatch/config.ts";

/** Single vs Ensemble, the one mode choice the operator makes from inside the open form. */
export type DispatchLaunchMode = "single" | "ensemble";

/** Temporary input owned by DispatchLayer while the See the work tour is active. */
export interface SeeWorkTourDispatchPreview {
  id: string;
  briefReady: boolean;
  repoRoot: string | null;
  dispatch: (repoRoot: string) => Promise<ActionResult & { task?: Task }>;
}

const isRecord = (value: unknown): boolean =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isFunction = (value: unknown): boolean => typeof value === "function";

/**
 * A field the form reads as a whole object it did not build - a stored Task, an Ensemble draft,
 * the tour's preview. Checked for being an object and typed as what it is; its own shape has an
 * owner already (the daemon's row, the Ensemble config module, the tour), and re-validating it
 * here would be a second opinion that could refuse a legitimate edit over a field this form
 * never reads.
 */
const record = <T>() => z.custom<T>(isRecord);
const callback = <T>() => z.custom<T>(isFunction);

const TaskField = record<Task>();
const TourDemoField = record<SeeWorkTourDispatchPreview>();
const LaunchModeChangeField = callback<(mode: DispatchLaunchMode) => void>();

/**
 * What the APP asked this opening to be. `null` is a closed form.
 *
 * Deliberately smaller than `DispatchMode`: an opening is a request carrying only what the
 * caller knows, and the draft, the launch mode and the Ensemble configuration all belong to
 * `DispatchLayer`, which survives a close. The layer turns an opening into exactly one mode.
 */
export const DispatchOpeningSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("new") }).strict(),
  z.object({ kind: z.literal("ensemble"), strategyId: z.enum(ENSEMBLE_STRATEGY_IDS) }).strict(),
  z.object({ kind: z.literal("edit"), task: TaskField }).strict(),
  z.object({ kind: z.literal("tour"), demo: TourDemoField }).strict(),
]);
export type DispatchOpening = z.infer<typeof DispatchOpeningSchema>;
export type DispatchOpeningKind = DispatchOpening["kind"];

/**
 * The form's operating mode, with the inputs that mode needs and none that belong to another.
 *
 * `single` and `ensemble` are the two halves of a new dispatch and both carry the toggle
 * between them, because switching is an operator action taken from inside the open form.
 * `edit` and `tour` carry no toggle at all: a shelved Task cannot become an Ensemble, and the
 * tour drives a fixed form.
 */
export const DispatchModeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("single"),
    /** Guided-pass progress, owned above the modal so close/reopen keeps it. `null` is untouched. */
    guidedPass: z.custom<GuidedPass | null>((value) => value === null || isRecord(value)),
    onGuidedPassChange: callback<(pass: GuidedPass | null) => void>(),
    onLaunchModeChange: LaunchModeChangeField,
  }).strict(),
  z.object({
    kind: z.literal("ensemble"),
    onLaunchModeChange: LaunchModeChangeField,
    ensemble: record<EnsembleDispatchDraft>(),
    onEnsembleChange: callback<(draft: EnsembleDispatchDraft) => void>(),
    onEnsembleClear: callback<() => void>(),
    onEnsembleLaunched: callback<(
      runId: string,
      submitted: DispatchDraft,
      submittedEnsemble: EnsembleDispatchDraft,
    ) => void>(),
    /** Live Personas, for the evaluator-guidance selector. */
    personas: z.custom<PersonaView[]>(Array.isArray),
  }).strict(),
  z.object({
    kind: z.literal("edit"),
    task: TaskField,
    onDeleted: callback<() => void>(),
    /** Open Recurring Missions from a generated task's read-only provenance. */
    onOpenSchedule: callback<
      (scheduleId: string, occurrenceId?: string, scheduledFor?: number) => void
    >().optional(),
  }).strict(),
  z.object({ kind: z.literal("tour"), demo: TourDemoField }).strict(),
]);
export type DispatchMode = z.infer<typeof DispatchModeSchema>;
export type DispatchModeKind = DispatchMode["kind"];

type AnyDispatchUnion = typeof DispatchOpeningSchema | typeof DispatchModeSchema;

/**
 * Which variants declare `field`, read off the schema itself - so the answer cannot drift from
 * the shapes the way a hand-kept ownership table could.
 */
function ownersOf(schema: AnyDispatchUnion, field: string): string[] {
  return schema.options
    .filter((option) => Object.hasOwn(option.shape, field))
    .map((option) => option.shape.kind.value);
}

/**
 * The one problem worth naming, or `null` for a value that means exactly one thing.
 *
 * Returns a phrase rather than a boolean because the caller logs it, and "the form refused to
 * open" without the reason is a bug report nobody can act on. It stops at the first problem:
 * the second is usually a consequence of the first, and a caller fixing one will be back. The
 * phrasing is this module's; the FACTS in it - which field, which kind, which owner - all come
 * from the parse.
 */
function problemWith(what: string, schema: AnyDispatchUnion, value: unknown): string | null {
  const parsed = schema.safeParse(value);
  if (parsed.success) return null;
  const issue = parsed.error.issues[0]!;
  if (issue.code === z.ZodIssueCode.invalid_type && issue.path.length === 0) {
    return `a ${what} that is not an object`;
  }
  if (issue.code === z.ZodIssueCode.invalid_union_discriminator) {
    const kind = isRecord(value) ? (value as { kind?: unknown }).kind : undefined;
    const kinds = schema.options.map((option) => option.shape.kind.value).join(", ");
    return `an unsupported ${what} ${JSON.stringify(kind ?? null)}; expected one of ${kinds}`;
  }
  const kind = String((value as { kind: unknown }).kind);
  if (issue.code === z.ZodIssueCode.unrecognized_keys) {
    const field = issue.keys[0]!;
    const owners = ownersOf(schema, field);
    return owners.length > 0
      ? `the ${kind} ${what} carrying ${field}, which belongs to ${owners.join(" or ")}`
      : `the ${kind} ${what} carrying ${field}, which no ${what} takes`;
  }
  const field = String(issue.path[0]);
  return (value as Record<string, unknown>)[field] === undefined
    ? `the ${kind} ${what} without its ${field}`
    : `the ${kind} ${what} with an unusable ${field}`;
}

/** Why this opening means more than one thing, or `null`. A closed form is not a problem. */
export function dispatchOpeningProblem(opening: DispatchOpening | null): string | null {
  if (opening === null) return null;
  return problemWith("dispatch opening", DispatchOpeningSchema, opening);
}

/** Why this mode means more than one thing, or `null`. */
export function dispatchModeProblem(mode: DispatchMode): string | null {
  return problemWith("dispatch mode", DispatchModeSchema, mode);
}

/**
 * What the dashboard's openers ASKED for: one value, written whole by whichever opener ran last.
 *
 * It used to be three pieces of state - an open flag, a task being edited, an Ensemble intent -
 * each opener clearing the other two by convention, and a precedence chain deciding what the
 * form was when a convention was missed. As one value, two requests at once cannot be written.
 * `edit` names its row by id, because the row itself is live and is read back per render.
 */
export type DispatchRequest =
  | { kind: "new" }
  | { kind: "edit"; taskId: string }
  | { kind: "ensemble"; strategyId: EnsembleStrategyId };

/** A resolved request: the opening to hand the layer, or why there is none. */
export type DispatchResolution =
  | { opening: DispatchOpening | null; problem: null }
  | { opening: null; problem: string };

/**
 * Turn the one request and the world it lands in into the one opening, or a refusal.
 *
 * The request is a single value, so the only other thing that can claim the form is the See the
 * work tour. While the tour runs its dispatch preview it owns the FRESH-dispatch form - its
 * spotlight is on the topbar Dispatch button, and pressing it is how the tour is taken - so an
 * ordinary new request is the tour's opening then. That is a claim, not a tie-break: the tour
 * does not claim the backlog editor, which is a different form over a row that already exists.
 *
 * What it does refuse is the one real collision left. A Library strategy card pressed while the
 * tour holds the fresh-dispatch form asks for an Ensemble on the form the tour has fixed to a
 * single demo dispatch. There is no right winner: the tour's form cannot be an Ensemble, and
 * the Ensemble the operator asked for cannot silently become the tour's single demo. So neither
 * opens, and the reason is said. No person reaches this today - the tour's overlay takes every
 * pointer event and keeps focus in its coachmark, so the Library cannot be pressed mid-tour -
 * which makes it a guard on a future caller, the same as the contradictions the schemas refuse.
 *
 * An edit whose row is gone resolves to a closed form rather than a refusal: that is a task
 * leaving under the editor (launched, deleted), which the caller already reconciles by
 * dropping the request.
 */
export function resolveDispatchOpening(
  request: DispatchRequest | null,
  world: { editTask: Task | null; tourDemo: SeeWorkTourDispatchPreview | null },
): DispatchResolution {
  if (request === null) return { opening: null, problem: null };
  switch (request.kind) {
    case "edit":
      return world.editTask && world.editTask.id === request.taskId
        ? { opening: { kind: "edit", task: world.editTask }, problem: null }
        : { opening: null, problem: null };
    case "ensemble":
      return world.tourDemo
        ? {
            opening: null,
            problem:
              `an Ensemble request for ${request.strategyId} while the See the work tour ` +
              "holds the fresh-dispatch form",
          }
        : { opening: { kind: "ensemble", strategyId: request.strategyId }, problem: null };
    case "new":
      return world.tourDemo
        ? { opening: { kind: "tour", demo: world.tourDemo }, problem: null }
        : { opening: { kind: "new" }, problem: null };
  }
}
