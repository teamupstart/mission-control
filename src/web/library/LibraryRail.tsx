import { Tooltip } from "../components/Tooltip.tsx";

/**
 * The rail primitives every Library authoring surface draws its asset list from.
 *
 * The fault they exist for: the rail listed every asset flat, so the four Personas that
 * ship with the build read as things the operator wrote, and each row's sub-label was the
 * description - which on most rows is the title again in a longer sentence. A rail is a
 * place to TELL TWO ROWS APART, and neither half of it was doing that.
 *
 * So a group head says whose the rows under it are, and a row's sub-label carries the one
 * or two facts that actually distinguish it. What those facts ARE is the surface's business
 * - the resolved runner and model for a Persona, skill and completion for an Action - which
 * is why `detail` is a string the caller composes rather than anything derived here.
 *
 * Phases 3 and 4 consume both. They may extend them with props; they must not fork them or
 * restyle them locally.
 */

export interface LibraryRailTag {
  label: string;
  /**
   * `attention` marks a fact waiting on the operator, `system` marks an application-owned
   * identity, and `quiet`, the default, is provenance trivia that is never acted on.
   */
  tone?: "quiet" | "attention" | "system";
}

/**
 * One group of rows, with the count of what is drawn beneath it.
 *
 * The count is of the rows actually rendered rather than of everything that exists, so it
 * stays true while a search narrows the list - a head reading "Built-in 4" over one visible
 * row is a defect report, not a summary.
 *
 * A fragment rather than a wrapper element: the list is a flex column whose gap sets the
 * rhythm between rows, and boxing each group would put a second, different gap inside it.
 * The head pins itself with `position: sticky` against the list's own scroll instead.
 */
export function LibraryRailGroup({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <>
      <h4 className="lib-rail-group">
        <span>{label}</span>
        <span className="lib-rail-group-count">{count}</span>
      </h4>
      {children}
    </>
  );
}

export function LibraryRailRow({
  className,
  name,
  detail,
  detailLines = 1,
  tags = [],
  selected,
  tooltip,
  onSelect,
}: {
  /**
   * The surface's own row class, carrying the master-detail row styling the three rails
   * already share in `styles.css`. It travels with the caller rather than being replaced by
   * one shared name because `test/builtin-personas-web.test.ts` counts Persona rail rows by
   * `persona-list-item`, and that count is about built-in shadowing rather than about this
   * redesign - it has no business changing here.
   */
  className: string;
  name: string;
  /**
   * The facts that tell this row from the one under it. Never the description: on a Persona
   * it restates the name, and four rows of restated names are a list you have to open to
   * read.
   */
  detail: string;
  /**
   * How many lines the sub-label may take before it is clipped. One by default.
   *
   * A prop rather than each rail reaching in and restyling `.lib-rail-row-detail` from its
   * own selector, which is the fork this file's header forbids: an override written as
   * `.wf-action-list-item .lib-rail-row-detail` outranks any rule the primitive later grows,
   * so the primitive would silently stop reaching one of its own rows. Here the two arms
   * are side by side and a third would have to be decided here too.
   *
   * Two is what the Actions rail needs: `Skill · pull-request · Pull request is opened and
   * verified` is 51 characters against a Persona's 25, so one clipped line lost the
   * completion half of the contract on every row - half of the fact the sub-label exists to
   * carry. It stays CLAMPED at two, so a long skill id cannot push one row taller than its
   * neighbours.
   */
  detailLines?: 1 | 2;
  tags?: readonly LibraryRailTag[];
  selected: boolean;
  tooltip: string;
  onSelect: () => void;
}): React.JSX.Element {
  return (
    <Tooltip label={tooltip}>
      <button
        // The surface class leads: `test/builtin-personas-web.test.ts` counts Persona rail
        // rows with a literal `class="persona-list-item`, and that count is about built-in
        // shadowing rather than about this redesign.
        className={`${className} lib-rail-row${selected ? " active" : ""}`}
        // The rail is a list of destinations and one of them is open. `aria-current` is how
        // that is announced; the `active` class only draws it.
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
      >
        <span className="lib-rail-row-name">
          <span>{name}</span>
          {tags.map((tag) => (
            <em
              key={tag.label}
              className={`lib-rail-tag${tag.tone === "attention" ? " is-attention" : tag.tone === "system" ? " is-system" : ""}`}
            >
              {tag.label}
            </em>
          ))}
        </span>
        <small
          className={`lib-rail-row-detail mono${detailLines === 2 ? " is-two-line" : ""}`}
        >
          {detail}
        </small>
      </button>
    </Tooltip>
  );
}
