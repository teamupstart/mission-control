import { useRef, useState } from "react";
import { Tooltip } from "../components/Tooltip.tsx";
import { useLibraryPopover } from "./useLibraryPopover.ts";

/**
 * The workspace header shared by the Library authoring surfaces: who this asset is on the
 * left, exactly one promoted verb on the right, everything else behind a menu.
 *
 * The fault: Save, Copy Markdown, Download .md and Duplicate rendered as four peers next to
 * Archive, so the row said all five were equally likely to be what you came for. They are
 * not. On an editable Persona exactly one of them is the reason the screen is open, and on
 * a built-in Save was permanently disabled while Duplicate - the only verb that does
 * anything at all - sat third in a row of ghosts. A header with one promoted verb is not a
 * tidier version of that; it is the first version that states which verb this screen is for.
 *
 * The menu holds the rest rather than dropping it. Nothing here removes an action, changes
 * what one does, or changes its accessible name - `Copy Markdown` is still `Copy Markdown`,
 * one click further in.
 */

export interface LibraryMenuAction {
  /** Stable within one menu; used as the React key only. */
  id: string;
  /** The accessible name. Unchanged from wherever the action lived before. */
  label: string;
  /** The tooltip - what this does, in the same voice as every other control. */
  hint: string;
  disabled?: boolean;
  /** Destructive. Archive is the only one today. */
  danger?: boolean;
  /**
   * Stay open after this one runs.
   *
   * For an action whose entire feedback is on its own row: Copy Markdown flips to `Copied`
   * for a few seconds, and a menu that closed on the click would take the confirmation with
   * it - leaving a control that gives no sign it did anything, which is the defect
   * `useCopyFeedback` exists to prevent.
   */
  keepOpen?: boolean;
  onSelect: () => void;
}

export interface LibraryPrimaryAction {
  label: string;
  hint: string;
  disabled?: boolean;
  onClick: () => void;
}

/**
 * The menu's rows, split out from the popover so they are reachable by a
 * `renderToStaticMarkup` test - which never runs an effect and so can never open the real
 * menu. The same split, for the same reason, as `OpenInList` under `OpenInMenu`.
 */
export function LibraryMenuList({
  actions,
  onChoose,
}: {
  actions: readonly LibraryMenuAction[];
  onChoose: (action: LibraryMenuAction) => void;
}): React.JSX.Element {
  return (
    <>
      {actions.map((action) => (
        <Tooltip key={action.id} label={action.hint}>
          <button
            type="button"
            role="menuitem"
            className={`lib-menu-row${action.danger ? " is-danger" : ""}`}
            disabled={action.disabled}
            onClick={() => onChoose(action)}
          >
            {action.label}
          </button>
        </Tooltip>
      ))}
    </>
  );
}

export function LibraryOverflowMenu({
  label,
  actions,
}: {
  /** The trigger's accessible name, and the menu's. `More Persona actions`. */
  label: string;
  actions: readonly LibraryMenuAction[];
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const popover = useLibraryPopover({
    open,
    onClose: () => setOpen(false),
    popoverRef,
    triggerRef,
  });

  // A `⋯` with nothing behind it is a control that punishes the one person who tries it.
  if (actions.length === 0) return null;

  function onKeyDown(event: React.KeyboardEvent): void {
    popover.onKeyDown(event);
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = [
      ...(popoverRef.current?.querySelectorAll<HTMLButtonElement>(".lib-menu-row") ?? []),
    ].filter((row) => !row.disabled);
    if (rows.length === 0) return;
    event.preventDefault();
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    rows[(at + step + rows.length) % rows.length]?.focus({ preventScroll: true });
  }

  return (
    // The host wraps the trigger too - see `useLibraryPopover`.
    <div className="lib-menu" onKeyDown={onKeyDown}>
      {/* The tooltip names what is inside rather than repeating the button's own label: a
          `⋯` whose only description is "more actions" tells you nothing you could not see. */}
      <Tooltip label={actions.map((action) => action.label).join(", ")}>
        <button
          ref={triggerRef}
          type="button"
          className={`lib-menu-btn${open ? " is-open" : ""}`}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={label}
          onClick={() => setOpen((value) => !value)}
        >
          <span aria-hidden>⋯</span>
        </button>
      </Tooltip>
      {open && (
        <div
          ref={popoverRef}
          className="lib-menu-pop"
          role="menu"
          aria-label={label}
          tabIndex={-1}
        >
          <LibraryMenuList
            actions={actions}
            onChoose={(action) => {
              if (!action.keepOpen) setOpen(false);
              action.onSelect();
            }}
          />
        </div>
      )}
    </div>
  );
}

export function LibraryWorkspaceHeader({
  className,
  titleClassName,
  title,
  subtitle,
  meta,
  primary,
  primaryRef,
  menuLabel,
  actions = [],
}: {
  /** The surface's own header class, which existing CSS and the e2e evidence crop use. */
  className: string;
  /**
   * The surface's own class for the identity block. A `<section>` rather than a `<div>`
   * because the Persona screen's block is `persona-fields` - it holds the asset's editable
   * scalar fields, and four Playwright specs scope `getByLabel("Name")` to it.
   */
  titleClassName?: string;
  /** The asset's name, and any tag that qualifies it. Editable on a writable asset. */
  title: React.ReactNode;
  /** One quiet line under the name - a Persona's description. */
  subtitle?: React.ReactNode;
  /** The dim provenance line: revision, and where the guidance was read from. */
  meta?: React.ReactNode;
  /** The one verb this screen is for. Absent only where no verb is promotable. */
  primary?: LibraryPrimaryAction;
  /**
   * A semantic ref the owning surface may attach to that promoted button.
   *
   * Five surfaces render this header, so which one a guided tour means is the caller's to
   * say. Absent everywhere else, and the button's element, class, label, disabled state, and
   * tooltip are identical either way.
   */
  primaryRef?: React.Ref<HTMLButtonElement>;
  menuLabel: string;
  actions?: readonly LibraryMenuAction[];
}): React.JSX.Element {
  return (
    <header className={`lib-work-head ${className}`}>
      <section className={`lib-work-title${titleClassName ? ` ${titleClassName}` : ""}`}>
        {title}
        {subtitle}
        {meta}
      </section>
      <div className="lib-work-actions">
        {primary && (
          <Tooltip label={primary.hint}>
            <button
              className="btn"
              ref={primaryRef}
              disabled={primary.disabled}
              onClick={primary.onClick}
            >
              {primary.label}
            </button>
          </Tooltip>
        )}
        <LibraryOverflowMenu label={menuLabel} actions={actions} />
      </div>
    </header>
  );
}
