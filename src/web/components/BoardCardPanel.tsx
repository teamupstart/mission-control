import { useMemo } from "react";

import {
  DISPLAY_GROUP_COPY,
  DISPLAY_ITEMS,
  DISPLAY_ITEM_GROUPS,
  isDisplayItemShown,
  setDisplayItemShown,
  type DisplayItemGroup,
} from "../lib/board-card.ts";
import { PREVIEW_WORKFLOW_RUN, previewSession } from "../lib/board-card-preview.ts";
import { useUiConfig } from "../lib/uiConfig.ts";
import { SessionTile } from "./layouts/SessionTile.tsx";
import { Tooltip } from "./Tooltip.tsx";

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
 * The preview beside the checklist is a board card, and only the board card's items move
 * it. That is honest rather than incomplete: the console detail is a full-height pane and
 * a thumbnail of one would say less than the sentence each conversation item already
 * carries.
 *
 * No props and no effects, like `DispatchSettingsPanel`: `useUiConfig()` is synchronous
 * with shipped defaults, so the anchor and every control are present on the first paint
 * and the static render harness in `test/settings-search.test.ts` can hand this nothing.
 */

/** The preview mounts one tile; a single stamp keeps its "last seen" from ticking. */
function usePreviewSession(): ReturnType<typeof previewSession> {
  return useMemo(() => previewSession(Date.now()), []);
}

function ItemSection({
  group,
  hidden,
  showHeading,
}: {
  group: DisplayItemGroup;
  hidden: readonly string[];
  /**
   * Whether this section names itself.
   *
   * While the registry had exactly one group the panel's own `<h3>` already named it, and
   * a sub-heading repeating "Board card" under "Board card" would have been noise. Two
   * groups have entries now, so both sections say themselves apart - and the answer is
   * still derived from how many sections there are rather than hard-coded per group.
   */
  showHeading: boolean;
}): React.JSX.Element | null {
  const items = DISPLAY_ITEMS.filter((item) => item.group === group);
  if (items.length === 0) return null;
  const copy = DISPLAY_GROUP_COPY[group];
  return (
    <>
      {showHeading && <h4 className="settings-subhead">{copy.heading}</h4>}
      <p className="settings-hint settings-blurb">{copy.blurb}</p>
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
    </>
  );
}

export function BoardCardPanel(): React.JSX.Element {
  const hidden = useUiConfig().hiddenDisplayItems;
  const session = usePreviewSession();
  const groups = DISPLAY_ITEM_GROUPS.filter((group) =>
    DISPLAY_ITEMS.some((item) => item.group === group),
  );
  return (
    <section className="settings-section" data-anchor="display/board-card">
      <div className="settings-section-head">
        {/* Names the two surfaces this section governs, not just the first of them. The
            anchor stays `display/board-card` - it is what the settings index, two e2e
            specs and any bookmarked deep link point at, and renaming an anchor to match a
            heading is how a jump becomes a jump to nothing. */}
        <h3>Session display</h3>
      </div>

      <div className="board-card-customizer">
        <div className="board-card-checklist">
          {groups.map((group) => (
            <ItemSection
              key={group}
              group={group}
              hidden={hidden}
              showHeading={groups.length > 1}
            />
          ))}
        </div>

        {/* The answer, in place. This is the one panel in Display whose entire subject is
            what a card looks like, so it mounts the REAL `SessionTile` against a fixture
            rather than drawing a picture of one - a picture would be a second source of
            truth for the thing being configured, and it would drift on the first change
            to the tile.

            `inert` is what makes it a preview rather than a card: the session behind it
            does not exist, so its stretched open button, its permission-mode picker and
            its workflow disclosure must not be reachable by pointer or by keyboard. One
            attribute on the host, rather than a "disabled" prop threaded through the tile
            and every control inside it, which would be a preview-shaped fork of the very
            component this preview exists to render honestly. */}
        <div className="board-card-preview">
          <span className="board-card-preview-cap" aria-hidden>
            Preview
          </span>
          <div className="board-card-preview-stage" inert>
            <SessionTile
              session={session}
              onOpen={() => {}}
              draggingRepo={null}
              onDropped={() => {}}
              onDropError={() => {}}
              onDropConfirm={() => {}}
              workflowRun={PREVIEW_WORKFLOW_RUN}
              workflowStageDetail="summary"
            />
          </div>
        </div>
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
