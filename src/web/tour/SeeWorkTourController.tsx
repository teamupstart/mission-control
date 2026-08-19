import { useEffect, useLayoutEffect, useRef } from "react";
import { driver, type Driver, type PopoverDOM } from "driver.js";
import "driver.js/dist/driver.css";

import { containTourTab } from "./focus-containment.ts";
import type { TourTargetId, TourTargetRegistry } from "./target-registry.ts";

const TARGET_WAIT_MS = 2_000;

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

interface TourStep {
  target: TourTargetId;
  title: string;
  description: string;
  side?: "top" | "bottom";
  details?: readonly { label: string; description: string }[];
}

const STEP_INDEX = {
  line: 0,
  board: 1,
  sessionDetail: 2,
  dispatch: 3,
  dispatchKind: 4,
  dispatchInput: 5,
  dispatchWorkflow: 6,
  dispatchSubmit: 7,
  working: 8,
  needsYou: 9,
  review: 10,
  idle: 11,
  actions: 12,
  complete: 13,
} as const;

const STEPS: readonly TourStep[] = [
  {
    target: "line",
    title: "Fleet and the Line",
    description:
      "The Line summarizes the whole work pipeline: intake → backlog → working → review → decide → shipped. Amber means there is something you can move.",
    side: "bottom",
  },
  {
    target: "board",
    title: "Board View",
    description:
      "The Board places backlog beside session-state columns. Column height shows the fleet’s shape, and opening a tile reveals that session’s operating detail.",
  },
  {
    target: "session-detail",
    title: "Session detail",
    description:
      "Conversation, Work queue, Workflows, Diff, and Files make one session’s desk: talk, queued work, checks, changes, and the working tree in one place.",
  },
  {
    target: "dispatch",
    title: "Open Dispatch",
    description:
      "Dispatch turns an intent into a live session. Next opens the real form so you can see the work contract before anything is scheduled.",
  },
  {
    target: "dispatch-kind",
    title: "Choose the kind",
    description:
      "Kind sets the outcome you expect from the agent. The tour’s fixed demo uses Ship.",
    details: [
      { label: "Chat", description: "Have an open-ended conversation without a planned artifact." },
      { label: "Scout", description: "Investigate and report findings without producing a diff." },
      { label: "Plan", description: "Produce a reviewed plan and optionally schedule the work." },
      { label: "Ship", description: "Deliver a reviewable change with a completion path." },
    ],
  },
  {
    target: "dispatch-input",
    title: "Brief ready",
    description:
      "The tour filled the real task input with its read-only demo brief. Repo and Crew show the full launch contract: Ship on Codex with GPT-5.6 Terra. Your own saved Dispatch draft remains untouched underneath this temporary one.",
  },
  {
    target: "dispatch-workflow",
    title: "Choose what follows",
    description:
      "Workflows run reusable review and follow-up steps after an agent finishes. None leaves the session with you instead. This demo selects None because its Needs You request comes directly from the task.",
  },
  {
    target: "dispatch-submit",
    title: "Dispatch the task",
    description:
      "The launch contract is ready. Click Dispatch now in the modal to schedule the Terra task. The rest of the form stays visible so you can review it before the task leaves.",
  },
  {
    target: "demo-task",
    title: "Working",
    description:
      "The scheduled task appears under Working while Terra starts its turn. Its tile is the live summary; opening it returns to the same session desk you just saw.",
  },
  {
    target: "demo-task",
    title: "Needs You",
    description:
      "When the task asks through Mission Control’s review channel, its same tile moves to Needs You. The state change is the prompt to review, not a separate notification workflow.",
  },
  {
    target: "review-modal",
    title: "Choose and submit",
    description:
      "Pick one option in the real review dialog and submit it. The tour pauses here; your answer unblocks the session and no choice is made for you.",
  },
  {
    target: "demo-task",
    title: "Idle",
    description:
      "After the answer returns, the task settles under Idle. The session is still available for another instruction, but this demo deliberately sends none.",
  },
  {
    target: "session-actions",
    title: "Complete or run a retro",
    description:
      "Complete records an outcome and closes the session. A retro keeps the task open while the session proposes memories for you to review. Next opens the real completion dialog; this tour will not run a retro.",
  },
  {
    target: "complete-modal",
    title: "Complete the tour",
    description:
      "The real Complete dialog records an optional outcome before closing the session. “Tour demo” is prefilled as a generic note. Run a retro first would keep the work open; Complete & close would finish it. The guide’s Complete tour button performs that fixed completion safely.",
  },
] as const;

function targetReady(index: number, runtime: SeeWorkTourRuntime, registry: TourTargetRegistry): boolean {
  switch (index) {
    case STEP_INDEX.sessionDetail:
      return runtime.previewPhase === "failed" || (
        runtime.previewSessionId !== null && registry.get("session-detail") !== null
      );
    case STEP_INDEX.dispatchKind:
      return runtime.dispatchOpen && registry.get("dispatch-kind") !== null;
    case STEP_INDEX.dispatchInput:
      return runtime.dispatchOpen
        && runtime.dispatchBriefReady
        && registry.get("dispatch-input") !== null;
    case STEP_INDEX.dispatchWorkflow:
      return runtime.dispatchOpen
        && runtime.dispatchBriefReady
        && registry.get("dispatch-workflow") !== null;
    case STEP_INDEX.dispatchSubmit: {
      const submit = registry.get("dispatch-submit");
      return runtime.dispatchOpen
        && runtime.dispatchRepoReady
        && runtime.dispatchBriefReady
        && submit !== null
        && !submit.hasAttribute("disabled");
    }
    case STEP_INDEX.working:
      return runtime.sessionId !== null && registry.get("demo-task") !== null;
    case STEP_INDEX.needsYou:
      return runtime.reviewPending && registry.get("demo-task") !== null;
    case STEP_INDEX.review:
      return runtime.reviewPending;
    case STEP_INDEX.idle:
      return runtime.phase === "idle" && registry.get("demo-task") !== null;
    case STEP_INDEX.actions:
      return runtime.sessionId !== null && registry.get("session-actions") !== null;
    case STEP_INDEX.complete:
      return runtime.completeOpen && registry.get("complete-modal") !== null;
    default:
      return registry.get(STEPS[index]?.target ?? "line") !== null || index === STEP_INDEX.sessionDetail;
  }
}

function fallbackDescription(index: number, runtime: SeeWorkTourRuntime): string | null {
  if (runtime.phase === "failed") {
    return `The demo task could not continue: ${runtime.error ?? "unknown launch error"}. Back and Exit remain available.`;
  }
  switch (index) {
    case STEP_INDEX.sessionDetail:
      return runtime.previewPhase === "failed"
        ? `The tour conversation could not start: ${runtime.previewError ?? "unknown launch error"}. Back, Next, and Exit remain available.`
        : "Mission Control is starting a temporary Chat conversation so this stop can open a real session desk. Back and Exit remain available while it mounts.";
    case STEP_INDEX.dispatchKind:
      return "The real Dispatch modal is opening. Back and Exit remain available if its Kind selector cannot mount.";
    case STEP_INDEX.dispatchInput:
      return runtime.dispatchBriefReady
        ? "The real Dispatch task input is still mounting. Back and Exit remain available."
        : "The temporary brief is being written into Dispatch. Back and Exit remain available.";
    case STEP_INDEX.dispatchWorkflow:
      return "The real after-work Workflow selector is still mounting. Back and Exit remain available.";
    case STEP_INDEX.dispatchSubmit:
      return runtime.dispatchRepoReady
        ? "The real Dispatch action is still becoming ready. Back and Exit remain available."
        : "No git repository is available for the demo task. Back and Exit remain available.";
    case STEP_INDEX.working:
      return "Mission Control is scheduling the Terra task and waiting for its session to join the Board. You can still go Back or Exit the tour.";
    case STEP_INDEX.needsYou:
      return runtime.phase === "idle"
        ? "The session became Idle without opening its review request. Exit the tour and start it again; Back and Exit remain available."
        : "The task is working. The tour is waiting for its review request, then it will spotlight the same tile under Needs You.";
    case STEP_INDEX.review:
      return runtime.reviewPending
        ? "The review is ready. Open it to choose an option and submit."
        : "Your answer was submitted. The tour is waiting for the session to settle under Idle.";
    case STEP_INDEX.idle:
      return "The answer has returned. Mission Control is waiting for the session’s idle lifecycle reading before moving on.";
    case STEP_INDEX.actions:
      return "Opening the demo session’s desk so the existing completion and retrospective actions can be highlighted.";
    case STEP_INDEX.complete:
      return "The Complete dialog is opening. Back and Exit remain available if it cannot mount.";
    default:
      return null;
  }
}

function renderDescription(
  element: HTMLElement,
  step: TourStep,
  fallback: string | null,
): void {
  if (fallback) {
    const message = document.createElement("p");
    message.className = "mc-tour-fallback";
    message.setAttribute("role", "status");
    message.textContent = fallback;
    element.replaceChildren(message);
    return;
  }
  if (!step.details?.length) {
    element.textContent = step.description;
    return;
  }

  const intro = document.createElement("p");
  intro.className = "mc-tour-copy";
  intro.textContent = step.description;
  const list = document.createElement("dl");
  list.className = "mc-tour-kind-list";
  for (const detail of step.details) {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = detail.label;
    description.textContent = detail.description;
    row.append(term, description);
    list.append(row);
  }
  element.replaceChildren(intro, list);
}

function renderProgressHeader(popover: PopoverDOM, index: number): void {
  let header = popover.wrapper.querySelector<HTMLElement>(".mc-tour-head");
  let rail = popover.wrapper.querySelector<HTMLElement>(".mc-tour-progress-rail");
  if (!header || !rail) {
    header = document.createElement("header");
    header.className = "mc-tour-head";
    const identity = document.createElement("div");
    identity.className = "mc-tour-identity";
    const kicker = document.createElement("span");
    kicker.className = "mc-tour-kicker";
    kicker.textContent = "See the work";
    rail = document.createElement("div");
    rail.className = "mc-tour-progress-rail";
    rail.setAttribute("role", "progressbar");
    rail.setAttribute("aria-label", "See the work tour progress");
    rail.setAttribute("aria-valuemin", "1");
    rail.setAttribute("aria-valuemax", String(STEPS.length));
    identity.append(kicker, popover.progress);
    header.append(identity, rail);
    popover.wrapper.insertBefore(header, popover.title);
  }

  rail.setAttribute("aria-valuenow", String(index + 1));
  rail.setAttribute("aria-valuetext", `Step ${index + 1} of ${STEPS.length}`);
  rail.replaceChildren(...STEPS.map((_, item) => {
    const segment = document.createElement("span");
    segment.setAttribute("aria-hidden", "true");
    if (item === index) segment.className = "is-current";
    else if (item < index) segment.className = "is-past";
    return segment;
  }));
}

export function SeeWorkTourController({
  registry,
  navigation,
  runtime,
  isTop,
  onFinish,
}: {
  registry: TourTargetRegistry;
  navigation: SeeWorkTourNavigation;
  runtime: SeeWorkTourRuntime;
  isTop: boolean;
  onFinish: () => Promise<void>;
}): null {
  const driverRef = useRef<Driver | null>(null);
  const popoverRef = useRef<PopoverDOM | null>(null);
  const focusRootsRef = useRef<readonly HTMLElement[]>([]);
  const runtimeRef = useRef(runtime);
  const isTopRef = useRef(isTop);
  const actionsRef = useRef<{ refresh: () => void } | null>(null);

  useLayoutEffect(() => {
    runtimeRef.current = runtime;
    isTopRef.current = isTop;
  }, [isTop, runtime]);

  useEffect(() => {
    let disposed = false;
    let stopping = false;
    // Driver's active index updates after a route/target transition commits. React state can
    // arrive inside that window, so keep the controller's requested step as the progression
    // authority instead of letting a refresh jump back to Driver's previous index.
    let intendedIndex = 0;

    function report(error: unknown): void {
      console.error("See the work tour failed", error);
      void stop();
    }

    function showStopping(): void {
      const popover = popoverRef.current;
      if (!popover) return;
      popover.title.textContent = "Completing the demo…";
      popover.description.textContent = "Recording “Tour demo”, closing the demo session, and restoring where you started.";
      for (const button of [popover.previousButton, popover.nextButton]) button.hidden = true;
      const exit = popover.footerButtons.querySelector<HTMLButtonElement>(".mc-tour-exit");
      if (exit) {
        exit.disabled = true;
        exit.textContent = "Finishing…";
      }
    }

    async function stop(): Promise<void> {
      if (disposed || stopping) return;
      stopping = true;
      showStopping();
      try {
        await onFinish();
      } catch (error) {
        console.error("See the work tour cleanup failed", error);
      }
      if (!disposed) {
        try {
          if (driverRef.current?.isActive()) driverRef.current.destroy();
        } catch (error) {
          console.error("See the work tour Driver cleanup failed", error);
        }
      }
    }

    function prepare(index: number): boolean {
      switch (index) {
        case STEP_INDEX.line: return navigation.showLine();
        case STEP_INDEX.board: return navigation.showBoard();
        case STEP_INDEX.sessionDetail: return navigation.showSessionDetail();
        case STEP_INDEX.dispatch: return navigation.showDispatch();
        case STEP_INDEX.dispatchKind:
        case STEP_INDEX.dispatchInput:
        case STEP_INDEX.dispatchWorkflow:
        case STEP_INDEX.dispatchSubmit: return navigation.showDispatchModal();
        case STEP_INDEX.working:
        case STEP_INDEX.needsYou:
        case STEP_INDEX.idle: return navigation.showDemoBoard();
        case STEP_INDEX.review: return navigation.showReview();
        case STEP_INDEX.actions: return navigation.showDemoDetail();
        case STEP_INDEX.complete: return navigation.showComplete();
        default: return false;
      }
    }

    function moveTo(index: number): void {
      try {
        if (!prepare(index)) {
          void stop();
          return;
        }
        intendedIndex = index;
        driverRef.current?.moveTo(index);
      } catch (error) {
        report(error);
      }
    }

    async function advance(): Promise<void> {
      const tour = driverRef.current;
      if (!tour || stopping) return;
      const index = intendedIndex;
      if (index === STEP_INDEX.dispatchKind) {
        navigation.writeDemoBrief();
        moveTo(STEP_INDEX.dispatchInput);
        return;
      }
      // The real modal button owns submission at this stop. There is deliberately no
      // coachmark Next path around it.
      if (index === STEP_INDEX.dispatchSubmit) return;
      if (index === STEP_INDEX.review && !runtimeRef.current.reviewOpen) {
        navigation.showReview();
        tour.moveTo(STEP_INDEX.review);
        return;
      }
      if (
        !targetReady(index, runtimeRef.current, registry) &&
        (index === STEP_INDEX.sessionDetail || index >= STEP_INDEX.dispatchKind)
      ) return;
      if (index >= STEPS.length - 1) {
        await stop();
        return;
      }
      moveTo(index + 1);
    }

    function retreat(): void {
      const tour = driverRef.current;
      if (!tour || stopping) return;
      const index = intendedIndex;
      if (index <= 0) return;
      if (index === STEP_INDEX.review) navigation.closeReview();
      if (index === STEP_INDEX.dispatchKind) navigation.closeDispatch();
      if (index === STEP_INDEX.complete) navigation.closeComplete();
      moveTo(index - 1);
    }

    function decoratePopover(
      popover: PopoverDOM,
      hook: { index: number | undefined },
    ): void {
      try {
        popoverRef.current = popover;
        // Driver calls this while committing the NEXT step, before getActiveIndex always
        // reflects it. Its hook index is the authoritative step for this render.
        const index = hook.index ?? driverRef.current?.getActiveIndex() ?? 0;
        intendedIndex = index;
        const step = STEPS[index] ?? STEPS[0]!;
        const current = runtimeRef.current;
        const targetPresent = registry.get(step.target) != null;
        const fallback = !targetPresent || !targetReady(index, current, registry)
          ? fallbackDescription(index, current)
          : null;
        renderProgressHeader(popover, index);
        renderDescription(popover.description, step, fallback);
        if (fallback) popover.wrapper.dataset.tourFallback = "true";
        else delete popover.wrapper.dataset.tourFallback;

        const reviewSurface = index === STEP_INDEX.review ? registry.get("review-modal") : null;
        const dispatchSurface = index >= STEP_INDEX.dispatchKind && index <= STEP_INDEX.dispatchSubmit
          ? registry.get("dispatch-modal")
          : null;
        const completeSurface = index === STEP_INDEX.complete
          ? registry.get("complete-modal")
          : null;
        const appDialogSurface = reviewSurface ?? dispatchSurface ?? completeSurface;
        if (dispatchSurface) {
          document.documentElement.dataset.mcTourDispatchSurface = "true";
        } else {
          delete document.documentElement.dataset.mcTourDispatchSurface;
        }
        if (step.target === "demo-task") {
          document.documentElement.dataset.mcTourSessionTile = "true";
        } else {
          delete document.documentElement.dataset.mcTourSessionTile;
        }
        if (appDialogSurface) {
          if (reviewSurface) document.documentElement.dataset.mcTourReview = "true";
          else delete document.documentElement.dataset.mcTourReview;
          popover.wrapper.setAttribute("role", "status");
          popover.wrapper.removeAttribute("aria-modal");
          focusRootsRef.current = [appDialogSurface, popover.wrapper];
        } else {
          if (index !== STEP_INDEX.review) delete document.documentElement.dataset.mcTourReview;
          popover.wrapper.setAttribute("role", "dialog");
          popover.wrapper.setAttribute("aria-modal", "true");
          focusRootsRef.current = [popover.wrapper];
        }
        popover.wrapper.tabIndex = -1;
        popover.progress.setAttribute("role", "status");
        popover.progress.setAttribute("aria-label", `Tour progress: ${popover.progress.textContent ?? ""}`);

        popover.closeButton.hidden = true;
        popover.closeButton.tabIndex = -1;
        popover.closeButton.setAttribute("aria-hidden", "true");
        popover.footerButtons.querySelector(".mc-tour-exit")?.remove();
        const exit = document.createElement("button");
        exit.type = "button";
        exit.className = "mc-tour-exit";
        exit.textContent = "Exit tour";
        exit.addEventListener("click", () => void stop());
        popover.footerButtons.prepend(exit);

        popover.previousButton.hidden = index === 0;
        popover.previousButton.disabled = false;
        popover.nextButton.hidden = index === STEP_INDEX.dispatchSubmit
          || (index === STEP_INDEX.review && current.reviewOpen);
        popover.nextButton.disabled =
          (index === STEP_INDEX.sessionDetail || index >= STEP_INDEX.dispatchKind) &&
          !targetReady(index, current, registry);
        popover.nextButton.textContent =
          index === STEP_INDEX.dispatch ? "Open Dispatch"
          : index === STEP_INDEX.dispatchKind ? "Write the brief"
          : index === STEP_INDEX.dispatchInput ? "Choose after work"
          : index === STEP_INDEX.dispatchWorkflow ? "Review dispatch"
          : index === STEP_INDEX.needsYou || (index === STEP_INDEX.review && !current.reviewOpen) ? "Open review"
          : index === STEP_INDEX.idle ? "Show actions"
          : index === STEP_INDEX.actions ? "Open Complete"
          : index === STEP_INDEX.complete ? "Complete tour"
          : "Next";

        const focusTour = (): void => {
          if (reviewSurface?.isConnected) {
            const choice = reviewSurface.querySelector<HTMLElement>("input:not([disabled])")
              ?? reviewSurface.querySelector<HTMLElement>("button:not([disabled])");
            choice?.focus();
          } else if (index === STEP_INDEX.dispatchSubmit) {
            registry.get("dispatch-submit")?.focus();
          } else if (!popover.nextButton.hidden && !popover.nextButton.disabled) {
            popover.nextButton.focus();
          } else {
            exit.focus();
          }
        };
        // Driver performs its own initial focus after onPopoverRender. The review surface is
        // the active UI at that stop, so place focus there on the next frame, after Driver's
        // pass, instead of racing it in the same microtask checkpoint.
        if (reviewSurface || index === STEP_INDEX.dispatchSubmit) requestAnimationFrame(focusTour);
        else queueMicrotask(focusTour);
      } catch (error) {
        report(error);
      }
    }

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let tour: Driver;
    try {
      tour = driver({
        animate: !reduceMotion,
        smoothScroll: !reduceMotion,
        allowScroll: false,
        allowClose: true,
        allowKeyboardControl: false,
        overlayClickBehavior: () => void stop(),
        overlayOpacity: 0.76,
        stagePadding: 8,
        stageRadius: 8,
        popoverClass: "mc-see-work-tour",
        showProgress: true,
        progressText: "Step {{current}} of {{total}}",
        showButtons: ["previous", "next"],
        prevBtnText: "Back",
        nextBtnText: "Next",
        doneBtnText: "Finish tour",
        onPopoverRender: decoratePopover,
        onNextClick: () => void advance(),
        onDoneClick: () => void advance(),
        onPrevClick: retreat,
        onDestroyed: () => {
          if (!disposed) void stop();
        },
        steps: STEPS.map((step, index) => ({
          element: (() => {
            if (index === STEP_INDEX.review && !runtimeRef.current.reviewOpen) return null;
            return registry.get(step.target);
          }) as () => Element,
          waitForElement: TARGET_WAIT_MS,
          skipMissingElement: false,
          disableActiveInteraction:
            index !== STEP_INDEX.review && index !== STEP_INDEX.dispatchSubmit,
          popover: {
            title: step.title,
            description: step.description,
            side: step.side ?? "top",
            align: "center",
          },
        })),
      });
    } catch (error) {
      report(error);
      return;
    }
    driverRef.current = tour;

    function onKeyDown(event: KeyboardEvent): void {
      const activeIndex = intendedIndex;
      const reviewOwnsScreen = activeIndex === STEP_INDEX.review && runtimeRef.current.reviewOpen;
      const dispatchOwnsScreen =
        activeIndex >= STEP_INDEX.dispatchKind
        && activeIndex <= STEP_INDEX.dispatchSubmit
        && runtimeRef.current.dispatchOpen;
      const completeOwnsScreen =
        activeIndex === STEP_INDEX.complete && runtimeRef.current.completeOpen;
      if (!isTopRef.current && !reviewOwnsScreen && !dispatchOwnsScreen && !completeOwnsScreen) return;
      if (event.key === "Escape") {
        // A registered app modal is the top layer at these stops. Let its existing Escape
        // handler peel only that modal; the next Escape reaches the tour underneath.
        if (reviewOwnsScreen || dispatchOwnsScreen || completeOwnsScreen) return;
        event.preventDefault();
        event.stopPropagation();
        void stop();
        return;
      }
      try {
        containTourTab(event, focusRootsRef.current);
      } catch (error) {
        report(error);
      }
    }
    document.addEventListener("keydown", onKeyDown, true);

    actionsRef.current = {
      refresh: () => {
        const active = driverRef.current;
        if (!active?.isActive() || stopping) return;
        const index = intendedIndex;
        if (index === STEP_INDEX.sessionDetail) {
          moveTo(index);
          return;
        }
        // Runtime can land between a click and Driver committing its next index. The click
        // owns that transition; refreshing the old step in the same tick would race it back.
        if (index < STEP_INDEX.dispatchKind) return;
        if (index === STEP_INDEX.dispatchSubmit && runtimeRef.current.taskId) {
          navigation.closeDispatch();
          moveTo(STEP_INDEX.working);
          return;
        }
        if (
          index >= STEP_INDEX.dispatchKind
          && index <= STEP_INDEX.dispatchSubmit
          && !runtimeRef.current.dispatchOpen
        ) {
          moveTo(STEP_INDEX.dispatch);
          return;
        }
        if (index === STEP_INDEX.review && runtimeRef.current.phase === "idle") {
          navigation.closeReview();
          moveTo(STEP_INDEX.idle);
          return;
        }
        if (
          index === STEP_INDEX.complete
          && !runtimeRef.current.completeOpen
        ) {
          moveTo(STEP_INDEX.actions);
          return;
        }
        active.moveTo(index);
      },
    };

    try {
      if (navigation.showLine()) {
        intendedIndex = 0;
        tour.drive(0);
      }
      else void stop();
    } catch (error) {
      report(error);
    }

    return () => {
      disposed = true;
      actionsRef.current = null;
      document.removeEventListener("keydown", onKeyDown, true);
      focusRootsRef.current = [];
      delete document.documentElement.dataset.mcTourReview;
      delete document.documentElement.dataset.mcTourDispatchSurface;
      delete document.documentElement.dataset.mcTourSessionTile;
      popoverRef.current = null;
      try {
        if (tour.isActive()) tour.destroy();
      } catch (error) {
        console.error("See the work tour cleanup failed", error);
      }
      driverRef.current = null;
    };
  }, [navigation, onFinish, registry]);

  useEffect(() => {
    actionsRef.current?.refresh();
  }, [runtime.completeOpen, runtime.dispatchBriefReady, runtime.dispatchOpen, runtime.dispatchRepoReady, runtime.error, runtime.phase, runtime.previewError, runtime.previewPhase, runtime.previewSessionId, runtime.reviewOpen, runtime.reviewPending, runtime.sessionId, runtime.taskId]);

  return null;
}
