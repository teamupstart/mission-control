import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { driver, type Driver, type PopoverDOM } from "driver.js";
import "driver.js/dist/driver.css";

import { containTourTab } from "./focus-containment.ts";
import {
  cursorAt,
  flattenTour,
  screenIndexOf,
  type TourCommand,
  type TourCursor,
  type TourDefinition,
  type TourScreen,
  type TourStep,
  type TourStepContext,
} from "./contracts.ts";
import type { TourTargetRegistry } from "./target-registry.ts";

const TARGET_WAIT_MS = 2_000;

function renderDescription<R, N>(
  element: HTMLElement,
  step: TourStep<R, N>,
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

/**
 * The rail counts STOPS, not Driver screens.
 *
 * A stop may spotlight two elements in turn, and the operator should read that as one step
 * with two looks rather than as two steps. Driver's own progress text counts its flat screen
 * list, so it is rewritten here from the owning stop instead of trusted.
 */
function renderProgressHeader(
  popover: PopoverDOM,
  title: string,
  stopIndex: number,
  stopCount: number,
): void {
  let header = popover.wrapper.querySelector<HTMLElement>(".mc-tour-head");
  let rail = popover.wrapper.querySelector<HTMLElement>(".mc-tour-progress-rail");
  if (!header || !rail) {
    header = document.createElement("header");
    header.className = "mc-tour-head";
    const identity = document.createElement("div");
    identity.className = "mc-tour-identity";
    const kicker = document.createElement("span");
    kicker.className = "mc-tour-kicker";
    kicker.textContent = title;
    rail = document.createElement("div");
    rail.className = "mc-tour-progress-rail";
    rail.setAttribute("role", "progressbar");
    rail.setAttribute("aria-label", `${title} tour progress`);
    rail.setAttribute("aria-valuemin", "1");
    rail.setAttribute("aria-valuemax", String(stopCount));
    identity.append(kicker, popover.progress);
    header.append(identity, rail);
    popover.wrapper.insertBefore(header, popover.title);
  }

  popover.progress.textContent = `Step ${stopIndex + 1} of ${stopCount}`;
  rail.setAttribute("aria-valuenow", String(stopIndex + 1));
  rail.setAttribute("aria-valuetext", `Step ${stopIndex + 1} of ${stopCount}`);
  rail.replaceChildren(...Array.from({ length: stopCount }, (_, item) => {
    const segment = document.createElement("span");
    segment.setAttribute("aria-hidden", "true");
    if (item === stopIndex) segment.className = "is-current";
    else if (item < stopIndex) segment.className = "is-past";
    return segment;
  }));
}

/**
 * The one Driver.js owner in Mission Control.
 *
 * Everything tour-specific arrives as a `TourDefinition`: the stops, what each one needs on
 * screen before it can be shown, what to say while that is still arriving, and where to go
 * when the runtime moves underneath it. This component owns only the fragile parts that are
 * the same for every tour - Driver's lifecycle, the intended-cursor authority, focus
 * containment, app-modal ownership, and a cleanup failure the operator can retry.
 */
export function GuidedTourController<Runtime, Navigation>({
  definition,
  registry,
  navigation,
  runtime,
  isTop,
  onFinish,
}: {
  definition: TourDefinition<Runtime, Navigation>;
  registry: TourTargetRegistry;
  navigation: Navigation;
  runtime: Runtime;
  isTop: boolean;
  onFinish: () => Promise<void>;
}): null {
  const driverRef = useRef<Driver | null>(null);
  const popoverRef = useRef<PopoverDOM | null>(null);
  const focusRootsRef = useRef<readonly HTMLElement[]>([]);
  const runtimeRef = useRef(runtime);
  const isTopRef = useRef(isTop);
  const actionsRef = useRef<{ refresh: () => void } | null>(null);
  const screens = useMemo(() => flattenTour(definition), [definition]);
  const runtimeKey = definition.runtimeKey(runtime);

  useLayoutEffect(() => {
    runtimeRef.current = runtime;
    isTopRef.current = isTop;
  }, [isTop, runtime]);

  useEffect(() => {
    let disposed = false;
    let stopping = false;
    let cleanupBlocked = false;
    // Driver's active index updates after a route/target transition commits. React state can
    // arrive inside that window, so keep the controller's requested STOP as the progression
    // authority instead of letting a refresh jump back to Driver's previous index. The cursor
    // is a stable stop id plus beat, never an index: an index is only ever a claim about the
    // screen list as it was, and Driver renumbers that list whenever a definition changes.
    let intended: TourCursor = cursorAt(screens, 0);
    const stopCount = definition.steps.length;
    const managedFlags = definition.documentFlags;

    /** The Driver screen the cursor currently names. Derived per call, never stored. */
    const intendedIndex = (): number => screenIndexOf(screens, intended);

    const screenAt = (index: number): TourScreen<Runtime, Navigation> =>
      screens[index] ?? screens[0]!;

    function contextAt(cursor: TourCursor): TourStepContext<Runtime, Navigation> {
      const screen = screenAt(screenIndexOf(screens, cursor));
      const beat = screen.stop.targets[screen.beat] ?? null;
      const base = {
        runtime: runtimeRef.current,
        navigation,
        registry,
        stop: screen.stop,
        beat: screen.beat,
      } as TourStepContext<Runtime, Navigation>;
      // Resolved on every read, not once. `prepare` runs BEFORE the surface it opens exists,
      // and Driver asks for the element again after its own wait; a value frozen here would
      // hand both of them the DOM as it was before the transition they are performing.
      Object.defineProperty(base, "element", {
        enumerable: true,
        get: () => (beat ? (beat.resolve ? beat.resolve(base) : registry.get(beat.target)) : null),
      });
      return base;
    }

    /** Whether the beat has an element to spotlight at all - a centered stop needs none. */
    function isPresent(context: TourStepContext<Runtime, Navigation>): boolean {
      return context.element !== null || context.stop.centered === true;
    }

    /**
     * Whether the stop's own preconditions hold. Deliberately independent of presence: a stop
     * whose Next opens the very surface it points at is usable before that surface mounts.
     */
    function isReady(context: TourStepContext<Runtime, Navigation>): boolean {
      return context.stop.ready ? context.stop.ready(context) : isPresent(context);
    }

    function clearFlags(): void {
      for (const flag of managedFlags) delete document.documentElement.dataset[flag];
    }

    function report(error: unknown): void {
      console.error(`${definition.title} tour failed`, error);
      void stop();
    }

    function showStopping(): void {
      const popover = popoverRef.current;
      if (!popover) return;
      popover.title.textContent = definition.stopping.title;
      popover.description.textContent = definition.stopping.description;
      for (const button of [popover.previousButton, popover.nextButton]) button.hidden = true;
      const exit = popover.footerButtons.querySelector<HTMLButtonElement>(".mc-tour-exit");
      if (exit) {
        exit.disabled = true;
        exit.textContent = "Finishing…";
      }
    }

    function showCleanupError(error: unknown): void {
      const popover = popoverRef.current;
      if (!popover) return;
      const message = error instanceof Error ? error.message : String(error);
      clearFlags();
      popover.wrapper.dataset.tourCleanupError = "true";
      popover.wrapper.setAttribute("role", "dialog");
      popover.wrapper.setAttribute("aria-modal", "true");
      popover.arrow.hidden = true;
      popover.title.textContent = "Tour cleanup needs attention";
      const detail = document.createElement("p");
      detail.className = "mc-tour-fallback";
      detail.setAttribute("role", "status");
      detail.textContent = `Mission Control restored where you started, but could not close every temporary session: ${message}. Retry cleanup before leaving the tour.`;
      popover.description.replaceChildren(detail);
      popover.previousButton.hidden = true;
      popover.nextButton.hidden = true;
      const retry = popover.footerButtons.querySelector<HTMLButtonElement>(".mc-tour-exit");
      if (retry) {
        retry.disabled = false;
        retry.textContent = "Retry cleanup";
        focusRootsRef.current = [popover.wrapper];
        retry.focus();
      }
    }

    async function stop(): Promise<void> {
      if (disposed || stopping) return;
      stopping = true;
      cleanupBlocked = false;
      showStopping();
      try {
        await onFinish();
      } catch (error) {
        console.error(`${definition.title} tour cleanup failed`, error);
        if (!disposed) {
          stopping = false;
          cleanupBlocked = true;
          showCleanupError(error);
        }
        return;
      }
      if (!disposed) {
        try {
          if (driverRef.current?.isActive()) driverRef.current.destroy();
        } catch (error) {
          console.error(`${definition.title} tour Driver cleanup failed`, error);
        }
      }
    }

    /** Stage the stop's surface, then move Driver onto it. A refusal ends the tour. */
    function moveTo(cursor: TourCursor): void {
      try {
        const context = contextAt(cursor);
        if (context.stop.prepare && !context.stop.prepare(context)) {
          void stop();
          return;
        }
        intended = cursor;
        // Driver speaks only in indexes, so the cursor is resolved to one HERE, after
        // `prepare` has committed the transition, rather than carried around as one.
        driverRef.current?.moveTo(screenIndexOf(screens, cursor));
      } catch (error) {
        report(error);
      }
    }

    function run(command: TourCommand): void {
      switch (command.kind) {
        case "hold":
          return;
        case "refresh":
          driverRef.current?.moveTo(intendedIndex());
          return;
        case "restage":
          moveTo(intended);
          return;
        case "goto":
          moveTo({ stopId: command.stopId, beat: command.beat ?? 0 });
          return;
        case "finish":
          void stop();
          return;
        default: {
          const unhandled: never = command;
          void unhandled;
        }
      }
    }

    async function advance(): Promise<void> {
      const tour = driverRef.current;
      if (!tour || stopping) return;
      const context = contextAt(intended);
      const custom = context.stop.onNext?.(context) ?? null;
      if (custom) {
        run(custom);
        return;
      }
      if (context.stop.gateNext && !isReady(context)) return;
      // Beats before stops: a two-beat stop looks at its second element without the operator
      // reading a second step number. Stepping is the one place a neighbour is named
      // positionally, because "the next screen" has no other meaning - the result is
      // converted straight back to a cursor.
      const at = intendedIndex();
      if (at >= screens.length - 1) {
        await stop();
        return;
      }
      moveTo(cursorAt(screens, at + 1));
    }

    function retreat(): void {
      const tour = driverRef.current;
      if (!tour || stopping) return;
      const at = intendedIndex();
      if (at <= 0) return;
      const context = contextAt(intended);
      try {
        context.stop.onBack?.(context);
      } catch (error) {
        report(error);
        return;
      }
      moveTo(cursorAt(screens, at - 1));
    }

    function decoratePopover(
      popover: PopoverDOM,
      hook: { index: number | undefined },
    ): void {
      try {
        popoverRef.current = popover;
        // Driver calls this while committing the NEXT screen, before getActiveIndex always
        // reflects it. Its hook index is the authoritative screen for this render, so it is
        // adopted as the cursor - converted to a stop id immediately, because that index is
        // meaningful only against the screen list Driver is rendering right now.
        const index = hook.index ?? driverRef.current?.getActiveIndex() ?? 0;
        intended = cursorAt(screens, index);
        const screen = screenAt(index);
        const step = screen.stop;
        const context = contextAt(intended);
        const ready = isReady(context);
        const fallback = isPresent(context) && ready
          ? null
          : definition.fallback?.(context) ?? step.fallback?.(context) ?? null;
        renderProgressHeader(popover, definition.title, screen.stopIndex, stopCount);
        renderDescription(popover.description, step, fallback);
        if (fallback) popover.wrapper.dataset.tourFallback = "true";
        else delete popover.wrapper.dataset.tourFallback;

        const on = new Set(step.documentFlags?.(context) ?? []);
        const keep = new Set(step.retainDocumentFlags?.(context) ?? []);
        for (const flag of managedFlags) {
          if (on.has(flag)) document.documentElement.dataset[flag] = "true";
          else if (!keep.has(flag)) delete document.documentElement.dataset[flag];
        }

        const surfaceId = step.appSurface?.(context) ?? null;
        const appDialogSurface = surfaceId ? registry.get(surfaceId) : null;
        if (appDialogSurface) {
          popover.wrapper.setAttribute("role", "status");
          popover.wrapper.removeAttribute("aria-modal");
          focusRootsRef.current = [appDialogSurface, popover.wrapper];
        } else {
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
        popover.nextButton.hidden = step.hideNext?.(context) ?? false;
        popover.nextButton.disabled = Boolean(step.gateNext) && !ready;
        popover.nextButton.textContent = step.nextLabel?.(context) ?? "Next";

        const focusTour = (): void => {
          const preferred = step.focusTarget?.(contextAt(cursorAt(screens, index))) ?? null;
          if (preferred?.isConnected) preferred.focus();
          else if (!popover.nextButton.hidden && !popover.nextButton.disabled) {
            popover.nextButton.focus();
          } else exit.focus();
        };
        // Driver performs its own initial focus after onPopoverRender. Where the tour hands
        // the screen to a real surface, place focus there on the next frame, after Driver's
        // pass, instead of racing it in the same microtask checkpoint.
        if (step.interactive) requestAnimationFrame(focusTour);
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
        popoverClass: `mc-tour mc-tour-${definition.id}`,
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
        steps: screens.map((screen) => {
          const beat = screen.stop.targets[screen.beat] ?? null;
          // Driver asks for this element again after its own wait, so it resolves through the
          // screen's own cursor rather than closing over the position it was built at.
          const cursor: TourCursor = { stopId: screen.stop.id, beat: screen.beat };
          return {
            element: (() => contextAt(cursor).element) as () => Element,
            waitForElement: TARGET_WAIT_MS,
            skipMissingElement: false,
            disableActiveInteraction: !screen.stop.interactive,
            popover: {
              title: screen.stop.title,
              description: screen.stop.description,
              side: beat?.side ?? screen.stop.side ?? "top",
              align: "center",
            },
          };
        }),
      });
    } catch (error) {
      report(error);
      return;
    }
    driverRef.current = tour;

    function onKeyDown(event: KeyboardEvent): void {
      const context = contextAt(intended);
      const modalOwnsScreen = context.stop.modalOwnsScreen?.(context) ?? false;
      if (!isTopRef.current && !modalOwnsScreen) return;
      if (event.key === "Escape") {
        // A registered app modal is the top layer at these stops. Let its existing Escape
        // handler peel only that modal; the next Escape reaches the tour underneath.
        if (modalOwnsScreen) return;
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
        if (!active?.isActive() || stopping || cleanupBlocked) return;
        const context = contextAt(intended);
        run(context.stop.reconcile?.(context) ?? { kind: "refresh" });
      },
    };

    try {
      const start = cursorAt(screens, 0);
      const first = contextAt(start);
      if (!first.stop.prepare || first.stop.prepare(first)) {
        intended = start;
        tour.drive(screenIndexOf(screens, start));
      } else void stop();
    } catch (error) {
      report(error);
    }

    return () => {
      disposed = true;
      actionsRef.current = null;
      document.removeEventListener("keydown", onKeyDown, true);
      focusRootsRef.current = [];
      clearFlags();
      popoverRef.current = null;
      try {
        if (tour.isActive()) tour.destroy();
      } catch (error) {
        console.error(`${definition.title} tour cleanup failed`, error);
      }
      driverRef.current = null;
    };
  }, [definition, navigation, onFinish, registry, screens]);

  useEffect(() => {
    actionsRef.current?.refresh();
  }, [runtimeKey]);

  return null;
}
