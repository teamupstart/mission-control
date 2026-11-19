import { useState } from "react";
import { MAX_TASK_EXTRA_REPOS } from "@shared/task.ts";
import { RepoCombobox } from "./RepoCombobox.tsx";
import { RepositoryName } from "./RepositoryName.tsx";
import { Tooltip } from "./Tooltip.tsx";

/**
 * Secondary repositories attached beside a primary one: a chip per repository with its Detach
 * button, then **+ Add another repo**, which opens a picker and **Attach**.
 *
 * The one control for attaching repositories, shared by Dispatch's single-agent form and the
 * resident surfaces, so the accessible names an operator (and every e2e spec) reaches them by
 * cannot drift between the two. The primary stays its own field outside this control: it is
 * the session's working directory, never the first of a list of chips.
 *
 * `canAttach` hides the adder without hiding the chips. A harness that cannot hold write
 * access beyond its cwd stops offering new attachments, but the ones already made stay on
 * screen with their Detach buttons, so the refusal beside them names something the operator
 * can act on.
 */
export function AttachedRepoChips({
  primary,
  attached,
  repos,
  onChange,
  canAttach = true,
  disabled = false,
  className = "",
  attachLabel = "Attach this repo to the task",
}: {
  primary: string;
  attached: readonly string[];
  repos: string[];
  onChange: (next: string[]) => void;
  canAttach?: boolean;
  disabled?: boolean;
  className?: string;
  /** The Attach button's tooltip: what the attachment is attached to. */
  attachLabel?: string;
}): React.JSX.Element {
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState("");
  const candidate = value.trim();
  // The same bound every request surface enforces: a ninth attachment would only be refused on
  // save or launch. Detach stays available, so a full set can always be changed.
  const full = attached.length >= MAX_TASK_EXTRA_REPOS;
  const fullLabel = `At most ${MAX_TASK_EXTRA_REPOS} repos can be attached; detach one to attach another`;
  return (
    <div className={`repo-chips${className ? ` ${className}` : ""}`}>
      {attached.map((root, index) => (
        <span key={`${root}-${index}`} className="repo-chip">
          {/* The full path through the app's own tooltip, never a native `title` -
              `tooltip-coverage.test.ts` enforces that, and it is what makes the
              shortened chip readable without a browser-styled box. */}
          <RepositoryName path={root} className="repo-chip-name" />
          <Tooltip label="Detach this repo">
            <button
              type="button"
              className="dep-chip-x"
              aria-label={`Detach repo: ${root}`}
              disabled={disabled}
              onClick={() => onChange(attached.filter((_, i) => i !== index))}
            >
              ✕
            </button>
          </Tooltip>
        </span>
      ))}
      {!canAttach ? null : adding ? (
        <div className="repo-chip-add">
          <RepoCombobox
            repos={repos}
            value={value}
            placeholder="repo to attach…"
            disabled={disabled}
            onChange={setValue}
          />
          <Tooltip label={full ? fullLabel : attachLabel}>
            <button
              type="button"
              className="dep-add"
              aria-label="Attach repo"
              // Refuses the obviously redundant entry - the same path as the primary, or
              // one already attached. Deliberately STRING equality and nothing cleverer:
              // only the daemon resolves a path to a repo's main checkout, so it stays
              // the one authority on whether two spellings are one repo, and a second
              // half-implementation of that rule here would be a source of truth that
              // could disagree with it.
              disabled={
                disabled
                || full
                || !candidate
                || candidate === primary.trim()
                || attached.includes(candidate)
              }
              onClick={() => {
                onChange([...attached, candidate]);
                setValue("");
                setAdding(false);
              }}
            >
              Attach
            </button>
          </Tooltip>
        </div>
      ) : (
        <Tooltip label={full ? fullLabel : "Work across several repos in one session - each changed repo gets its own PR"}>
          <button
            type="button"
            className="dep-add"
            aria-label="Add another repo"
            disabled={disabled || full}
            onClick={() => setAdding(true)}
          >
            + Add another repo
          </button>
        </Tooltip>
      )}
    </div>
  );
}
