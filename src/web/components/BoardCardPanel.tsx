import { useMemo } from "react";

import {
  DISPLAY_CHOICES,
  DISPLAY_GROUP_COPY,
  DISPLAY_ITEMS,
  DISPLAY_ITEM_GROUPS,
  isDisplayItemShown,
  setDisplayChoice,
  setDisplayItemShown,
  type DisplayChoice,
  type DisplayChoiceKey,
  type DisplayItemGroup,
} from "../lib/board-card.ts";
import {
  PREVIEW_PIPELINE_RUN,
  PREVIEW_RESIDENT,
  PREVIEW_WORKFLOW_RUN,
  previewSession,
} from "../lib/board-card-preview.ts";
import { CARD_SHORTCUT_KEYS, cardShortcutChord } from "../lib/card-shortcuts.ts";
import { useUiConfig } from "../lib/uiConfig.ts";
import { ConversationHeaderPreview } from "./ConversationHeaderPreview.tsx";
import { SessionTile } from "./layouts/SessionTile.tsx";
import { Tooltip } from "./Tooltip.tsx";
import { WorkingIndicatorPreview } from "./WorkingIndicatorPreview.tsx";

/**
 * What a session draws about itself, as a checklist the operator owns.
 *
 * A board card draws two dozen distinct things and every one of them used to be
 * compulsory. This panel is the list, and `lib/board-card.ts` is the registry this,
 * `SessionTile` and `ConsoleDetail` all read - so a new item is added there or it ships
 * un-toggleable, which is the contract `test/board-card-items.test.ts` enforces.
 *
 * One section per distinct group present in the registry, rather than one hard-coded
 * section. That is what let the console detail's `PATH`/`BRANCH` band become optional as
 * entries in the SAME array, with its section appearing here without this file being
 * restructured; a group with no entries draws nothing, so a third surface would section
 * itself the same way.
 *
 * Every group is a customizer of its own, with its own preview beside it, and each preview
 * moves only with its own group's controls: the board card beside the card's items, the
 * console header beside the conversation's, and a working conversation beside the working
 * indicator's. A single picture beside every checklist would sit next to controls that do
 * not move it - which is how the conversation's Task type picker used to read, as a set of
 * radios that changed nothing on screen.
 *
 * No props and no effects, like `DispatchSettingsPanel`: `useUiConfig()` is synchronous
 * with shipped defaults, so the anchor and every control are present on the first paint
 * and the static render harness in `test/settings-search.test.ts` can hand this nothing.
 */

/** The preview mounts one tile; a single stamp keeps its "last seen" from ticking. */
function usePreviewSession(): ReturnType<typeof previewSession> {
  return useMemo(() => previewSession(Date.now()), []);
}

/**
 * One style choice, as a segmented radio group: every option is visible at once, so the
 * operator compares the styles by name rather than opening a menu to find them. The
 * preview beside each group's checklist draws the style, so picking one moves it.
 */
function ChoicePicker<K extends DisplayChoiceKey>({
  choice,
}: {
  choice: DisplayChoice<K>;
}): React.JSX.Element {
  const value = useUiConfig()[choice.key];
  const name = `display-choice-${choice.key}`;
  return (
    <div className="display-choice">
      <span className="settings-toggle-text">
        <span className="settings-toggle-label">{choice.label}</span>
        <span className="settings-toggle-desc">{choice.description}</span>
      </span>
      {/* Named with its section as well as its label: both surfaces offer a "Task type", and
          two radio groups announcing the same name - each with an "Off" - could not be told
          apart by anyone not looking at the headings above them. */}
      <div
        className="display-choice-options"
        role="radiogroup"
        aria-label={`${DISPLAY_GROUP_COPY[choice.group].heading}: ${choice.label}`}
      >
        {choice.options.map((option) => (
          <Tooltip key={option.id} label={option.description}>
            <label className={`display-choice-option${value === option.id ? " is-on" : ""}`}>
              <input
                type="radio"
                name={name}
                value={option.id}
                checked={value === option.id}
                onChange={() => setDisplayChoice(choice.key, option.id)}
              />
              {option.label}
            </label>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}

/**
 * One group of the panel: its heading, its checklist and the preview that answers it.
 *
 * Laid out as three grid areas rather than two columns, so the preview has somewhere to go
 * when the panel is too narrow to hold it beside the checklist: under the group's own
 * heading, where it is still read before the controls it answers, rather than after the
 * last of them where nobody scrolls to look.
 */
function GroupCustomizer({
  group,
  hidden,
  showHeading,
  preview,
}: {
  group: DisplayItemGroup;
  hidden: readonly string[];
  /**
   * Whether this group names itself.
   *
   * While the registry had exactly one group the panel's own `<h3>` already named it, and
   * a sub-heading repeating "Board card" under "Board card" would have been noise. Several
   * groups have entries now, so each says itself apart - and the answer is still derived
   * from how many groups there are rather than hard-coded per group.
   */
  showHeading: boolean;
  preview: React.ReactNode;
}): React.JSX.Element | null {
  const items = DISPLAY_ITEMS.filter((item) => item.group === group);
  if (items.length === 0) return null;
  const copy = DISPLAY_GROUP_COPY[group];
  return (
    <div className="board-card-customizer">
      <div className="board-card-group-head">
        {showHeading && <h4 className="settings-subhead">{copy.heading}</h4>}
        <p className="settings-hint settings-blurb">{copy.blurb}</p>
      </div>
      <div className="board-card-checklist">
        {DISPLAY_CHOICES.filter((choice) => choice.group === group).map((choice) => (
          <ChoicePicker key={choice.key} choice={choice} />
        ))}
        {items.map((item) => {
          const on = isDisplayItemShown(hidden, item.id);
          return (
            <label key={item.id} className={`settings-toggle${on ? " is-on" : ""}`}>
              <Tooltip label={on ? `Stop drawing ${item.label}` : `Draw ${item.label} again`}>
                {/* Named explicitly, unlike the single-toggle panels above this one. A
                    checkbox inside a `<label>` takes the label's WHOLE text as its
                    accessible name, and these labels carry a sentence of consequence prose
                    each - so without this, eleven checkboxes announce eleven paragraphs and
                    none of them is distinguishable by its item. The prose stays reachable as
                    the description, which is what it is. */}
                <input
                  type="checkbox"
                  aria-label={item.label}
                  checked={on}
                  onChange={(e) => setDisplayItemShown(hidden, item.id, e.target.checked)}
                />
              </Tooltip>
              <span className="settings-toggle-text">
                <span className="settings-toggle-label">{item.label}</span>
                <span className="settings-toggle-desc">{item.description}</span>
              </span>
            </label>
          );
        })}
      </div>
      {/* `inert` is what makes each picture a preview rather than the thing itself: the
          session behind it does not exist, so its stretched open button, its pickers, its
          workflow disclosure and its reply box must not be reachable by pointer or by
          keyboard. One attribute on the host, rather than a "disabled" prop threaded through
          every control inside it, which would be a preview-shaped fork of the very
          components these previews exist to render honestly. */}
      <div className="board-card-preview">
        <span className="board-card-preview-cap" aria-hidden>
          Preview
        </span>
        <div className="board-card-preview-stage" inert>
          {preview}
        </div>
      </div>
    </div>
  );
}

export function BoardCardPanel(): React.JSX.Element {
  const config = useUiConfig();
  const hidden = config.hiddenDisplayItems;
  const session = usePreviewSession();
  const groups = DISPLAY_ITEM_GROUPS.filter((group) =>
    DISPLAY_ITEMS.some((item) => item.group === group),
  );
  // One picture per group, keyed so a group added to the registry does not compile until it
  // says what it shows. Each moves only with its own group's controls.
  const previews: Record<DisplayItemGroup, React.ReactNode> = {
    // The REAL `SessionTile` against a fixture rather than a picture of one: a picture would
    // be a second source of truth for the thing being configured, and it would drift on the
    // first change to the tile.
    card: (
      <SessionTile
        session={session}
        onOpen={() => {}}
        draggingRepo={null}
        onDropped={() => {}}
        onDropError={() => {}}
        onDropConfirm={() => {}}
        workflowRun={PREVIEW_WORKFLOW_RUN}
        workflowStageDetail="summary"
        pipelineRun={PREVIEW_PIPELINE_RUN}
        // The first slot, because a preview card is the first card. On the real board
        // this comes from the session's position (`lib/card-shortcuts.ts`); there is no
        // board here, so the fixture states the position the way it states the goal and
        // the branch - otherwise the Jump shortcut checkbox would be the one control in
        // this panel that looks identical checked and unchecked.
        shortcutChord={cardShortcutChord(CARD_SHORTCUT_KEYS[0])}
        resident={PREVIEW_RESIDENT}
      />
    ),
    // The same fixture session, so the header and the card above it describe one session.
    conversation: (
      <ConversationHeaderPreview
        session={session}
        kindStyle={config.taskKindHeader}
        showPath={isDisplayItemShown(hidden, "detailPath")}
        showBranch={isDisplayItemShown(hidden, "detailBranch")}
      />
    ),
    working: (
      <WorkingIndicatorPreview
        pinned={isDisplayItemShown(hidden, "workingPinned")}
        progressBar={isDisplayItemShown(hidden, "workingProgressBar")}
      />
    ),
  };
  return (
    <section className="settings-section" data-anchor="display/board-card">
      <div className="settings-section-head">
        {/* Names the surfaces this section governs, not just the first of them. The
            anchor stays `display/board-card` - it is what the settings index, two e2e
            specs and any bookmarked deep link point at, and renaming an anchor to match a
            heading is how a jump becomes a jump to nothing. */}
        <h3>Session display</h3>
      </div>

      <div className="board-card-customizers">
        {groups.map((group) => (
          <GroupCustomizer
            key={group}
            group={group}
            hidden={hidden}
            showHeading={groups.length > 1}
            preview={previews[group]}
          />
        ))}
      </div>

      <p className="settings-hint">
        These are the runtime and context facts a session states. The flags that ask for you -
        a draft or escalated note, a review, a queued turn, a pull request, an Inspector
        verdict, a recurring mission, an ensemble - are always drawn and are not on this
        list, so no setting here can make a session that needs you look like one that does
        not. The choice is per browser, and a second dashboard tab picks it up on reload.
      </p>
    </section>
  );
}
