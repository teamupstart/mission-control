import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  WORKFLOW_CHECK_SLOTS,
  WORKFLOW_COMMAND_PURPOSE,
  checkCommandRoot,
  formatCheckCommand,
  parseCheckCommand,
  workflowCommandFact,
  WORKFLOW_COMMAND_UNKNOWN,
} from "@shared/workflow.ts";
import type {
  WorkflowCheckSlot,
  WorkflowCommandOverride,
  WorkflowCommandView,
} from "@shared/workflow.ts";
import { fetchRepos, fetchWorkflowRepoAllowlist, resolveRepo } from "../lib/api.ts";
import { RepoCombobox } from "../components/RepoCombobox.tsx";
import { RepositoryName } from "../components/RepositoryName.tsx";
import { Tooltip } from "../components/Tooltip.tsx";
import { workflowRequest, WorkflowApiError } from "./workflowApi.ts";
import {
  WorkflowConfirmModal,
  type WorkflowConfirmRequest,
} from "./WorkflowConfirmModal.tsx";

/**
 * The Global Command catalog, as a Library authoring surface: what each portable workflow
 * slot runs on this machine, and where that is not true.
 *
 * Structurally the Persona and SessionAction libraries - fixed rail on the left, one editor
 * on the right, a local draft, a discard guard and a compare-and-swap save - because an
 * operator who has navigated one should not have to learn a third shape. What is different
 * is that the rail is CLOSED: four built-in slots ship with the product, so there is no New,
 * no duplicate, no archive, and no empty state. A slot nobody has configured is still a row.
 *
 * It reads the catalog off the SSE stream through `MissionState` and writes through the
 * dedicated `/api/workflow-commands/:slot` route. There is no second fetch of the catalog
 * and no legacy `checkCommands` write anywhere in this file: one durable authority, reached
 * one way.
 *
 * Nothing here executes anything. Saving a Command stores an argv; a workflow reaching the
 * slot in a Trust-granted repository is what runs it, later, in a commit-pinned checkout.
 */

/** The editor's local draft: the default as TYPED text, and the override rows as argv. */
export interface CommandDraft {
  /** Blank means "no global default", which is `null` on the wire and never an empty argv. */
  defaultText: string;
  overrides: WorkflowCommandOverride[];
}

/**
 * Override rows in the order the daemon returns them: `repo_root ASC` under SQLite's binary
 * collation.
 *
 * Matched rather than re-invented so a saved draft looks identical to the row that comes
 * back over SSE - otherwise every save would visibly reorder the list. Compared by code unit
 * rather than through `localeCompare`, because the store's `ORDER BY` is not locale-aware
 * and a list sorted two ways is a list that flickers on save.
 */
function byRepoRoot(a: WorkflowCommandOverride, b: WorkflowCommandOverride): number {
  if (a.repoRoot === b.repoRoot) return 0;
  return a.repoRoot < b.repoRoot ? -1 : 1;
}

/** The draft one stored slot opens as. */
export function commandDraftFrom(view: WorkflowCommandView | null): CommandDraft {
  return {
    defaultText: view?.defaultCommand ? formatCheckCommand(view.defaultCommand) : "",
    overrides: (view?.overrides ?? []).map((entry) => ({
      repoRoot: entry.repoRoot,
      command: [...entry.command],
    })),
  };
}

/**
 * Whether the draft says anything the stored slot does not.
 *
 * The default is compared as PARSED argv rather than as text, so trailing whitespace and a
 * re-quoted-but-identical line are not unsaved changes an operator has to answer a dialog
 * about. A line that does not parse is dirty by definition - it cannot equal any stored
 * argv - which is the honest answer while it is still being typed.
 */
export function commandDraftDirty(draft: CommandDraft, view: WorkflowCommandView | null): boolean {
  const parsed = parseCheckCommand(draft.defaultText);
  const nextDefault = draft.defaultText.trim() === ""
    ? null
    : parsed.ok ? parsed.argv : null;
  const storedDefault = view?.defaultCommand ?? null;
  if (draft.defaultText.trim() !== "" && !parsed.ok) return true;
  if (JSON.stringify(nextDefault) !== JSON.stringify(storedDefault)) return true;
  return JSON.stringify([...draft.overrides].sort(byRepoRoot))
    !== JSON.stringify((view?.overrides ?? []).map((entry) => ({
      repoRoot: entry.repoRoot,
      command: [...entry.command],
    })));
}

/**
 * The draft as the update body Phase 1's route accepts, or the sentence saying why it is not
 * one yet.
 *
 * Both fields are always present, because the route replaces a slot's COMPLETE state in one
 * compare-and-swap: omitting `overrides` would clear every exception, and omitting
 * `defaultCommand` would clear the machine-wide command. There is no partial save to make.
 *
 * Pure and exported: a static render cannot type into the box, so this is the only place the
 * blank-means-null rule and the parse refusal are assertable.
 */
export function commandUpdateBody(
  draft: CommandDraft,
  expectedRevision: number,
): { ok: true; body: { expectedRevision: number; defaultCommand: string[] | null; overrides: WorkflowCommandOverride[] } }
  | { ok: false; error: string } {
  const line = draft.defaultText.trim();
  let defaultCommand: string[] | null = null;
  if (line !== "") {
    const parsed = parseCheckCommand(draft.defaultText);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    defaultCommand = parsed.argv;
  }
  return {
    ok: true,
    body: {
      expectedRevision,
      defaultCommand,
      overrides: [...draft.overrides].sort(byRepoRoot),
    },
  };
}

/**
 * What the editor should do when the streamed view, its baseline and a held conflict are
 * compared - the whole synchronization decision, as one pure function.
 *
 * Extracted because the interesting cases cannot be reached by rendering: they are races
 * between a compare-and-swap refusal and an SSE delivery, and every one of them is a way to
 * lose an operator's typing or strand them in a retry loop.
 *
 * The rule is that **the stream is only ever adopted when it is NEWER than what this editor
 * already holds, and a conflict is only retired when the stream has caught up to the
 * revision that conflict names.** Those are two different questions, and conflating them is
 * what a comparison against the baseline alone does: a 409 is the server saying a newer
 * revision exists, and the stream still sitting at the baseline says nothing about whether
 * that is still true. It is not merely stale - it is an answer to a different question.
 */
export interface CommandSyncState {
  /** The slot as the live catalog has it, or null before the snapshot. */
  selected: WorkflowCommandView | null;
  /** The revision the open draft was taken from. */
  baseline: WorkflowCommandView | null;
  /** A newer committed view already being held, from a refusal or an earlier delivery. */
  conflict: WorkflowCommandView | null;
  dirty: boolean;
}

export type CommandSync =
  /** Leave everything alone. */
  | { kind: "idle" }
  /** Follow the stream: replace the baseline and the draft with this view. */
  | { kind: "adopt"; view: WorkflowCommandView }
  /** Hold this newer view for the operator to decide about. */
  | { kind: "conflict"; view: WorkflowCommandView }
  /** The conflict is over - the stream reached the revision it named. */
  | { kind: "resolved" };

export function commandSync({ selected, baseline, conflict, dirty }: CommandSyncState): CommandSync {
  if (!selected) return { kind: "idle" };
  // `<=`, not `===`, and the difference is a bug of its own: after Load newer the baseline is
  // the REFUSAL's view, which the stream has not delivered yet, so it sits BEHIND. Treating
  // only equality as "nothing to do" would adopt that older streamed view a render later and
  // silently undo the adoption the operator just asked for.
  if (baseline && selected.revision <= baseline.revision) {
    return conflict && selected.revision >= conflict.revision
      ? { kind: "resolved" }
      : { kind: "idle" };
  }
  if (!dirty) return { kind: "adopt", view: selected };
  // Whichever committed view is newer. A refusal can name a revision two saves ahead of the
  // one the stream has managed to deliver, and offering the older of the two as "the newer
  // revision" would hand the operator a Load newer that still cannot be saved over.
  return {
    kind: "conflict",
    view: conflict && conflict.revision > selected.revision ? conflict : selected,
  };
}

/**
 * The paths the override picker offers: the allowlisted repositories first, then the rest of
 * the workspace scan, de-duplicated and each listed once.
 *
 * Moved here with the editor it belongs to. Two reasons it is not simply the workspace list
 * the dispatch form offers. A Command only ever RUNS in a repository granted the Workflows
 * cell in Trust - an override anywhere else passes with a note - so those are the useful
 * answers and they lead. And the allowlist holds resolved roots from anywhere on disk, while
 * `/api/repos` scans the workspace roots only, so a repository granted from outside them is
 * absent from that scan entirely: offered nowhere, the one repository a Command can run in
 * would still have to be typed from memory.
 *
 * Order-preserving rather than sorted, because the leading group is the claim being made.
 */
export function commandRepoOptions(
  workspaceRepos: readonly string[],
  allowlist: readonly string[],
): string[] {
  return [...new Set([...allowlist, ...workspaceRepos])];
}

/** `Revision 3 · updated <date>`, or the honest answer for a slot nobody has saved yet. */
export function commandRevisionLine(view: WorkflowCommandView | null): string {
  // The same sentence every other Command surface uses for an absent view, through the same
  // constant: "the daemon has not said" is one state and deserves one wording.
  if (!view) return WORKFLOW_COMMAND_UNKNOWN;
  if (view.revision <= 1 && view.defaultCommand === null && view.overrides.length === 0) {
    return "Never configured on this machine";
  }
  return `Revision ${view.revision} · updated ${new Date(view.updatedAt).toLocaleString()}`;
}

/** The typed line, split the way the daemon will split it - or the refusal, said early. */
function argvPreview(line: string): string {
  if (line.trim() === "") return "Leave this empty for no machine-wide default.";
  const parsed = parseCheckCommand(line);
  return parsed.ok
    ? `Runs as: ${parsed.argv.map((arg, index) => `${index + 1}. ${arg}`).join("   ")}`
    : parsed.error;
}

function isSlot(value: string | null): value is WorkflowCheckSlot {
  return value !== null && (WORKFLOW_CHECK_SLOTS as readonly string[]).includes(value);
}

export function CommandLibrary({
  commands,
  hasSnapshot = false,
  initialSlot = null,
  onDirtyChange,
  onSelectionChange,
}: {
  /** The live catalog, four entries in slot order. Never fetched again here. */
  commands: WorkflowCommandView[];
  /**
   * Whether the SSE snapshot has landed. Without it an unconfigured slot and an unread one
   * look identical, and this editor would invite an operator to type over a command that is
   * about to arrive.
   */
  hasSnapshot?: boolean;
  /** The slot the ROUTE asked for, read once as this surface mounts. */
  initialSlot?: string | null;
  onDirtyChange: (dirty: boolean) => void;
  onSelectionChange?: (slot: string | null) => void;
}): React.JSX.Element {
  const [selectedSlot, setSelectedSlot] = useState<WorkflowCheckSlot>(
    () => (isSlot(initialSlot) ? initialSlot : WORKFLOW_CHECK_SLOTS[0]),
  );
  const bySlot = useMemo(
    () => new Map(commands.map((view) => [view.slot, view])),
    [commands],
  );
  const selected = bySlot.get(selectedSlot) ?? null;

  /**
   * The stored slot this draft was taken FROM, held rather than re-read.
   *
   * It is what dirtiness is measured against and what the save's expected revision comes
   * from, and both have to survive a newer revision arriving over SSE while the operator is
   * typing - which is precisely the case the conflict below exists for.
   */
  const [baseline, setBaseline] = useState<WorkflowCommandView | null>(selected);
  const [draft, setDraft] = useState<CommandDraft>(() => commandDraftFrom(selected));
  /** A revision that landed while this draft was dirty. Never applied silently. */
  const [conflict, setConflict] = useState<WorkflowCommandView | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<WorkflowConfirmRequest | null>(null);
  const [overridePath, setOverridePath] = useState("");
  const [overrideCommand, setOverrideCommand] = useState("");
  const [repos, setRepos] = useState<string[]>([]);
  const [allowlist, setAllowlist] = useState<string[]>([]);

  const dirty = commandDraftDirty(draft, baseline);

  const adopt = useCallback((view: WorkflowCommandView | null): void => {
    setBaseline(view);
    setDraft(commandDraftFrom(view));
    setConflict(null);
    setError(null);
  }, []);

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  /**
   * A slot the ROUTE moved to while this surface stayed mounted.
   *
   * Selecting from the rail rewrites the hash through `replaceState` and builds no history
   * entry, so that is not what this is for. It is for the three moves a bookmarkable page
   * actually receives: a pasted link into the tab already here, a followed link, and Back or
   * Forward across two `#/library/commands/<slot>` entries. All three are same-document, so
   * React keeps this component and the `useState` initializer does not run again - and
   * without this the address bar would name `lint` while the editor went on showing `test`,
   * which is the deep link failing at the one job it has.
   *
   * Honoured on the EDGE of the routed value, the way `PersonaLibrary` honours `startNew`,
   * and that is load-bearing rather than stylistic: comparing `routedSlot` against
   * `selectedSlot` instead would fire the instant the operator picked a row in the rail -
   * `selectedSlot` moves first and the route follows a render later - and snap the selection
   * straight back to where it came from.
   *
   * No discard guard here, deliberately. A hash change that leaves a dirty draft is already
   * held by the router's own gate, which puts the address bar back and asks; this runs only
   * once that gate has let the route through. Asking again would be a second dialog about a
   * discard the operator has just answered for - the same reason `replaceLibrarySelection`
   * bypasses the gate in the other direction.
   */
  const routedSlot = isSlot(initialSlot) ? initialSlot : null;
  const routedRef = useRef(routedSlot);
  useEffect(() => {
    if (routedSlot === routedRef.current) return;
    routedRef.current = routedSlot;
    if (!routedSlot || routedSlot === selectedSlot) return;
    setSelectedSlot(routedSlot);
    adopt(bySlot.get(routedSlot) ?? null);
    setOverridePath("");
    setOverrideCommand("");
  }, [adopt, bySlot, routedSlot, selectedSlot]);

  /**
   * What is open, reported however it came to be open. See `PersonaLibrary`.
   *
   * `routedSlot` is a dependency as well as `selectedSlot`, and it is there for the case the
   * selection alone cannot see: a hash arriving with no usable slot on it - `#/library/commands`
   * itself, or `/deploy`, which the router drops to the same thing. The editor rightly keeps
   * what it had open, so `selectedSlot` does not move and an effect keyed on it alone would
   * never fire, leaving the address bar naming the shelf while the screen shows `lint`. Re-
   * reporting stamps what is actually open back onto the hash. It cannot loop: `replace`
   * returns early once the hash already says that.
   */
  useEffect(
    () => onSelectionChange?.(selectedSlot),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- routedSlot is a trigger, not a read
    [onSelectionChange, routedSlot, selectedSlot],
  );

  /**
   * A newer revision of the OPEN slot, adopted when nothing is at stake and surfaced when
   * something is.
   *
   * A clean draft is a mirror, so it follows the daemon - which is what makes a save in
   * another window show up here. A dirty one is the operator's typing, and overwriting it
   * with somebody else's save would be this feature losing work silently; the conflict
   * banner is offered instead, and it is their decision.
   *
   * The decision itself is `commandSync`, which is where the reasoning and the tests live.
   * `conflict` is a dependency because it is now read rather than only written: this cannot
   * loop, because every branch settles on a value the next pass returns `idle` for.
   *
   * `dirty` is derived from `draft` and `baseline`, both of which are dependencies through
   * it; listing it directly is what makes "became clean, then a revision arrives" adopt.
   */
  useEffect(() => {
    const next = commandSync({ selected, baseline, conflict, dirty });
    if (next.kind === "adopt") adopt(next.view);
    else if (next.kind === "conflict") setConflict(next.view);
    else if (next.kind === "resolved") setConflict(null);
  }, [adopt, baseline, conflict, dirty, selected]);

  // Index the workspace's repositories so an override's path can be picked rather than typed
  // from memory, and lead with the ones Trust has granted the Workflows cell - the only
  // places a Command can actually run. Both are read ONCE: a workspace scan and a consent
  // grant move about as often as the app itself, and a poll beside the SSE stream would be a
  // fetch loop bought for a picker.
  useEffect(() => {
    let alive = true;
    void fetchRepos().then((list) => {
      if (alive) setRepos(list);
    });
    void fetchWorkflowRepoAllowlist().then((list) => {
      if (alive) setAllowlist(list);
    });
    return () => { alive = false; };
  }, []);

  function guardDiscard(what: string, action: () => void): void {
    if (!dirty) {
      action();
      return;
    }
    setConfirm({
      title: "Discard unsaved Command changes",
      body: `The editor has changes that have not been saved. ${what} discards them.`,
      confirmLabel: "Discard changes",
      confirmHint: "Throw the unsaved edits away and continue",
      danger: true,
      onConfirm: action,
    });
  }

  function select(slot: WorkflowCheckSlot): void {
    if (slot === selectedSlot) return;
    guardDiscard(`Opening the ${slot} Command`, () => {
      setSelectedSlot(slot);
      adopt(bySlot.get(slot) ?? null);
      setOverridePath("");
      setOverrideCommand("");
    });
  }

  async function addOverride(): Promise<void> {
    const typed = overridePath.trim();
    if (!typed || saving) return;
    const parsed = parseCheckCommand(overrideCommand);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const resolved = await resolveRepo(typed);
      if (!resolved.ok) {
        setError(resolved.error);
        return;
      }
      // The TYPED path when it is inside the repository, not the resolved root. Resolving is
      // lossy in exactly the direction that matters - `/repo/packages/web` resolves to
      // `/repo` - so storing the root alone would make a nested override unconfigurable.
      const root = checkCommandRoot(resolved.repoRoot, resolved.path);
      setDraft((current) => ({
        ...current,
        // Replace rather than append on a repeat: `(slot, repoRoot)` is one identity, and the
        // route refuses a duplicate outright rather than picking one for us.
        overrides: [
          ...current.overrides.filter((entry) => entry.repoRoot !== root),
          { repoRoot: root, command: parsed.argv },
        ].sort(byRepoRoot),
      }));
      setOverridePath("");
      setOverrideCommand("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not resolve repository");
    } finally {
      setSaving(false);
    }
  }

  function removeOverride(repoRoot: string): void {
    setDraft((current) => ({
      ...current,
      overrides: current.overrides.filter((entry) => entry.repoRoot !== repoRoot),
    }));
  }

  async function save(): Promise<void> {
    if (!baseline || saving) return;
    const body = commandUpdateBody(draft, baseline.revision);
    if (!body.ok) {
      setError(body.error);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = await workflowRequest<WorkflowCommandView>(
        `/api/workflow-commands/${selectedSlot}`,
        { method: "PUT", body: JSON.stringify(body.body) },
      );
      adopt(saved);
    } catch (caught) {
      if (caught instanceof WorkflowApiError && caught.status === 409) {
        // The refusal carries the committed view, so the conflict banner can offer the
        // newer revision rather than telling the operator to reload and find it themselves.
        const current = caught.body?.current as WorkflowCommandView | undefined;
        if (current) setConflict(current);
        setError(
          "Another window saved this Command first. Your typing is untouched - load the newer "
          + "revision, or save again to write over it.",
        );
      } else {
        setError(caught instanceof Error ? caught.message : "Could not save this Command");
      }
    } finally {
      setSaving(false);
    }
  }

  /** Write the held draft onto the revision that now exists, rather than the one it started on. */
  function reapply(): void {
    if (conflict) setBaseline(conflict);
    setConflict(null);
    setError(null);
  }

  const preview = argvPreview(draft.defaultText);
  const parsedOverride = overrideCommand.trim() === "" ? null : parseCheckCommand(overrideCommand);

  return (
    <section className="wf-command-library">
      <aside className="wf-command-sidebar" aria-label="Command library">
        <div className="wf-command-sidebar-head">
          <div>
            <h3>Commands</h3>
            <p>Four built-in slots</p>
          </div>
        </div>
        <div className="wf-command-list">
          {WORKFLOW_CHECK_SLOTS.map((slot) => {
            const view = bySlot.get(slot) ?? null;
            return (
              <Tooltip key={slot} label={`Set what the ${slot} Command runs on this machine`}>
                <button
                  className={`wf-command-list-item${selectedSlot === slot ? " active" : ""}`}
                  aria-current={selectedSlot === slot ? "true" : undefined}
                  onClick={() => select(slot)}
                >
                  <span className="wf-command-list-name">
                    <span>{slot}</span>
                    <em className="wf-command-list-tag">Built-in</em>
                  </span>
                  <small>{WORKFLOW_COMMAND_PURPOSE[slot]}</small>
                  <small className="wf-command-list-meta">
                    {workflowCommandFact(view, hasSnapshot)}
                  </small>
                </button>
              </Tooltip>
            );
          })}
        </div>
      </aside>

      <div className="wf-command-workspace">
        <article className="wf-command-editor">
          <header className="wf-command-editor-head">
            <div>
              <p className="workflow-eyebrow">Built-in Command slot</p>
              <h3>{selectedSlot}</h3>
              {/* While a conflict is held, this says which revision the DRAFT is against.
                  `commandRevisionLine` describes the stored slot, and a slot nobody had
                  configured before the other window saved would otherwise read "Never
                  configured on this machine" directly under a banner announcing r2. */}
              <p className="wf-command-revision">
                {conflict
                  ? `Editing revision ${baseline?.revision ?? 1}`
                  : commandRevisionLine(baseline)}
              </p>
            </div>
            <div className="wf-command-actions">
              <Tooltip
                label={dirty
                  ? "Replace this slot's default and overrides together"
                  : "No unsaved changes"}
              >
                <button
                  className="btn"
                  disabled={!baseline || saving || !dirty}
                  onClick={() => void save()}
                >
                  {saving ? "Saving…" : "Save Command"}
                </button>
              </Tooltip>
            </div>
          </header>

          {/* The one execution note on this surface. Stated once, beside the form, rather than
              repeated around every input: what is authorized is a machine-wide choice made in
              Settings and a per-repository grant made in Trust, and repeating it here would
              imply this box is a third gate. */}
          <p className="wf-command-note">
            {WORKFLOW_COMMAND_PURPOSE[selectedSlot]}{" "}
            Saving stores an argv - it runs nothing. A workflow reaching the{" "}
            <code>{selectedSlot}</code> Command runs it later, without a shell, in a
            commit-pinned checkout of a repository granted the Workflows cell in Trust.
          </p>

          {conflict && (
            <p className="wf-command-conflict" role="status">
              A newer revision (r{conflict.revision}) of this Command exists. Your typing has
              not been changed.{" "}
              <Tooltip label="Discard your unsaved edits and load the newer revision">
                <button className="btn btn-ghost" onClick={() => adopt(conflict)}>
                  Load newer
                </button>
              </Tooltip>
              <Tooltip label={`Write your edits onto revision ${conflict.revision}`}>
                <button className="btn btn-ghost" onClick={reapply}>
                  Keep mine
                </button>
              </Tooltip>
            </p>
          )}
          {error && <p className="wf-error" role="alert">{error}</p>}

          <section className="wf-command-section">
            <h4>Default command</h4>
            <p className="wf-command-hint">
              Repository-neutral: this is what the <code>{selectedSlot}</code> Command runs
              wherever no override below matches, at the root of the checkout. Leave it empty
              and the slot passes with a note instead of running.
            </p>
            <div className="wf-command-default-row">
              <label className="sr-only" htmlFor="workflow-command-default">
                Default command
              </label>
              <input
                id="workflow-command-default"
                className="field-input"
                value={draft.defaultText}
                placeholder="npm test"
                spellCheck={false}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  defaultText: event.target.value,
                }))}
              />
              <Tooltip label="Remove the machine-wide default for this Command">
                <button
                  className="btn btn-ghost"
                  disabled={draft.defaultText === ""}
                  onClick={() => setDraft((current) => ({ ...current, defaultText: "" }))}
                >
                  Clear
                </button>
              </Tooltip>
            </div>
            {/* The parsed argv, shown back. There is no shell anywhere in this path, so the
                split is ours and an operator has to be able to SEE it rather than trust it -
                `npm run test -- --grep "a b"` is four arguments or six depending on a rule
                nobody can read off the box they typed into. */}
            <p className="wf-command-preview">{preview}</p>
          </section>

          <section className="wf-command-section">
            <h4>Overrides</h4>
            <p className="wf-command-hint">
              Exceptions, and they should stay rare. A repository listed here runs its own
              command instead of the default; give a <strong>subdirectory</strong> to override
              one package of a monorepo, and the command runs in that directory. The longest
              matching path wins.
            </p>
            {draft.overrides.length === 0 ? (
              // Which of the two empty states this is. "Every repository uses the default
              // above" is only true when there IS one - on a fresh slot it describes
              // configuration that does not exist, to the operator most likely to believe it.
              <p className="wf-command-empty">
                {draft.defaultText.trim() === ""
                  ? "No exceptions, and no default - every repository skips this Command and "
                    + "passes with a note."
                  : "No exceptions - every repository uses the default above."}
              </p>
            ) : (
              <ul className="wf-command-override-list">
                {draft.overrides.map((entry) => (
                  <li key={entry.repoRoot}>
                    <code className="wf-command-override-root">
                      <RepositoryName path={entry.repoRoot} />
                    </code>
                    <code className="wf-command-override-path">{entry.repoRoot}</code>
                    <code className="wf-command-override-argv">
                      {formatCheckCommand(entry.command)}
                    </code>
                    <Tooltip label={`Stop overriding the ${selectedSlot} Command in ${entry.repoRoot}`}>
                      <button
                        className="btn btn-ghost"
                        disabled={saving}
                        onClick={() => removeOverride(entry.repoRoot)}
                      >
                        Remove
                      </button>
                    </Tooltip>
                  </li>
                ))}
              </ul>
            )}
            <div className="wf-command-override-add">
              <label className="sr-only" htmlFor="workflow-command-override-path">
                Repository path
              </label>
              <RepoCombobox
                id="workflow-command-override-path"
                repos={commandRepoOptions(repos, allowlist)}
                value={overridePath}
                onChange={setOverridePath}
                disabled={saving}
                placeholder="/path/to/repository (or a subdirectory)"
              />
              <label className="sr-only" htmlFor="workflow-command-override-command">
                Override command
              </label>
              <input
                id="workflow-command-override-command"
                className="field-input"
                value={overrideCommand}
                placeholder="pnpm -C . test"
                spellCheck={false}
                onChange={(event) => setOverrideCommand(event.target.value)}
              />
              <Tooltip label="Add this exception to the draft - Save writes it">
                <button
                  className="btn"
                  disabled={saving || !overridePath.trim() || !overrideCommand.trim()}
                  onClick={() => void addOverride()}
                >
                  Add override
                </button>
              </Tooltip>
            </div>
            {parsedOverride && (
              <p className="wf-command-preview">
                {parsedOverride.ok
                  ? `Runs as: ${parsedOverride.argv.map((arg, index) => `${index + 1}. ${arg}`).join("   ")}`
                  : parsedOverride.error}
              </p>
            )}
          </section>

          <p className="wf-command-hint wf-command-save-note">
            Save replaces this slot's default and its whole override list together, so the two
            halves can never be stored apart.
          </p>
        </article>
      </div>

      {confirm && <WorkflowConfirmModal request={confirm} onClose={() => setConfirm(null)} />}
    </section>
  );
}
