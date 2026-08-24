import {
  assertTourDefinition,
  goTo,
  hold,
  refresh,
  restage,
  type TourDefinition,
  type TourStep,
  type TourStepContext,
} from "../contracts.ts";
import { assertTourContentStages, tourStageContent } from "../content.ts";

export type SeeWorkDemoPhase =
  | "not-started"
  | "launching"
  | "working"
  | "needs-you"
  | "idle"
  | "failed";

export interface SeeWorkTourRuntime {
  previewSessionId: string | null;
  previewPhase: "launching" | "ready" | "failed";
  previewError: string | null;
  taskId: string | null;
  sessionId: string | null;
  phase: SeeWorkDemoPhase;
  dispatchOpen: boolean;
  dispatchBriefReady: boolean;
  dispatchRepoReady: boolean;
  completeOpen: boolean;
  reviewPending: boolean;
  reviewOpen: boolean;
  error: string | null;
}

export interface SeeWorkTourNavigation {
  showLine: () => boolean;
  showBoard: () => boolean;
  showSessionDetail: () => boolean;
  showDispatch: () => boolean;
  showDispatchModal: () => boolean;
  closeDispatch: () => void;
  writeDemoBrief: () => void;
  showDemoBoard: () => boolean;
  showReview: () => boolean;
  closeReview: () => void;
  showDemoDetail: () => boolean;
  showComplete: () => boolean;
  closeComplete: () => void;
}

type Context = TourStepContext<SeeWorkTourRuntime, SeeWorkTourNavigation>;
type Step = TourStep<SeeWorkTourRuntime, SeeWorkTourNavigation>;

/** `documentElement.dataset` keys the See-work skin reads. */
const REVIEW_FLAG = "mcTourReview";
const DISPATCH_FLAG = "mcTourDispatchSurface";
const SESSION_TILE_FLAG = "mcTourSessionTile";

const dispatchFlags = (context: Context): readonly string[] =>
  context.registry.get("see-work:dispatch-modal") ? [DISPATCH_FLAG] : [];

/** Every Dispatch-modal stop reconciles the same way: the modal closing sends the tour back. */
const dispatchModalStop = (step: Step): Step => ({
  gateNext: true,
  reconcile: (context) => (context.runtime.dispatchOpen ? refresh() : goTo("dispatch")),
  ...step,
  prepare: (context) => context.navigation.showDispatchModal(),
  appSurface: () => "see-work:dispatch-modal",
  modalOwnsScreen: (context) => context.runtime.dispatchOpen,
  documentFlags: dispatchFlags,
});

/** A Board stop that spotlights the demo task's own tile. */
const demoTileStop = (step: Step): Step => ({
  gateNext: true,
  ...step,
  prepare: (context) => context.navigation.showDemoBoard(),
  documentFlags: () => [SESSION_TILE_FLAG],
});

const STEPS: readonly Step[] = [
  {
    id: "line",
    ...tourStageContent("see-work", "line"),
    targets: [{ target: "see-work:line", side: "bottom" }],
    prepare: (context) => context.navigation.showLine(),
    // The opening stops are ordinary chrome that is already on screen. Runtime landing
    // between a click and Driver committing its next screen would race the click back.
    reconcile: hold,
  },
  {
    id: "board",
    ...tourStageContent("see-work", "board"),
    targets: [{ target: "see-work:board" }],
    prepare: (context) => context.navigation.showBoard(),
    reconcile: hold,
  },
  {
    id: "session-detail",
    ...tourStageContent("see-work", "session-detail"),
    targets: [{ target: "see-work:session-detail" }],
    gateNext: true,
    prepare: (context) => context.navigation.showSessionDetail(),
    ready: (context) =>
      context.runtime.previewPhase === "failed" ||
      (context.runtime.previewSessionId !== null && context.element !== null),
    fallback: (context) =>
      context.runtime.previewPhase === "failed"
        ? `The tour conversation could not start: ${context.runtime.previewError ?? "unknown launch error"}. Back, Next, and Exit remain available.`
        : "Mission Control is starting a temporary Chat conversation so this stop can open a real session desk. Back and Exit remain available while it mounts.",
    // The preview session arrives after this stop opens, so re-run the navigation that picks
    // it rather than only re-rendering the popover against a stale selection.
    reconcile: restage,
  },
  {
    id: "dispatch",
    ...tourStageContent("see-work", "dispatch"),
    targets: [{ target: "see-work:dispatch" }],
    prepare: (context) => context.navigation.showDispatch(),
    nextLabel: () => "Open Dispatch",
    reconcile: hold,
  },
  dispatchModalStop({
    id: "dispatch-kind",
    ...tourStageContent("see-work", "dispatch-kind"),
    targets: [{ target: "see-work:dispatch-kind" }],
    ready: (context) => context.runtime.dispatchOpen && context.element !== null,
    fallback: () =>
      "The real Dispatch modal is opening. Back and Exit remain available if its Kind selector cannot mount.",
    nextLabel: () => "Write the brief",
    // Writing the brief is this stop's whole action, so it runs ahead of the readiness gate
    // that the next stop applies to the input it fills.
    onNext: (context) => {
      context.navigation.writeDemoBrief();
      return goTo("dispatch-input");
    },
    onBack: (context) => context.navigation.closeDispatch(),
  }),
  dispatchModalStop({
    id: "dispatch-input",
    ...tourStageContent("see-work", "dispatch-input"),
    targets: [{ target: "see-work:dispatch-input" }],
    ready: (context) =>
      context.runtime.dispatchOpen &&
      context.runtime.dispatchBriefReady &&
      context.element !== null,
    fallback: (context) =>
      context.runtime.dispatchBriefReady
        ? "The real Dispatch task input is still mounting. Back and Exit remain available."
        : "The temporary brief is being written into Dispatch. Back and Exit remain available.",
    nextLabel: () => "Choose after work",
  }),
  dispatchModalStop({
    id: "dispatch-workflow",
    ...tourStageContent("see-work", "dispatch-workflow"),
    targets: [{ target: "see-work:dispatch-workflow" }],
    ready: (context) =>
      context.runtime.dispatchOpen &&
      context.runtime.dispatchBriefReady &&
      context.element !== null,
    fallback: () =>
      "The real after-work Workflow selector is still mounting. Back and Exit remain available.",
    nextLabel: () => "Review dispatch",
  }),
  dispatchModalStop({
    id: "dispatch-submit",
    ...tourStageContent("see-work", "dispatch-submit"),
    targets: [{ target: "see-work:dispatch-submit", side: "left" }],
    interactive: true,
    ready: (context) => {
      const submit = context.registry.get("see-work:dispatch-submit");
      return context.runtime.dispatchOpen &&
        context.runtime.dispatchRepoReady &&
        context.runtime.dispatchBriefReady &&
        submit !== null &&
        !submit.hasAttribute("disabled");
    },
    fallback: (context) =>
      context.runtime.dispatchRepoReady
        ? "The real Dispatch action is still becoming ready. Back and Exit remain available."
        : "No git repository is available for the demo task. Back and Exit remain available.",
    // The real modal button owns submission at this stop. There is deliberately no
    // coachmark Next path around it.
    hideNext: () => true,
    onNext: hold,
    focusTarget: (context) => context.registry.get("see-work:dispatch-submit"),
    reconcile: (context) => {
      if (context.runtime.taskId) {
        context.navigation.closeDispatch();
        return goTo("working");
      }
      return context.runtime.dispatchOpen ? refresh() : goTo("dispatch");
    },
  }),
  demoTileStop({
    id: "working",
    ...tourStageContent("see-work", "working"),
    targets: [{ target: "see-work:demo-task" }],
    ready: (context) => context.runtime.sessionId !== null && context.element !== null,
    fallback: () =>
      "Mission Control is scheduling the Terra task and waiting for its session to join the Board. You can still go Back or Exit the tour.",
  }),
  demoTileStop({
    id: "needs-you",
    ...tourStageContent("see-work", "needs-you"),
    targets: [{ target: "see-work:demo-task" }],
    ready: (context) => context.runtime.reviewPending && context.element !== null,
    fallback: (context) =>
      context.runtime.phase === "idle"
        ? "The session became Idle without opening its review request. Exit the tour and start it again; Back and Exit remain available."
        : "The task is working. The tour is waiting for its review request, then it will spotlight the same tile under Needs You.",
    nextLabel: () => "Open review",
  }),
  {
    id: "review",
    ...tourStageContent("see-work", "review"),
    targets: [{
      target: "see-work:review-modal",
      // Before the operator opens the review, the popover is a centered card that offers to
      // open it. Spotlighting a modal that is not on screen would point at nothing.
      resolve: (context) =>
        context.runtime.reviewOpen ? context.registry.get("see-work:review-modal") : null,
    }],
    gateNext: true,
    interactive: true,
    prepare: (context) => context.navigation.showReview(),
    ready: (context) => context.runtime.reviewPending,
    fallback: (context) =>
      context.runtime.reviewPending
        ? "The review is ready. Open it to choose an option and submit."
        : "Your answer was submitted. The tour is waiting for the session to settle under Idle.",
    nextLabel: (context) => (context.runtime.reviewOpen ? undefined : "Open review"),
    hideNext: (context) => context.runtime.reviewOpen,
    onNext: (context) => {
      if (context.runtime.reviewOpen) return null;
      context.navigation.showReview();
      return refresh();
    },
    onBack: (context) => context.navigation.closeReview(),
    appSurface: () => "see-work:review-modal",
    modalOwnsScreen: (context) => context.runtime.reviewOpen,
    documentFlags: (context) =>
      context.registry.get("see-work:review-modal") ? [REVIEW_FLAG] : [],
    // `showReview` sets the review flag itself when it finds the demo session, so the engine
    // must not clear it here just because the modal has not mounted yet.
    retainDocumentFlags: () => [REVIEW_FLAG],
    focusTarget: (context) => {
      const surface = context.registry.get("see-work:review-modal");
      if (!surface?.isConnected) return null;
      return surface.querySelector<HTMLElement>("input:not([disabled])")
        ?? surface.querySelector<HTMLElement>("button:not([disabled])");
    },
    reconcile: (context) => {
      if (context.runtime.phase === "idle") {
        context.navigation.closeReview();
        return goTo("idle");
      }
      return refresh();
    },
  },
  demoTileStop({
    id: "idle",
    ...tourStageContent("see-work", "idle"),
    targets: [{ target: "see-work:demo-task" }],
    ready: (context) => context.runtime.phase === "idle" && context.element !== null,
    fallback: () =>
      "The answer has returned. Mission Control is waiting for the session’s idle lifecycle reading before moving on.",
    nextLabel: () => "Show actions",
  }),
  {
    id: "actions",
    ...tourStageContent("see-work", "actions"),
    targets: [{ target: "see-work:session-actions" }],
    gateNext: true,
    prepare: (context) => context.navigation.showDemoDetail(),
    ready: (context) => context.runtime.sessionId !== null && context.element !== null,
    fallback: () =>
      "Opening the demo session’s desk so the existing completion and retrospective actions can be highlighted.",
    nextLabel: () => "Open Complete",
  },
  {
    id: "complete",
    ...tourStageContent("see-work", "complete"),
    targets: [{ target: "see-work:complete-modal" }],
    gateNext: true,
    prepare: (context) => context.navigation.showComplete(),
    ready: (context) => context.runtime.completeOpen && context.element !== null,
    fallback: () =>
      "The Complete dialog is opening. Back and Exit remain available if it cannot mount.",
    nextLabel: () => "Complete tour",
    onBack: (context) => context.navigation.closeComplete(),
    appSurface: () => "see-work:complete-modal",
    modalOwnsScreen: (context) => context.runtime.completeOpen,
    reconcile: (context) =>
      context.runtime.completeOpen ? refresh() : goTo("actions"),
  },
];

const CONTENT = assertTourContentStages("see-work", STEPS);

export const SEE_WORK_TOUR: TourDefinition<SeeWorkTourRuntime, SeeWorkTourNavigation> =
  assertTourDefinition({
    id: "see-work",
    title: CONTENT.title,
    steps: STEPS,
    documentFlags: [REVIEW_FLAG, DISPATCH_FLAG, SESSION_TILE_FLAG],
    stopping: {
      title: "Completing the demo…",
      description:
        "Recording “Tour demo”, closing the demo session, and restoring where you started.",
    },
    // A failed demo task outranks any single stop's own waiting copy: there is nothing left
    // to wait for, and the operator needs the launch error rather than a progress note.
    fallback: (context) =>
      context.runtime.phase === "failed"
        ? `The demo task could not continue: ${context.runtime.error ?? "unknown launch error"}. Back and Exit remain available.`
        : null,
    runtimeKey: (runtime) => [
      runtime.previewSessionId,
      runtime.previewPhase,
      runtime.previewError,
      runtime.taskId,
      runtime.sessionId,
      runtime.phase,
      runtime.dispatchOpen,
      runtime.dispatchBriefReady,
      runtime.dispatchRepoReady,
      runtime.completeOpen,
      runtime.reviewPending,
      runtime.reviewOpen,
      runtime.error,
    ].join(" "),
  });
