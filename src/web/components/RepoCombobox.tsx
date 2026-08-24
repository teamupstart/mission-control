import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { repoLeaf } from "../lib/format.ts";
import { Tooltip } from "./Tooltip.tsx";

/**
 * A themed combobox for a repo path. Replaces the native <datalist>, whose
 * dropdown is browser-chrome and can't be styled to match the dark UI. Filters
 * the known repos as you type, with arrow/enter/click selection and a dropdown
 * that inherits the app's tokens.
 *
 * Shared: the dispatch form picks a base with it, and the Foreman settings panel
 * picks a repo to trust with it. Both want the same thing - "one of the repos I
 * know, or a path I type" - so it lives here rather than inside either caller.
 *
 * The dropdown is rendered in a body-level portal with fixed positioning, so it
 * escapes any scrollable ancestor: absolutely-positioned, it was clipped by the
 * settings pane's `overflow-y: auto` no matter its z-index.
 *
 * It is exactly as wide as its input, and that is a constraint on CALLERS rather than
 * a limitation here. Sizing the list to its content instead was tried and reverted: it
 * fixed a narrow settings row by making the list overhang the dispatch modal's right
 * edge, which this component cannot know the bounds of. Give the field room in its own
 * layout (`.wf-settings-check-add` and `.ts-add .foreman-repo-add` are the worked
 * examples) rather than letting the menu escape it.
 *
 * That width is why a row draws the checkout's NAME rather than its path - see
 * `repoOptionLabels`. It does not make the constraint go away: a name is short, but a
 * settings column that gives this field a third of 300px will still ellipsize one.
 *
 * Every optional prop is a fact the caller alone knows, and they fall into two
 * groups. Three are what a settings ROW needs and a modal field does not: which
 * sentence the empty box should say, whether the row it sits in is mid-write, and
 * the id an `sr-only` `<label htmlFor>` names - a label outside the widget cannot
 * reach the input by containment the way the dispatch form's wrapping `<label>`
 * does. Three more are what a caller DRIVING this field needs, each because the
 * fact in question stops at this boundary otherwise: which gesture produced a write
 * (`onPick`), that an Escape was swallowed in here (`onEscape`), and where to put
 * the caret (`inputRef`). The guided dispatch pass is the one caller with all
 * three; they are inert for the two callers that pass none.
 */

/**
 * The repos a query offers: by name, and by path only when no name matches.
 *
 * A plain substring match over the whole path is what this used to do, and it made the first
 * keystroke worth nothing. Every checkout in a workspace shares a long leading prefix -
 * `/Users/you/workspace/` is 28 characters on its own - so `a`, `e`, `o`, `r` and `s` each match
 * every path there is, and the list an operator is trying to narrow comes back the length it
 * started. Matching the NAME is what makes typing useful, and it is what the name is for.
 *
 * The full path is a fallback rather than a second mode, which is one rule instead of two and
 * covers both things a name match cannot reach: a typed absolute path resolves (no basename
 * holds a `/`, so nothing matched by name and the fallback takes it), and so does the parent
 * directory an operator files by - `~/work/acme/api` is still found by `acme`. Nothing that
 * used to be findable stopped being findable. What changed is what comes back FIRST when both
 * could, and that is the whole complaint.
 *
 * Exported, and pure, because it is the one part of this widget a test can hold still - the
 * same split `filterSessionFiles` keeps in `FilePicker`.
 */
export function filterRepos(repos: readonly string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...repos];
  const byName = repos.filter((r) => repoLeaf(r).toLowerCase().includes(q));
  return byName.length > 0 ? byName : repos.filter((r) => r.toLowerCase().includes(q));
}

/**
 * What each offered repo is CALLED in the list, and what (if anything) has to be said
 * beside it to tell it from another row.
 *
 * The list used to draw the whole path in every row, which is precisely the thing an
 * operator cannot read: repos under one workspace root share a long leading prefix, the
 * menu is only as wide as its input, and the ellipsis therefore lands AFTER the shared
 * part and BEFORE the directory name - so eight rows come back reading
 * `/Users/jordanma…` and the one fact that distinguishes them is the part that got cut.
 * The name is what an operator picks by, so the name is what the row leads with; the
 * full path stays in the row's tooltip and in the input's own value, which is still the
 * absolute path this widget writes.
 *
 * **Nothing here is ever a path**, including the hint. Two checkouts can share a basename
 * (`~/a/api` and `~/b/api`), so a name alone is not always an identity - and where it is
 * not, the row carries ONE MORE FOLDER NAME rather than the directory it sits in spelled
 * out. A first pass did print that directory, and the case that killed it is the one a
 * fixture reaches first: under a temp root the two rows read
 * `/private/var/folders/1c/djbypfjn…/workspace/alpha`, which is the exact wall of shared
 * prefix this function exists to get rid of, reintroduced one line lower.
 *
 * WHICH folder is chosen rather than assumed. The immediate parent is the usual answer and
 * the one to picture, but `~/x/shared/api` and `~/y/shared/api` both sit in `shared`, so a
 * hint fixed at one level would print the same word on both rows and disambiguate nothing.
 * So the colliding group walks up together and stops at the first ancestor level whose
 * names are all different, and every row in that group is labelled from that same level -
 * one level for the group, so two rows are always comparing like with like.
 *
 * A row with no folder at that level carries NO HINT, rather than something standing in for
 * one. `/api` beside `/srv/api` is the case: the second is `api` under `srv`, the first is
 * `api` under nothing, and printing `/` for it would be a path on a row that must not hold
 * one. Where a group cannot be separated at any level the walk simply ends and the hints are
 * whatever the immediate parent gives - a weaker answer, and still never a path. The full
 * path is one hover away, and that is what the tooltip is for.
 *
 * Computed against the OFFERED set rather than the whole known list: a collision the
 * current query has already filtered away is not one the operator can see, and hinting it
 * anyway would put a second line on rows that do not need one.
 *
 * Exported and pure for the same reason `filterRepos` is - it is the part of this widget
 * a test can hold still.
 */
export function repoOptionLabels(
  repos: readonly string[],
): { repo: string; name: string; hint: string | null }[] {
  const groups = new Map<string, string[]>();
  for (const r of repos) {
    const name = repoLeaf(r);
    const group = groups.get(name);
    if (group) group.push(r);
    else groups.set(name, [r]);
  }

  const hints = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const segments = group.map((r) => r.replace(/\/+$/, "").split("/").filter(Boolean));
    // How far up the shallowest member of the group can be asked to go. `- 1` because the
    // last segment is the name itself, which is the thing that already matched.
    const reach = Math.max(...segments.map((s) => s.length - 1));
    let level = 1;
    for (let up = 1; up <= reach; up++) {
      const names = segments.map((s) => ancestor(s, up));
      if (new Set(names).size === names.length) {
        level = up;
        break;
      }
    }
    group.forEach((repo, i) => {
      // A checkout sitting at the filesystem root has no folder above it to be named by, so
      // it gets NO hint rather than a stand-in. `/` was that stand-in and it is a path, not
      // a folder name - which is the one thing a row here may never draw. The row is still
      // the more distinguishable of the pair for it: one `api` carries a folder and the
      // other carries nothing, which is itself the difference between them.
      const hint = ancestor(segments[i]!, level);
      if (hint) hints.set(repo, hint);
    });
  }

  return repos.map((repo) => ({
    repo,
    name: repoLeaf(repo),
    hint: hints.get(repo) ?? null,
  }));
}

/**
 * The name of the folder `up` levels above a checkout, or null once the walk runs out.
 *
 * Null rather than a placeholder, because every non-null answer this returns is rendered and
 * the invariant is that a rendered label is a FOLDER NAME. There is no string that stands in
 * for "no folder" without breaking that - `/` was tried and it is a path.
 *
 * Null also participates in the distinctness test above, and correctly: two rows that both
 * ran out at the same level are not told apart by it and the walk continues, while one that
 * ran out beside one that did not is genuinely distinguishable and the walk can stop.
 */
function ancestor(segments: string[], up: number): string | null {
  return segments[segments.length - 1 - up] ?? null;
}

/** Gap in px between the input and the dropdown. */
const LIST_GAP = 4;
/** Tallest the dropdown ever gets, when the viewport has room for it. */
const LIST_MAX_HEIGHT = 220;
/** Breathing room kept between the dropdown and the viewport's bottom edge. */
const VIEWPORT_MARGIN = 8;

export function RepoCombobox({
  repos,
  value,
  onChange,
  onPick,
  onEscape,
  id,
  inputRef: externalInputRef,
  placeholder = "search repos or type a path…",
  disabled = false,
}: {
  repos: string[];
  value: string;
  onChange: (v: string) => void;
  /**
   * A repo was taken FROM THE LIST - clicked, or ↵ on the highlighted row - rather than typed.
   *
   * `onChange` fires either way and cannot tell the two apart, and a caller that has to is the
   * guided dispatch pass: taking a row from this list ANSWERS its Repo question and moves it
   * on, whereas typing a fifth character is still deciding. Every write still goes through
   * `onChange`; this only says which gesture produced one.
   */
  onPick?: (repo: string) => void;
  /**
   * Escape was SWALLOWED here, closing the list instead of reaching the dialog around it.
   *
   * That swallowing is deliberate and predates any caller (an open list over half a form must
   * not let one press close the whole thing), which leaves a caller with its own meaning for
   * Escape unable to see the press at all - the guided dispatch pass, whose Repo question ends
   * on the same press that dismisses this list. Announcing it here rather than letting that
   * caller read the key on the way down is not a preference: taking it early ends the pass
   * mid-dispatch, which moves the caret out of this field, and the blur closes this list before
   * the handler below runs - so the press reaches the dialog after all and closes it.
   *
   * Fires only when the press was actually taken. An Escape that falls through - the list was
   * already shut - is not reported, because nothing here happened to it.
   */
  onEscape?: () => void;
  /** Set when an `sr-only <label htmlFor>` outside the widget names this input. */
  id?: string;
  /**
   * The input itself, for a caller that has to put the caret in it - the guided pass, whose
   * Repo step is a question whose control is this field. Additive: a caller that does not
   * pass one gets the ref this widget has always held internally.
   */
  inputRef?: React.RefObject<HTMLInputElement | null>;
  placeholder?: string;
  /** A row mid-write. The list closes with the input rather than floating over a dead field. */
  disabled?: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{
    top: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const ownInputRef = useRef<HTMLInputElement>(null);
  const inputRef = externalInputRef ?? ownInputRef;
  const listRef = useRef<HTMLUListElement>(null);

  const matches = filterRepos(repos, value);
  // Names, plus one disambiguating folder name on the rows a name alone cannot tell apart.
  // Derived from `matches` and not from `repos`, so the hint answers the list on screen.
  const options = repoOptionLabels(matches);
  // Nothing to offer once the text already equals the only remaining match. `disabled` is
  // read here too, but only to cover the single render before the effect below lands: it
  // stops a live dropdown being painted over a field that has just stopped taking input.
  // Suppressing the render is NOT what keeps it shut - see that effect.
  const showList =
    open && !disabled && matches.length > 0 && !(matches.length === 1 && matches[0] === value);

  // Track the input so the portaled list stays glued to it. The scroll listener
  // captures, so an ancestor pane scrolling - not just the window - repositions.
  useLayoutEffect(() => {
    if (!showList) return;
    function place(): void {
      const r = inputRef.current?.getBoundingClientRect();
      if (!r) return;
      const top = r.bottom + LIST_GAP;
      // Fixed means the list can't be scrolled into view, so cap it to the room
      // below the input rather than letting it hang off the viewport's edge.
      const room = window.innerHeight - top - VIEWPORT_MARGIN;
      setPos({ top, left: r.left, width: r.width, maxHeight: Math.min(LIST_MAX_HEIGHT, room) });
    }
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [showList]);

  // Collapse when focus/click leaves the widget. The list is portaled outside
  // rootRef, so it has to count as "inside" or picking an option would close
  // the dropdown before the choice registered.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent): void {
      const t = e.target as Node;
      if (!rootRef.current?.contains(t) && !listRef.current?.contains(t)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // A row that goes busy CLOSES the list, rather than merely stopping it being drawn.
  // Hiding it on `disabled` alone leaves `open` true underneath, so the dropdown comes
  // back by itself the moment the row is enabled again - over a field nobody touched.
  //
  // The click-away closer above does not cover this, and the settings row is the case
  // that proves it: its submit button can be reached by the KEYBOARD, and an activation
  // that way dispatches click with no mousedown, so nothing tells this widget the pointer
  // ever left. Measured before this effect existed: type a repo, activate Add command
  // without a pointer, and when the write lands the list reappears with all 202 options -
  // full width, because a successful add clears the field and an empty field matches
  // every repo.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  // Keep the highlighted row in range as the match list shrinks.
  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, matches.length - 1)));
  }, [matches.length]);

  // Keep the highlighted row visible while arrowing through a long repo list.
  useEffect(() => {
    if (!showList) return;
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [active, showList]);

  function choose(r: string): void {
    onChange(r);
    onPick?.(r);
    setActive(0);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!showList) setOpen(true);
      else setActive((a) => Math.min(a + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      if (!showList) return;
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      if (showList && matches[active]) {
        e.preventDefault();
        choose(matches[active]);
      }
    } else if (e.key === "Escape" && open) {
      // Close only the dropdown; keep the surrounding modal/popover open. The caller hears
      // about it through `onEscape`, which is the only way it can - this press stops here.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      onEscape?.();
    }
  }

  return (
    <div className="combobox" ref={rootRef}>
      <input
        ref={inputRef}
        id={id}
        className="field-input mono"
        role="combobox"
        aria-expanded={showList}
        aria-autocomplete="list"
        placeholder={placeholder}
        disabled={disabled}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        // Focus leaving the widget closes it, which the click-away effect above cannot do on
        // its own: it listens for a mousedown, and focus moves without one every time the
        // keyboard is what is driving. The case that made this visible is ⇥ out of the guided
        // pass's Repo question - the caret jumps to the task box and, before this, left a
        // dropdown hanging over the form nobody could dismiss without reaching for the mouse.
        // Choosing an option does not blur: its mousedown is prevented for exactly that reason.
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {showList &&
        pos &&
        createPortal(
          <ul
            className="combobox-list"
            role="listbox"
            ref={listRef}
            style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxHeight }}
          >
            {options.map(({ repo, name, hint }, i) => (
              <Tooltip key={repo} label={repo}>
                <li
                  role="option"
                  aria-selected={i === active}
                  className={`combobox-option${i === active ? " is-active" : ""}`}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => {
                    // Pick before the input's blur fires, so the click registers.
                    e.preventDefault();
                    choose(repo);
                  }}
                >
                  <span className="combobox-option-name">{name}</span>
                  {hint && <span className="combobox-option-hint">{hint}</span>}
                </li>
              </Tooltip>
            ))}
          </ul>,
          document.body,
        )}
    </div>
  );
}
