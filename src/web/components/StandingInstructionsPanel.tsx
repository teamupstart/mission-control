import { useEffect, useState } from "react";
import { STANDING_INSTRUCTIONS_MAX_LENGTH } from "@shared/standing-instructions.ts";
import { fetchRepos } from "../lib/api.ts";
import { REACH_EXCLUSIONS, reachPairs } from "../lib/standing-instructions-view.ts";
import { DEFAULT_CARD } from "../standing-instructions-reconcile.ts";
import type {
  StandingInstructionsCard,
  StandingInstructionsState,
} from "../useStandingInstructions.ts";
import { RepoCombobox } from "./RepoCombobox.tsx";
import { RepositoryName } from "./RepositoryName.tsx";
import { Tooltip } from "./Tooltip.tsx";

/** `291 / 8,000`, the counter under every box. */
function Counter({ value }: { value: string }): React.JSX.Element {
  const over = value.length > STANDING_INSTRUCTIONS_MAX_LENGTH;
  return (
    <span className={over ? "si-counter si-counter-over" : "si-counter"}>
      {`${value.length.toLocaleString()} / ${STANDING_INSTRUCTIONS_MAX_LENGTH.toLocaleString()}`}
    </span>
  );
}

function StateChip({ label }: { label: string }): React.JSX.Element {
  return <span className={`si-chip si-chip-${label}`}>{label}</span>;
}

/**
 * Which sessions this text reaches, and when.
 *
 * Not decoration, and not a footnote elsewhere. Any other way of shipping this leaves the
 * operator guessing which sessions actually got the text, and a standing instruction that
 * silently reaches half the fleet is worse than none: it is trusted and wrong. It is stated
 * where the text is written, and per harness AND runtime, because that is the granularity at
 * which the answer differs - the same words are a system-prompt flag on one pair and
 * ordinary turn-one prose on another.
 *
 * The `✓` rows are derived from the harness registry rather than typed out, so shipping a
 * harness cannot leave this block quietly claiming a reach the launch does not deliver. The
 * three rows below them are as required as the five above: each renders an approved product
 * boundary rather than a gap.
 */
function ReachBlock(): React.JSX.Element {
  return (
    <div className="si-reach">
      <h5 className="si-reach-head">Reach</h5>
      <ul className="si-reach-rows">
        {reachPairs().map((pair) => (
          <li key={pair.label} className="si-reach-row">
            <span className="si-reach-glyph si-reach-yes" aria-hidden>✓</span>
            <span className="si-reach-pair">{pair.label}</span>
            <span className="si-reach-channel">{pair.prose.channel}</span>
            <span className="si-reach-detail">{pair.prose.detail}</span>
          </li>
        ))}
        {REACH_EXCLUSIONS.map((row) => (
          <li key={row.subject} className="si-reach-row si-reach-exclusion">
            <span className="si-reach-glyph si-reach-no" aria-hidden>{row.glyph}</span>
            <span className="si-reach-subject">{row.subject}</span>
            <span className="si-reach-note">{row.note}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface RepositoryCardProps {
  card: StandingInstructionsCard;
  state: StandingInstructionsState;
}

function Card(props: RepositoryCardProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return <StandingInstructionsRepositoryCard {...props} open={open} onToggle={() => setOpen((v) => !v)} />;
}

export function StandingInstructionsRepositoryCard({
  card,
  state,
  open,
  onToggle,
}: RepositoryCardProps & { open: boolean; onToggle: () => void }): React.JSX.Element {
  const label = card.key;
  const inConflict = card.theirs !== null || state.conflictCards.includes(card.key);
  return (
    <div className={inConflict ? "si-card si-card-conflict" : "si-card"}>
      <Tooltip label={`Show or hide the standing instructions for ${label}`}>
        <button
          type="button"
          className="si-card-head"
          aria-expanded={open}
          onClick={onToggle}
        >
          <span className="si-disclosure" aria-hidden>{open ? "▾" : "▸"}</span>
          <RepositoryName path={label} className="si-card-name" />
          <StateChip label={card.configured && state.view?.repositories[card.key] ? "appended" : "default"} />
          {card.dirty && <span className="si-chip si-chip-unsaved">unsaved</span>}
        </button>
      </Tooltip>
      {open && (
        <div className="si-card-body">
          <p className="settings-hint">
            Appended after the default for every new session in this repository.
            Leave this empty to keep only the default.
          </p>
          <label className="sr-only" htmlFor={`si-text-${label}`}>
            {`Standing instructions for ${label}`}
          </label>
          <textarea
            id={`si-text-${label}`}
            className="si-textarea"
            rows={8}
            value={card.value}
            onChange={(event) => state.edit(card.key, event.target.value)}
          />
          <div className="si-card-meta">
            <Counter value={card.value} />
            <span className="si-format">markdown</span>
          </div>
          {inConflict && (
            <div className="settings-warn si-conflict">
              <p>
                This repository changed in another window while you were editing. Your text is
                still here and nothing has been written.
              </p>
              <pre className="si-conflict-theirs">{card.theirs ?? "(no repository instructions)"}</pre>
              <div className="si-actions">
                <Tooltip label="Keep the text you typed, on top of the newer document">
                  <button type="button" className="btn" onClick={state.keepMine}>
                    Keep mine
                  </button>
                </Tooltip>
                <Tooltip label="Discard what you typed and show what the daemon now holds">
                  <button type="button" className="btn btn-ghost" onClick={state.takeTheirs}>
                    Take theirs
                  </button>
                </Tooltip>
              </div>
            </div>
          )}
          <ReachBlock />
          <div className="si-actions">
            <Tooltip label={`Save the standing instructions for ${label}, and nothing else`}>
              <button
                type="button"
                className="btn"
                disabled={!card.dirty || state.saving !== null || inConflict}
                onClick={() => void state.save(card.key)}
              >
                {state.saving === card.key ? "Saving…" : "Save"}
              </button>
            </Tooltip>
            <Tooltip label="Throw away the unsaved text and show what is stored">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={!card.dirty}
                onClick={() => state.revert(card.key)}
              >
                Revert
              </button>
            </Tooltip>
            {card.key !== DEFAULT_CARD && (
              <Tooltip
                label={
                  card.configured
                    ? "Remove this entry; the default still applies, along with any matching parent entry"
                    : "This repository has no saved entry to remove"
                }
              >
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={!card.configured || state.saving !== null}
                  onClick={() => void state.removeRepository(card.key)}
                >
                  Remove repository instructions
                </button>
              </Tooltip>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function StandingInstructionsPanel({
  state,
}: {
  state: StandingInstructionsState;
}): React.JSX.Element {
  const [draft, setDraft] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  /**
   * Workspace checkouts, for the combobox, fetched here the way `TrustPanel` fetches its
   * own. Suggestions only: a SUBDIRECTORY is a legitimate key for this feature and will not
   * appear in this list, so the field stays free text and `addRepository` resolves whatever
   * is typed server-side.
   */
  const [repos, setRepos] = useState<string[]>([]);
  useEffect(() => {
    void fetchRepos().then(setRepos);
  }, []);
  const defaultCard = state.cards.find((c) => c.key === DEFAULT_CARD);
  const repoCards = state.cards.filter((c) => c.key !== DEFAULT_CARD);

  const answered = state.view !== null;

  return (
    <section className="settings-section si-settings">
      <p className="settings-hint settings-blurb">
        Your own words, held on <strong>this machine</strong>, sent to every session Mission
        Control opens into a checkout. Unlike <code>AGENTS.md</code> this reaches nobody
        else&rsquo;s machine, and unlike Foreman&rsquo;s instructions it reaches the session
        itself.
      </p>

      {state.error && <p className="settings-error">{state.error}</p>}

      <section className="si-group" data-anchor="standing-instructions/default">
        <div className="settings-section-head">
          <div>
            <h4>Every repository</h4>
            <p className="settings-hint">
              Sent first to every new session, including repositories with their own instructions.
              Leave it empty to send only repository instructions.
            </p>
          </div>
        </div>
        {!answered && (
          <p className="settings-error si-unanswered">
            The daemon has not answered yet, so there is nothing to show or edit here.
          </p>
        )}
        {answered && defaultCard && (
          <div className="si-default">
            <label className="sr-only" htmlFor="si-text-default">
              Standing instructions for every repository
            </label>
            <textarea
              id="si-text-default"
              className="si-textarea"
              rows={6}
              value={defaultCard.value}
              onChange={(event) => state.edit(DEFAULT_CARD, event.target.value)}
            />
            <div className="si-card-meta">
              <Counter value={defaultCard.value} />
              <span className="si-format">markdown</span>
            </div>
            <div className="si-actions">
              <Tooltip label="Save the machine-wide default, and nothing else">
                <button
                  type="button"
                  className="btn"
                  disabled={!defaultCard.dirty || state.saving !== null}
                  onClick={() => void state.save(DEFAULT_CARD)}
                >
                  {state.saving === DEFAULT_CARD ? "Saving…" : "Save"}
                </button>
              </Tooltip>
              <Tooltip label="Throw away the unsaved text and show what is stored">
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={!defaultCard.dirty}
                  onClick={() => state.revert(DEFAULT_CARD)}
                >
                  Revert
                </button>
              </Tooltip>
            </div>
          </div>
        )}
      </section>

      <section className="si-group" data-anchor="standing-instructions/repositories">
        <div className="settings-section-head">
          <div>
            <h4>Repositories</h4>
            <p className="settings-hint">
              Repository instructions are appended after the default.
            </p>
            <p className="settings-hint">
              The longest matching path selects which repository instructions to append,
              so a package entry takes the place of its monorepo entry. The default always applies.
            </p>
          </div>
          {/* STORED rules, not cards drawn. A repository staged from the combobox is on
              screen but nothing is saved for it yet, and counting it would tell the operator
              a rule is in force that no session will ever receive. */}
          <span className="si-count">
            {`${repoCards.filter((c) => c.configured).length} configured`}
          </span>
        </div>

        <div className="si-add">
          <label className="sr-only" htmlFor="si-add-repo">Repository path</label>
          <RepoCombobox
            id="si-add-repo"
            repos={repos}
            value={draft}
            onChange={(v) => {
              setDraft(v);
              setAddError(null);
            }}
            disabled={!answered}
            placeholder="/path/to/repository (or a subdirectory)"
          />
          <Tooltip label="Add a card for this repository - it stores nothing until you save it">
            <button
              type="button"
              className="btn"
              disabled={!draft.trim() || !answered}
              onClick={() => {
                void state.addRepository(draft).then((err) => {
                  setAddError(err);
                  if (!err) setDraft("");
                });
              }}
            >
              Add
            </button>
          </Tooltip>
        </div>
        {addError && <p className="settings-error">{addError}</p>}

        {!answered
          ? (
            <p className="settings-error si-unanswered">
              The daemon has not answered yet, so this is not an empty list - it is an
              unanswered one, and adding a repository now would have nothing to save against.
            </p>
          )
          : repoCards.length === 0
          ? (
            <p className="settings-hint si-empty">
              No repository has a rule of its own. Every session gets the machine-wide default
              above, which is empty unless you write one.
            </p>
          )
          : repoCards.map((card) => <Card key={card.key} card={card} state={state} />)}
      </section>
    </section>
  );
}
