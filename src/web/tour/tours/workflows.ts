import {
  assertTourDefinition,
  goTo,
  refresh,
  restage,
  type TourDefinition,
  type TourStep,
  type TourStepContext,
} from "../contracts.ts";
import { assertTourContentStages, tourStageContent } from "../content.ts";

/**
 * The run this tour run pinned: always the daemon's seeded demonstration record.
 *
 * Deterministic on purpose. The tour never selects from the operator's own history - a
 * fleet full of real reviews changes nothing about what the tour shows - so the id here is
 * whatever `POST /api/tours/workflows/seed-run` answered with, seeded on the first ask and
 * reused on every later one.
 */
export interface WorkflowsTourRun {
  id: string;
}

export interface WorkflowsTourRuntime {
  /** The qualifying No-Mistakes Review run, or null while the demo record is still seeding. */
  run: WorkflowsTourRun | null;
  /** Why the daemon could not supply a run, when it refused. Null while seeding or done. */
  seedError: string | null;
  /**
   * The session whose binding chip and dialog stops 3 and 4 stand on: one pinned from the
   * fleet at start, or the tour's own temporary conversation once it joins. Null while
   * that conversation is still launching.
   */
  sessionId: string | null;
  /** Whether that session is in the live collection RIGHT NOW. */
  sessionLive: boolean;
  /** Why the temporary conversation could not start, when it refused. */
  sessionError: string | null;
  dispatchOpen: boolean;
  bindingDialogOpen: boolean;
}

/**
 * Every move this tour makes, as transitions the app already performs.
 *
 * The two modal openers reuse the app's own dispatch and binding-dialog state; nothing here
 * clicks a control or writes. Opening the Bind workflow dialog stages no binding - only its
 * own buttons do, and the tour never presses them.
 */
export interface WorkflowsTourNavigation {
  showRuns: () => boolean;
  showDispatchModal: () => boolean;
  closeDispatch: () => void;
  /** Open the fleet on the pinned session's detail, where the binding chip lives. */
  showBindingChip: (sessionId: string | null) => boolean;
  /** Open the Bind workflow dialog over that session, read-only. Null is a quiet no-op. */
  openBindingDialog: (sessionId: string | null) => boolean;
  closeBindingDialog: () => void;
  showRun: (runId: string, pane: "worklist" | "evidence" | "completion") => boolean;
}

/**
 * The session stops 3 and 4 stand on: one already armed with a workflow when the fleet has
 * one, so the chip reads `⌘ <name> v<n>` rather than the bare offer, and otherwise the first
 * live session, whose unarmed `＋ workflow` chip is the same control before a binding exists.
 */
export function selectWorkflowsTourSession(
  sessionIds: readonly string[],
  boundSessionIds: ReadonlySet<string>,
): string | null {
  return sessionIds.find((id) => boundSessionIds.has(id)) ?? sessionIds[0] ?? null;
}

type Context = TourStepContext<WorkflowsTourRuntime, WorkflowsTourNavigation>;
type Step = TourStep<WorkflowsTourRuntime, WorkflowsTourNavigation>;

/** `documentElement.dataset` key the dispatch-modal skin reads; shared with See the work. */
const DISPATCH_FLAG = "mcTourDispatchSurface";

const seedingCopy =
  "Mission Control is seeding a demonstration No-Mistakes Review run so this stop has a "
  + "real record to read. It lands in a moment; Back and Exit remain available meanwhile.";

const seedFailedCopy = (error: string): string =>
  `The demonstration run could not be seeded: ${error}. Dispatch a Ship task, or press Run `
  + "No-Mistakes Review on a session's Ship it? card, and revisit this tour to read a real "
  + "run here. Back, Next, and Exit remain available.";

/** What every run-anchored stop says while it has no run to stand on. */
const noRunCopy = (context: Context): string =>
  context.runtime.seedError ? seedFailedCopy(context.runtime.seedError) : seedingCopy;

const sessionLaunchingCopy =
  "Mission Control is starting a temporary conversation so this stop has a session desk to "
  + "point at. It joins the fleet in a moment; Back and Exit remain available meanwhile.";

const sessionFailedCopy = (error: string): string =>
  `The temporary tour conversation could not start: ${error}. Dispatch any task and revisit `
  + "this stop. Back, Next, and Exit remain available.";

/** What the two binding stops say while they have no session to stand on. */
const noSessionCopy = (context: Context): string =>
  context.runtime.sessionError
    ? sessionFailedCopy(context.runtime.sessionError)
    : sessionLaunchingCopy;

/** A live element inside the registered run strip, or null when the run cannot supply it. */
const stripPart = (
  context: Context,
  pick: (strip: HTMLElement) => Element | null | undefined,
): HTMLElement | null => {
  if (!context.runtime.run) return null;
  const strip = context.registry.get("workflows:run-pipeline");
  if (!strip) return null;
  const part = pick(strip);
  return part instanceof HTMLElement ? part : null;
};

/**
 * A stop standing on the pinned run's page.
 *
 * The shared clauses come first so a stop can override any of them; `prepare` opens the run
 * on the pane the stop reads, and with no run at all the Runs page itself is the surface the
 * fallback copy describes.
 */
const runStop = (pane: "worklist" | "evidence" | "completion", step: Step): Step => ({
  ready: (context) => context.runtime.run !== null && context.element !== null,
  attainable: (context) => context.runtime.run !== null,
  fallback: (context) => (context.runtime.run
    ? "The run is opening. Back, Next, and Exit remain available."
    : noRunCopy(context)),
  reconcile: restage,
  ...step,
  prepare: (context) => (context.runtime.run
    ? context.navigation.showRun(context.runtime.run.id, pane)
    : context.navigation.showRuns()),
});

const STEPS: readonly Step[] = [
  {
    id: "workflows",
    ...tourStageContent("workflows", "workflows"),
    targets: [],
    centered: true,
    prepare: (context) => context.navigation.showRuns(),
    nextLabel: () => "Open Dispatch",
    reconcile: refresh,
  },
  {
    id: "after-work",
    ...tourStageContent("workflows", "after-work"),
    targets: [{ target: "workflows:dispatch-after-work" }],
    prepare: (context) => context.navigation.showDispatchModal(),
    appSurface: () => "workflows:dispatch-modal",
    modalOwnsScreen: (context) => context.runtime.dispatchOpen,
    documentFlags: (context) =>
      context.registry.get("workflows:dispatch-modal") ? [DISPATCH_FLAG] : [],
    ready: (context) => context.runtime.dispatchOpen && context.element !== null,
    fallback: () =>
      "The real Dispatch modal is opening. Back and Exit remain available if its After work "
      + "field cannot mount.",
    nextLabel: () => "Open a session",
    onBack: (context) => context.navigation.closeDispatch(),
    reconcile: (context) => (context.runtime.dispatchOpen ? refresh() : goTo("workflows")),
  },
  {
    id: "binding",
    ...tourStageContent("workflows", "binding"),
    targets: [{
      target: "workflows:binding-chip",
      side: "bottom",
      resolve: (context) =>
        context.runtime.sessionId && context.runtime.sessionLive
          ? context.registry.get("workflows:binding-chip")
          : null,
    }],
    prepare: (context) => context.navigation.showBindingChip(
      context.runtime.sessionLive ? context.runtime.sessionId : null,
    ),
    ready: (context) =>
      context.runtime.sessionId !== null
      && context.runtime.sessionLive
      && context.element !== null,
    attainable: (context) => context.runtime.sessionId !== null && context.runtime.sessionLive,
    fallback: (context) =>
      context.runtime.sessionId && context.runtime.sessionLive
        ? "The session's chip is still mounting - or a review is already running on its "
          + "work, which withdraws the offer until it settles. Back, Next, and Exit remain "
          + "available."
        : noSessionCopy(context),
    nextLabel: () => "Open Bind workflow",
    // Restage rather than refresh: the temporary conversation joins the fleet AFTER this
    // stop opens, and only a re-run of `prepare` selects its desk. A session that is gone
    // instead re-prepares with null, which walks safely back to the fleet.
    reconcile: restage,
  },
  {
    id: "bind-dialog",
    ...tourStageContent("workflows", "bind-dialog"),
    targets: [{
      target: "workflows:bind-dialog",
      resolve: (context) =>
        context.runtime.bindingDialogOpen
          ? context.registry.get("workflows:bind-dialog")
          : null,
    }],
    prepare: (context) => context.navigation.openBindingDialog(
      context.runtime.sessionLive ? context.runtime.sessionId : null,
    ),
    appSurface: () => "workflows:bind-dialog",
    modalOwnsScreen: (context) => context.runtime.bindingDialogOpen,
    ready: (context) => context.runtime.bindingDialogOpen && context.element !== null,
    attainable: (context) => context.runtime.sessionId !== null && context.runtime.sessionLive,
    fallback: (context) =>
      context.runtime.sessionId && context.runtime.sessionLive
        ? "The Bind workflow dialog is opening. Back and Exit remain available if it cannot "
          + "mount."
        : noSessionCopy(context),
    nextLabel: () => "Open a run",
    onBack: (context) => context.navigation.closeBindingDialog(),
    reconcile: (context) => (context.runtime.bindingDialogOpen ? refresh() : goTo("binding")),
  },
  runStop("worklist", {
    id: "pipeline",
    ...tourStageContent("workflows", "pipeline"),
    targets: [{
      target: "workflows:run-pipeline",
      side: "bottom",
      resolve: (context) =>
        context.runtime.run ? context.registry.get("workflows:run-pipeline") : null,
    }],
  }),
  runStop("evidence", {
    id: "evidence",
    ...tourStageContent("workflows", "evidence"),
    targets: [{
      target: "workflows:run-evidence",
      side: "top",
      resolve: (context) =>
        context.runtime.run ? context.registry.get("workflows:run-evidence") : null,
    }],
  }),
  runStop("evidence", {
    id: "readiness",
    ...tourStageContent("workflows", "readiness"),
    targets: [{
      target: "workflows:run-readiness",
      side: "bottom",
      resolve: (context) =>
        context.runtime.run ? context.registry.get("workflows:run-readiness") : null,
    }],
  }),
  runStop("worklist", {
    id: "commands",
    ...tourStageContent("workflows", "commands"),
    // Stage 1 of the strip, resolved inside the registered strip rather than owning a
    // target: the slot list is the run's own, and the first slot is the command gate in
    // every published No-Mistakes version.
    targets: [{
      target: "workflows:run-pipeline",
      side: "bottom",
      resolve: (context) => stripPart(context, (strip) =>
        strip.querySelector(".wf-pipeline-slot")),
    }],
  }),
  runStop("worklist", {
    id: "judges",
    ...tourStageContent("workflows", "judges"),
    targets: [{
      target: "workflows:run-pipeline",
      side: "bottom",
      resolve: (context) => stripPart(context, (strip) =>
        strip.querySelectorAll(".wf-pipeline-slot")[1]),
    }],
  }),
  runStop("worklist", {
    id: "rounds",
    ...tourStageContent("workflows", "rounds"),
    targets: [{
      target: "workflows:run-rounds",
      side: "bottom",
      resolve: (context) =>
        context.runtime.run ? context.registry.get("workflows:run-rounds") : null,
    }],
  }),
  runStop("worklist", {
    id: "pull-request",
    ...tourStageContent("workflows", "pull-request"),
    // The stage holding a session action member, wherever the version placed it, so an
    // older run whose action sits at a different index still spotlights the right stage.
    targets: [{
      target: "workflows:run-pipeline",
      side: "top",
      resolve: (context) => stripPart(context, (strip) =>
        [...strip.querySelectorAll(".wf-pipeline-slot")]
          .find((slot) => slot.querySelector(".is-session_action"))),
    }],
    nextLabel: () => "Open the final gate",
  }),
  runStop("completion", {
    id: "inspector",
    ...tourStageContent("workflows", "inspector"),
    // Two beats of one gate: the fixed footer the strip draws after End, then the
    // Completion pane where its findings and controls live.
    targets: [
      {
        target: "workflows:run-pipeline",
        side: "top",
        resolve: (context) => stripPart(context, (strip) =>
          strip.querySelector(".wf-pipeline-inspector")),
      },
      {
        target: "workflows:run-completion",
        side: "top",
        resolve: (context) =>
          context.runtime.run ? context.registry.get("workflows:run-completion") : null,
      },
    ],
    fallback: (context) => (context.runtime.run
      ? "This run holds no GitHub Inspector record to read - it never reached the gate, or "
        + "its version finishes without one. When a run gets there, the gate stands in the "
        + "strip's fixed footer after End, and its findings land on the Completion tab. "
        + "Back, Next, and Exit remain available."
      : noRunCopy(context)),
  }),
  {
    id: "close",
    ...tourStageContent("workflows", "close"),
    targets: [{ target: "workflows:run-filters", side: "bottom" }],
    ready: (context) => context.element !== null,
    fallback: (context) =>
      context.runtime.seedError
        ? seedFailedCopy(context.runtime.seedError)
        : "The Runs rail is still empty while the demonstration run lands. Once it does, "
          + "these chips sort every run by who owes what. Back and Exit remain available.",
    nextLabel: () => "Finish tour",
    reconcile: refresh,
  },
];

const CONTENT = assertTourContentStages("workflows", STEPS);

export const WORKFLOWS_TOUR: TourDefinition<WorkflowsTourRuntime, WorkflowsTourNavigation> =
  assertTourDefinition({
    id: "workflows",
    title: CONTENT.title,
    steps: STEPS,
    documentFlags: [DISPATCH_FLAG],
    stopping: {
      title: "Closing the tour…",
      description: "Leaving you on the Runs page.",
    },
    runtimeKey: (runtime) => [
      runtime.run?.id ?? null,
      runtime.seedError,
      runtime.sessionId,
      runtime.sessionLive,
      runtime.sessionError,
      runtime.dispatchOpen,
      runtime.bindingDialogOpen,
    ].join(" "),
  });
