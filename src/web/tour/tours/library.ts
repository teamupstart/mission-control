import { NO_MISTAKES_REVIEW_WORKFLOW_ID } from "@shared/builtin-workflow.ts";
import {
  workflowRunIsOpen,
  type WorkflowCheckSlot,
  type WorkflowRunSummary,
} from "@shared/workflow.ts";

import { LIBRARY_SHELF_COPY } from "../../library/library-model.ts";
import {
  assertTourDefinition,
  refresh,
  restage,
  type TourDefinition,
  type TourStep,
  type TourStepContext,
} from "../contracts.ts";

/**
 * The finished run this tour run pinned, kept as a value rather than re-selected per stop.
 *
 * A run outlives the session it reviewed, so `sessionName` is carried here for the one case
 * the live collection cannot answer: the session is evicted between the Runs stop and the
 * session stop, and the ladder stop still has to name what it was watching.
 */
export interface LibraryTourRun {
  id: string;
  sessionId: string | null;
  sessionName: string | null;
}

export interface LibraryTourRuntime {
  /** The built-in Persona this tour teaches on, once the catalog has landed. */
  personaId: string | null;
  /** The built-in Session action this tour teaches on, once the catalog has landed. */
  actionId: string | null;
  /** Whether the built-in No-Mistakes Review workflow is in the catalog yet. */
  workflowReady: boolean;
  /** The qualifying finished run, or null when the fleet has none. */
  run: LibraryTourRun | null;
  /** Whether that run's session is still in the live collection RIGHT NOW. */
  runSessionLive: boolean;
}

/**
 * Every move this tour makes, as a route transition the app already performs.
 *
 * There is no click simulation and no write: each of these publishes a hash the Library and
 * Runs pages already answer, and returns whatever `navigate` returned - so a dirty draft
 * refusing the first move ends the tour rather than half-starting it behind a dialog.
 */
export interface LibraryTourNavigation {
  showLibrary: () => boolean;
  showPersona: (personaId: string) => boolean;
  showAction: (actionId: string) => boolean;
  showCommandSlot: () => boolean;
  showWorkflow: () => boolean;
  showRun: (runId: string) => boolean;
  /** Return to the fleet, select the run's session, and ask for its Workflows tab. */
  showRunSession: (sessionId: string) => boolean;
}

/**
 * The Command slot this tour opens.
 *
 * One of the four the product ships, named here rather than in App so the stop's copy and the
 * route it navigates to cannot drift apart. `test` because it is the slot an operator is most
 * likely to have configured, and the one the built-in workflow's first stage reaches.
 */
export const LIBRARY_TOUR_COMMAND_SLOT: WorkflowCheckSlot = "test";

/**
 * The run the tour opens on: the newest terminal run of the CURRENT published version of the
 * built-in No-Mistakes Review whose session is still here.
 *
 * Two clauses, not one. A run outlives the session it reviewed - `orphanBinding` nulls
 * `sessionId` when the session goes, and the summary keeps a durable `sessionName` for exactly
 * that case - so a finished run with no session left is the COMMON case rather than the rare
 * one, and the tour's last stop opens that session's Workflows tab. Membership in the live
 * collection is the test rather than any state reading: a session leaves that collection on
 * `session_remove`, which is the one durable signal that it is gone.
 *
 * The workflow match is EXACT, and that is a decision rather than an oversight. An operator's
 * own duplicate of No-Mistakes is a different workflow with a different id, and a run of some
 * other workflow need not carry any of the five stages the previous stop just walked - so a
 * wider net would catch mostly wrong fish and contradict the stop that introduced it.
 *
 * The VERSION has to match for the same reason the id does. Published versions are immutable
 * and older ones are kept forever, so a terminal run of version 9 can easily be the newest run
 * on a machine whose built-in has since shipped version 10. Stops 11 and 12 walk the CURRENT
 * version's stages and name its postures; opening a version 9 run two stops later would
 * describe a different pipeline as the one just taught, which is worse than the fallback that
 * points at the built-in graph still on screen. An unpublished built-in has no current version
 * to agree with, so nothing qualifies and the run chapter falls back.
 *
 * `workflowRunIsOpen` rather than a copy of the terminal-status tuple: that union is
 * append-only, and a surface carrying its own copy is how one reader keeps counting a finished
 * run as live.
 */
export function selectLibraryTourRun(
  summaries: readonly WorkflowRunSummary[],
  liveSessionIds: ReadonlySet<string>,
  currentVersion: number | null,
): LibraryTourRun | null {
  if (currentVersion === null) return null;
  const newest = summaries.reduce<WorkflowRunSummary | null>((best, candidate) => {
    if (candidate.workflowId !== NO_MISTAKES_REVIEW_WORKFLOW_ID) return best;
    if (candidate.workflowVersion !== currentVersion) return best;
    if (workflowRunIsOpen(candidate.status)) return best;
    if (candidate.sessionId === null || !liveSessionIds.has(candidate.sessionId)) return best;
    if (best === null) return candidate;
    // The id breaks a tie rather than leaving it to array order, so two runs written in the
    // same millisecond still choose the same one on every start.
    if (candidate.updatedAt !== best.updatedAt) {
      return candidate.updatedAt > best.updatedAt ? candidate : best;
    }
    return candidate.id > best.id ? candidate : best;
  }, null);
  return newest
    ? { id: newest.id, sessionId: newest.sessionId, sessionName: newest.sessionName ?? null }
    : null;
}

type Context = TourStepContext<LibraryTourRuntime, LibraryTourNavigation>;
type Step = TourStep<LibraryTourRuntime, LibraryTourNavigation>;

/** The run chapter's two stops both stand on the same pinned run. */
const hasLiveRun = (context: Context): boolean =>
  context.runtime.run !== null && context.runtime.run.sessionId !== null;

/**
 * What the run chapter falls back to, in the operator's own words rather than an apology.
 *
 * Two states, and the second covers everything that is not the first. A run of another
 * workflow, an operator's own duplicate of No-Mistakes, an unfinished run, and no run at all
 * are one case - there is nothing of this workflow's shape to point at - and they get the same
 * sentence. A run that exists but whose session has gone is the other, and it can still name
 * what it was watching.
 */
const noRunCopy =
  "This machine has no finished No-Mistakes Review run to open yet, so there is nothing live "
  + "to spotlight. A run's pipeline strip is the five stages you just walked, carrying real "
  + "state, and its review worklist sorts what each reviewer said into Blocking and Passed. "
  + "Back, Next, and Exit remain available.";

const STEPS: readonly Step[] = [
  {
    id: "library",
    title: "The Library",
    description:
      "Everything you author once and reuse. Nothing runs from here: saving an asset changes "
      + "what a later run will do, and never starts one. Six shelves, each headed by the "
      + "question it answers rather than by its noun.",
    // Read from the shelf registry rather than restated, so a shelf that rewords its question
    // cannot leave the tour teaching the old one.
    details: LIBRARY_SHELF_COPY.map((shelf) => ({
      label: shelf.eyebrow,
      description: shelf.question,
    })),
    targets: [{ target: "library:library-page", side: "bottom" }],
    prepare: (context) => context.navigation.showLibrary(),
    // The tour walks the shelves BOTTOM-UP - Personas, Actions, Commands, then Workflows -
    // because that is dependency order: a workflow is built out of the other three.
    reconcile: refresh,
  },
  {
    id: "persona-library",
    title: "The Persona library",
    description:
      "A Persona is one reviewer's standards in Markdown. The rail groups them as System, "
      + "Built-in, and Yours with their own counts, and each row's sub-label is the resolved "
      + "runner and model - which is what tells two reviewers apart.",
    targets: [{ target: "library:persona-rail", side: "right" }],
    // Navigating to the shelf before the catalog names a built-in would open the surface on
    // whatever happened to sort first, and the surface takes its selection at mount. So the
    // stop waits on the shelves page and restages once the id is known.
    prepare: (context) => (
      context.runtime.personaId
        ? context.navigation.showPersona(context.runtime.personaId)
        : context.navigation.showLibrary()
    ),
    ready: (context) => context.runtime.personaId !== null && context.element !== null,
    fallback: () =>
      "Mission Control is still loading the Persona catalog. The tour opens a shipped reviewer "
      + "as soon as it arrives; Back and Exit remain available.",
    reconcile: restage,
  },
  {
    id: "persona-anatomy",
    title: "What a Persona is, and what configures it",
    description:
      "The Markdown is the asset; everything above it is metadata about how that Markdown gets "
      + "run. Provider and model open the control that set them, and a chip inherited from the "
      + "app defaults draws quiet where one this Persona overrides draws solid.",
    targets: [
      { target: "library:persona-chips", side: "bottom" },
      { target: "library:persona-guidance", side: "top" },
    ],
    prepare: (context) => (
      context.runtime.personaId
        ? context.navigation.showPersona(context.runtime.personaId)
        : context.navigation.showLibrary()
    ),
    ready: (context) => context.runtime.personaId !== null && context.element !== null,
    fallback: () =>
      "The shipped Persona is still opening. Back and Exit remain available.",
    reconcile: restage,
  },
  {
    id: "persona-editing",
    title: "Editing one",
    description:
      "On a built-in the promoted verb reads Duplicate to edit, and that is the whole ownership "
      + "rule: shipped roles are read-only, and a copy you own is one gesture with an honest "
      + "name. On your own Persona the same button reads Save. Import .md, Import from path, "
      + "and Check upstream sit in the rail footer.",
    targets: [{ target: "library:persona-primary-action", side: "bottom" }],
    prepare: (context) => (
      context.runtime.personaId
        ? context.navigation.showPersona(context.runtime.personaId)
        : context.navigation.showLibrary()
    ),
    ready: (context) => context.runtime.personaId !== null && context.element !== null,
    fallback: () =>
      "The shipped Persona is still opening, so its promoted verb has not mounted. Back and "
      + "Exit remain available.",
    reconcile: restage,
  },
  {
    id: "action-library",
    title: "The Action library",
    description:
      "An Action is a reusable instruction a workflow stage sends to the bound session - open a "
      + "pull request, run a migration. It completes; it never judges. The rail and workspace "
      + "are the Persona screen's, because this is one surface with different contents, and "
      + "each row's sub-label is its contract rather than its description.",
    targets: [{ target: "library:action-rail", side: "right" }],
    prepare: (context) => (
      context.runtime.actionId
        ? context.navigation.showAction(context.runtime.actionId)
        : context.navigation.showLibrary()
    ),
    ready: (context) => context.runtime.actionId !== null && context.element !== null,
    fallback: () =>
      "Mission Control is still loading the Session action catalog. The tour opens a shipped "
      + "action as soon as it arrives; Back and Exit remain available.",
    reconcile: restage,
  },
  {
    id: "action-contract",
    title: "The contract, and the instruction",
    description:
      "Requires skill and completes when are the one machine-checked contract in the Library: "
      + "something observable has to happen before a stage may call this action done, and the "
      + "sentence under the chips says so in full. Then the instruction, whose Markdown reaches "
      + "the session byte for byte. Editing is the same promoted verb the Persona screen just "
      + "showed, on the same shared workspace header.",
    targets: [
      { target: "library:action-contract", side: "bottom" },
      { target: "library:action-instruction", side: "top" },
    ],
    prepare: (context) => (
      context.runtime.actionId
        ? context.navigation.showAction(context.runtime.actionId)
        : context.navigation.showLibrary()
    ),
    ready: (context) => context.runtime.actionId !== null && context.element !== null,
    fallback: () =>
      "The shipped Session action is still opening. Back and Exit remain available.",
    reconcile: restage,
  },
  {
    id: "command-slot",
    title: "A Command slot",
    description:
      "Four fixed slots ship with the product - test, lint, typecheck, and build - so there is "
      + "no New card here. A workflow's Command node names a portable slot and never an argv, which "
      + "is what lets the same workflow run against any repository; this screen is where THIS "
      + "machine says what the slot runs.",
    targets: [{ target: "library:command-default", side: "bottom" }],
    prepare: (context) => context.navigation.showCommandSlot(),
    reconcile: restage,
  },
  {
    id: "command-overrides",
    title: "Overrides, and saving one",
    description:
      "A repository path plus an override command writes one exception into the rules table "
      + "above; everything else keeps the machine-wide default. Then Save Command - and the "
      + "point is that saving executes nothing. A workflow reaching this slot, later, in a "
      + "repository granted the Workflows cell in Trust, is what runs it, and Settings → "
      + "Workflows → Allow workflow Commands is the machine-wide switch above that.",
    targets: [
      { target: "library:command-overrides", side: "top" },
      { target: "library:command-save", side: "bottom" },
    ],
    prepare: (context) => context.navigation.showCommandSlot(),
    reconcile: restage,
  },
  {
    id: "workflow-builder",
    title: "The builder",
    description:
      "A workflow is composed of Persona, Command, and Session action nodes - exactly the three "
      + "assets the last three chapters covered. The rail lists what exists, tags what ships "
      + "with the build, and New is where a workflow of your own starts. The node palette that "
      + "adds nodes renders only in Graph view on a draft you own, so this stop names where "
      + "creation begins rather than pressing it.",
    targets: [{ target: "library:workflow-rail", side: "right" }],
    prepare: (context) => context.navigation.showWorkflow(),
    ready: (context) => context.runtime.workflowReady && context.element !== null,
    fallback: () =>
      "Mission Control is still loading the workflow catalog. Back and Exit remain available.",
    reconcile: restage,
  },
  {
    id: "workflow-draft",
    title: "Draft and published",
    description:
      "Pipeline and Graph are two views of one workflow, and the toolbar offers both for "
      + "anything open. Publish is disabled here, and that disabled control is the whole "
      + "lesson: a built-in ships already published and always carries the graph this build was "
      + "made from, so Duplicate is how you get a copy you own. A draft follows Library edits, a "
      + "published version freezes its Persona snapshots, and publishing never changes a binding "
      + "that already exists.",
    targets: [
      { target: "library:workflow-surface-toggle", side: "bottom" },
      { target: "library:workflow-publish", side: "bottom" },
    ],
    prepare: (context) => context.navigation.showWorkflow(),
    ready: (context) => context.runtime.workflowReady && context.element !== null,
    fallback: () =>
      "The built-in workflow's toolbar has not mounted yet. Back and Exit remain available.",
    reconcile: restage,
  },
  {
    id: "workflow-no-mistakes",
    title: "No-Mistakes Review",
    description:
      "Five stages, in order: typecheck and test together; Intent Conformance alone as a cheap "
      + "gate; Code Risk and Code Quality in parallel; Test Evidence and Documentation in "
      + "parallel; then the verified Pull Request action before End. Every failure returns to "
      + "the session for a repair round, up to five. It is a built-in, so its versions stay "
      + "addressable exactly as shipped and your changes live in a Duplicate.",
    targets: [{ target: "library:workflow-pipeline-strip", side: "top" }],
    prepare: (context) => context.navigation.showWorkflow(),
    ready: (context) => context.runtime.workflowReady && context.element !== null,
    fallback: () =>
      "The built-in pipeline is still drawing. Back and Exit remain available.",
    reconcile: restage,
  },
  {
    id: "workflow-bind",
    title: "Binding it",
    description:
      "Binding attaches a published version to one session's work in one repository. Version 10 "
      + "ships Foreman-complete as its trigger, live delivery of each repair packet into the "
      + "session, and five repair rounds before it stops asking.",
    targets: [{ target: "library:workflow-bind", side: "top" }],
    prepare: (context) => context.navigation.showWorkflow(),
    ready: (context) => context.runtime.workflowReady && context.element !== null,
    fallback: () =>
      "The built-in workflow's binding control has not mounted yet. Back and Exit remain "
      + "available.",
    reconcile: restage,
  },
  {
    id: "run-moving",
    title: "A run, moving",
    description:
      "The same five stages, now carrying real state from a finished run of your own. Under the "
      + "strip, the review worklist sorts what the reviewers actually said: Blocking is what is "
      + "still open, Passed is what cleared, and an individual verdict opens in place.",
    targets: [
      {
        target: "library:run-pipeline-strip",
        side: "bottom",
        // No qualifying run means there is nothing to spotlight rather than a target that has
        // not mounted yet, so the popover centers and the stop says what it would have shown.
        resolve: (context) =>
          context.runtime.run ? context.registry.get("library:run-pipeline-strip") : null,
      },
      {
        target: "library:run-worklist",
        side: "top",
        resolve: (context) =>
          context.runtime.run ? context.registry.get("library:run-worklist") : null,
      },
    ],
    prepare: (context) => (
      context.runtime.run
        ? context.navigation.showRun(context.runtime.run.id)
        : context.navigation.showWorkflow()
    ),
    ready: (context) => context.runtime.run !== null && context.element !== null,
    fallback: (context) =>
      context.runtime.run
        ? "The run is opening. Back, Next, and Exit remain available."
        : noRunCopy,
    reconcile: restage,
  },
  {
    id: "run-watched",
    title: "Where a run is watched",
    description:
      "The same run, drawn as the vertical stage ladder in its session's Workflows tab. That is "
      + "where the work is actually followed: the desk you are already reading is the one that "
      + "tells you a reviewer is waiting on it.",
    targets: [
      {
        target: "library:session-workflow-ladder",
        side: "left",
        resolve: (context) =>
          hasLiveRun(context) && context.runtime.runSessionLive
            ? context.registry.get("library:session-workflow-ladder")
            : null,
      },
    ],
    prepare: (context) => {
      const run = context.runtime.run;
      if (run?.sessionId && context.runtime.runSessionLive) {
        return context.navigation.showRunSession(run.sessionId);
      }
      // A run whose session has gone keeps the run on screen from the previous stop; with no
      // run at all the built-in graph is still the thing being explained.
      return run ? true : context.navigation.showWorkflow();
    },
    ready: (context) =>
      hasLiveRun(context) && context.runtime.runSessionLive && context.element !== null,
    fallback: (context) => {
      const run = context.runtime.run;
      if (!run) {
        return "With no finished No-Mistakes Review run to follow, there is no stage ladder to "
          + "open. A session's Workflows tab draws its bound run as a vertical ladder - one rung "
          + "per stage, in the order the pipeline runs them - which is where the work is "
          + "followed. Back, Next, and Exit remain available.";
      }
      if (!context.runtime.runSessionLive || run.sessionId === null) {
        return `The session this run reviewed${run.sessionName ? ` - ${run.sessionName}` : ""} is `
          + "no longer live, so its Workflows tab cannot be opened. That tab draws the same run "
          + "you just read as a vertical stage ladder, and the run itself outlives the session: "
          + "it keeps the session's name after the conversation is gone. Back, Next, and Exit "
          + "remain available.";
      }
      return "The session's Workflows tab is opening. Back, Next, and Exit remain available.";
    },
    // The live collection losing the session is exactly what this stop reacts to, and it must
    // NOT re-run `prepare` into a session that is gone - a refresh redraws the copy in place.
    reconcile: refresh,
  },
  {
    id: "close",
    title: "That is the authoring half",
    description:
      "Personas, Actions, and Commands are the parts; a workflow composes them and decides what "
      + "counts as done. This tour wrote nothing: no asset was saved, duplicated, published, or "
      + "bound, and no run was started. See the work, in the same Help & tours footer and the "
      + "same palette group, is the other half - the Line, the Board, one session's desk, and a "
      + "task from dispatch to completion.",
    targets: [],
    centered: true,
    // The last screen's primary verb says what it does. Driver's own "done" text is not used
    // here - the engine writes every Next label from the definition - so the stop says it.
    nextLabel: () => "Finish tour",
    reconcile: refresh,
  },
];

export const LIBRARY_TOUR: TourDefinition<LibraryTourRuntime, LibraryTourNavigation> =
  assertTourDefinition({
    id: "library",
    title: "Author what runs",
    steps: STEPS,
    // This tour creates nothing and dims nothing extra: every surface it points at is ordinary
    // chrome, so it turns no document flag on.
    documentFlags: [],
    stopping: {
      title: "Closing the tour…",
      description: "Restoring the page, the asset, and the control you started from.",
    },
    runtimeKey: (runtime) => [
      runtime.personaId,
      runtime.actionId,
      runtime.workflowReady,
      runtime.run?.id ?? null,
      runtime.run?.sessionId ?? null,
      runtime.runSessionLive,
    ].join(" "),
  });
