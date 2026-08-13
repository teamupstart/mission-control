import type { EnsembleSummary } from "@shared/ensemble.ts";
import type { EnsembleStrategyId } from "@shared/ensemble.ts";
import type { MissionSchedule } from "@shared/schedules.ts";
import type {
  PersonaUpstreamState,
  PersonaView,
  SessionAction,
  WorkflowCommandView,
  WorkflowRunSummary,
  WorkflowSummary,
} from "@shared/workflow.ts";
import { Tooltip } from "../components/Tooltip.tsx";
import type { LibrarySurface } from "../workflows/useWorkflowRoute.ts";
import {
  actionCards,
  actionWaitsCrossLink,
  commandCards,
  ensembleStrategyCards,
  ensemblesCrossLink,
  libraryShelfCopy,
  missionCards,
  missionsCrossLink,
  personaCards,
  TASK_SOURCES_CARD_ID,
  taskSourcesCard,
  workflowCards,
  workflowRunsCrossLink,
  type LibraryCard,
  type ShelfCrossLink,
} from "./library-model.ts";

/**
 * The Library: the one home for everything an operator authors once and reuses.
 *
 * It renders no live execution state. Each shelf carries a single cross-link to where its
 * assets are actually running, and that is the whole of the traffic between authoring and execution -
 * a shelf that grew a status column would be a second, slower answer to a question the runs
 * and ensembles surfaces already answer properly.
 */

function ShelfCard({
  card,
  glyph,
  onOpen,
  openHint,
}: {
  card: LibraryCard;
  glyph: string;
  onOpen: () => void;
  openHint: string;
}): React.JSX.Element {
  return (
    <Tooltip label={openHint}>
      <button className="lib-asset" onClick={onOpen}>
        <span className="lib-asset-head">
          <span className="lib-asset-glyph" aria-hidden>{glyph}</span>
          <span className="lib-asset-name">{card.name}</span>
          {card.tags.map((tag) => (
            <em key={tag.label} className={`lib-tag lib-tag-${tag.tone}`}>{tag.label}</em>
          ))}
        </span>
        <span className="lib-asset-desc">{card.description || "No description"}</span>
        <span className={`lib-asset-fact${card.factTone ? ` is-${card.factTone}` : ""}`}>
          {card.fact}
        </span>
      </button>
    </Tooltip>
  );
}

function Shelf({
  id,
  cards,
  crossLink,
  crossLinkHint,
  onCrossLink,
  onOpenCard,
  openHint,
  newCard,
  empty,
}: {
  id: Parameters<typeof libraryShelfCopy>[0];
  cards: LibraryCard[];
  /**
   * Where this shelf's assets are running, or null on a shelf where that question has no
   * honest answer.
   *
   * Nullable for Commands and Commands alone. A Command is not an asset with runs of its
   * own - it is what a workflow's node executes, and those runs are already counted by the
   * Workflows shelf's link. Pointing all four cards at the same run list to satisfy a prop
   * would be a number this shelf did not measure.
   */
  crossLink: ShelfCrossLink | null;
  crossLinkHint: string;
  onCrossLink: () => void;
  onOpenCard: (card: LibraryCard) => void;
  openHint: (card: LibraryCard) => string;
  /** The dashed "＋ New" affordance, or null on a shelf that authors nothing. */
  newCard: { label: string; hint: string; sub: string; onClick: () => void } | null;
  /** What to say when the shelf has no cards yet. */
  empty: string;
}): React.JSX.Element {
  const copy = libraryShelfCopy(id);
  return (
    <section className="lib-shelf" aria-labelledby={`lib-shelf-${id}`}>
      <div className="lib-shelf-top">
        <span className="lib-shelf-eyebrow">{copy.eyebrow}</span>
        {crossLink && (
          <Tooltip label={crossLinkHint}>
            <button
              className={`lib-shelf-live${crossLink.attention ? " is-attention" : ""}`}
              onClick={onCrossLink}
            >
              {crossLink.label}
            </button>
          </Tooltip>
        )}
      </div>
      {/* The QUESTION is the heading and the noun is the eyebrow above it. That inversion is
          the page: an operator who has never opened this product learns what a workflow is
          for by reading the shelf, not by clicking into one. */}
      <h3 id={`lib-shelf-${id}`}>{copy.question}</h3>
      <p className="lib-shelf-why">{copy.why}</p>
      <div className="lib-shelf-row">
        {cards.map((card) => (
          <ShelfCard
            key={card.id}
            card={card}
            glyph={copy.glyph}
            onOpen={() => onOpenCard(card)}
            openHint={openHint(card)}
          />
        ))}
        {cards.length === 0 && <p className="lib-shelf-empty">{empty}</p>}
        {newCard && (
          <Tooltip label={newCard.hint}>
            <button className="lib-asset lib-asset-new" onClick={newCard.onClick}>
              <span className="lib-asset-new-label">{newCard.label}</span>
              <span className="lib-asset-new-sub">{newCard.sub}</span>
            </button>
          </Tooltip>
        )}
      </div>
    </section>
  );
}

export function LibraryPage({
  workflowSummaries = [],
  personas = [],
  personaUpstream,
  sessionActions = [],
  workflowCommands = [],
  hasSnapshot = false,
  workflowRuns = [],
  ensembleSummaries = [],
  ensembleAttentionCount = 0,
  schedules = [],
  onOpenAsset,
  onCreateAsset,
  onLaunchEnsemble,
  onOpenRuns,
  onOpenEnsembles,
  onOpenMissions,
  onOpenTaskSources,
}: {
  workflowSummaries?: WorkflowSummary[];
  personas?: PersonaView[];
  /** What the last upstream check found for each imported Persona; badges the reviewer cards. */
  personaUpstream?: ReadonlyMap<string, PersonaUpstreamState>;
  sessionActions?: SessionAction[];
  /**
   * The Global Command catalog, straight off the SSE stream. Four entries, always - see
   * `commandCards`, which projects the registry rather than this list.
   */
  workflowCommands?: WorkflowCommandView[];
  /**
   * Whether the SSE snapshot has landed.
   *
   * Defaults to FALSE, which is the safe direction rather than the convenient one: every fact
   * derived from it is a claim about durable state, and a page that assumed it was loaded
   * would publish those claims with no evidence. Only the Commands shelf reads it today - the
   * other five draw cards from lists that are simply empty until they arrive.
   */
  hasSnapshot?: boolean;
  /** Read for the per-shelf cross-link counts only; no run is rendered on this page. */
  workflowRuns?: WorkflowRunSummary[];
  ensembleSummaries?: EnsembleSummary[];
  /** The daemon's own count, passed down rather than re-folded here. */
  ensembleAttentionCount?: number;
  schedules?: MissionSchedule[];
  /** Open an authoring surface one level deeper, on this asset. */
  onOpenAsset: (shelf: LibrarySurface, assetId: string) => void;
  /** Open an authoring surface one level deeper, on a new draft. */
  onCreateAsset: (shelf: LibrarySurface) => void;
  onLaunchEnsemble: (strategyId: EnsembleStrategyId) => void;
  onOpenRuns: () => void;
  onOpenEnsembles: () => void;
  onOpenMissions: () => void;
  onOpenTaskSources: () => void;
}): React.JSX.Element {
  const workflows = workflowCards(workflowSummaries);
  const reviewers = personaCards(personas, personaUpstream);
  const actions = actionCards(sessionActions);
  const strategies = ensembleStrategyCards();
  const missions = missionCards(schedules);
  const commands = commandCards(workflowCommands, hasSnapshot);

  return (
    <main className="lib-page">
      <header className="lib-head">
        <div>
          <p className="workflow-eyebrow">Authoring</p>
          <h2>Library</h2>
        </div>
        {/* "Nothing RUNS FROM HERE", not "nothing here runs". The distinction is load-bearing
            now that Commands are shelved beside the rest: a Command is an executable argv, and
            saving one still executes nothing - a workflow reaching its slot does, later, in a
            repository Trust has granted. The old phrasing would have read as a claim that the
            box you just typed `npm test` into is inert, which is a different promise. */}
        <p className="lib-sub">
          Everything you author once and reuse. Nothing runs from here - live state stays on
          the runs and ensembles pages.
        </p>
      </header>

      <Shelf
        id="workflows"
        cards={workflows}
        crossLink={workflowRunsCrossLink(workflowRuns)}
        crossLinkHint="Watch the workflow runs these are bound to"
        onCrossLink={onOpenRuns}
        onOpenCard={(card) => onOpenAsset("workflows", card.id)}
        openHint={(card) => `Open ${card.name} in the workflow builder`}
        newCard={{
          label: "＋ New workflow",
          sub: "pipeline or graph editor",
          hint: "Create a workflow draft and open it in the builder",
          onClick: () => onCreateAsset("workflows"),
        }}
        empty="No workflows yet."
      />

      <Shelf
        id="personas"
        cards={reviewers}
        crossLink={workflowRunsCrossLink(workflowRuns)}
        crossLinkHint="Watch the runs where these reviewers return verdicts"
        onCrossLink={onOpenRuns}
        onOpenCard={(card) => onOpenAsset("personas", card.id)}
        openHint={(card) => `Open ${card.name} in the Persona editor`}
        newCard={{
          label: "＋ New Persona",
          sub: "or import .md",
          hint: "Author a new reviewer Persona",
          onClick: () => onCreateAsset("personas"),
        }}
        empty="No Personas yet."
      />

      <Shelf
        id="actions"
        cards={actions}
        crossLink={actionWaitsCrossLink(workflowRuns)}
        crossLinkHint="Watch the runs waiting on a session to carry out an action"
        onCrossLink={onOpenRuns}
        onOpenCard={(card) => onOpenAsset("actions", card.id)}
        openHint={(card) => `Open ${card.name} in the Action editor`}
        newCard={{
          label: "＋ New action",
          sub: "exact Markdown, one skill",
          hint: "Author a new instruction a workflow stage can send",
          onClick: () => onCreateAsset("actions"),
        }}
        empty="No actions yet."
      />

      <Shelf
        id="ensembles"
        cards={strategies}
        crossLink={ensemblesCrossLink(ensembleSummaries, ensembleAttentionCount)}
        crossLinkHint="Watch ensembles, their evidence, and their decisions"
        onCrossLink={onOpenEnsembles}
        onOpenCard={(card) => onLaunchEnsemble(card.id as EnsembleStrategyId)}
        openHint={(card) => `Launch an ensemble using ${card.name}`}
        // Nothing to author: a strategy ships with the build, so the only affordance is to
        // start one.
        newCard={null}
        empty="This build offers no ensemble strategies."
      />

      <Shelf
        id="missions"
        cards={[...missions, taskSourcesCard()]}
        crossLink={missionsCrossLink(schedules)}
        crossLinkHint="Open recurring missions - cadence, preview, and run history"
        onCrossLink={onOpenMissions}
        onOpenCard={(card) => {
          if (card.id === TASK_SOURCES_CARD_ID) onOpenTaskSources();
          else onOpenMissions();
        }}
        openHint={(card) => (card.id === TASK_SOURCES_CARD_ID
          ? "Open task sources in Settings"
          : `Open ${card.name} in recurring missions`)}
        newCard={{
          label: "＋ New mission",
          sub: "file a task on a cadence",
          hint: "Schedule a recurring mission - it files a backlog task and never launches an agent",
          onClick: onOpenMissions,
        }}
        // The sources card is always present, so this only shows if the shelf model itself
        // returned nothing - which it cannot. Kept honest rather than removed.
        empty="No missions or sources yet."
      />

      <Shelf
        id="commands"
        cards={commands}
        // No cross-link, and no ＋ New card. The four slots ship with the product, and their
        // runs are the workflow runs the first shelf already links to.
        crossLink={null}
        crossLinkHint=""
        onCrossLink={() => {}}
        onOpenCard={(card) => onOpenAsset("commands", card.id)}
        openHint={(card) => `Set what the ${card.name} Command runs on this machine`}
        newCard={null}
        // Unreachable: `commandCards` projects the four built-in slots, so the shelf is
        // never empty. Kept honest rather than removed.
        empty="This build offers no Command slots."
      />
    </main>
  );
}
