import { useRef, useState } from "react";
import { Tooltip } from "../components/Tooltip.tsx";
import { useLibraryPopover } from "./useLibraryPopover.ts";

/**
 * One property of the open asset, as a chip that answers its own question while shut.
 *
 * What it replaces on the Persona screen: a five-field metadata block, roughly 120px tall,
 * in which the two fields that matter (provider, model) looked exactly like the two that
 * were read-only, and none of them said whether the value shown was something this Persona
 * CHANGES or something it merely inherits. That is the one question the block existed to
 * answer, and reading it meant opening a `select` to see whether "App default" was picked.
 *
 * So the state is in the drawing. An inherited chip is quiet - a value the app decided, of
 * no interest until you want to override it. An overridden chip is solid - this asset says
 * something the defaults do not. Scanning the row tells you what this Persona actually does
 * differently, which is what "what does this Persona override" means and what nobody could
 * previously see without opening two controls.
 *
 * A chip with no `children` is a readout rather than a control, and draws as one (dashed,
 * no caret, not focusable): the effective source and the guidance byte count are facts
 * about the asset, not settings on it, and a chip that opened an empty popover would be a
 * worse lie than a label.
 */

export type LibraryChipState =
  /** The value comes from the app defaults. Quiet: this asset is not the one deciding it. */
  | "inherited"
  /** This asset carries an explicit value. Solid: it is a thing the asset says. */
  | "overridden";

export function LibraryPropertyChips({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return <div className="lib-props">{children}</div>;
}

export function LibraryPropertyChip({
  name,
  value,
  mono = false,
  state,
  tone,
  align,
  tooltip,
  controlLabel,
  children,
}: {
  /** The property, lower-case: `provider`, `model`, `source`. The chip's key half. */
  name: string;
  /** The resolved value, as the operator would say it. */
  value: string;
  /** Draw the value in the mono face - for a model id, a path, a byte count. */
  mono?: boolean;
  /** Omitted for a read-only readout, which has no inherited/overridden axis at all. */
  state?: LibraryChipState;
  /**
   * `danger` is the over-limit byte count, which keeps the treatment the toolbar gave it.
   *
   * `attention` is a value that is stored and STANDING but that this build cannot honour -
   * an Action retaining a completion whose adapter is unavailable here. It is a tone rather
   * than a separate `state` because the inherited/overridden axis is still true of it and
   * still worth reading: the chip says both "this asset decides this" and "something about
   * it needs you". The explanation belongs beside the row, in `.lib-props-note`, because a
   * fact you have to open a popover to discover is the one this row exists to replace.
   */
  tone?: "danger" | "attention";
  /** `end` pushes this chip to the far edge, away from the properties that lead the row. */
  align?: "end";
  tooltip: string;
  /**
   * The accessible name of the popover this chip opens. Required whenever `children` are
   * passed: a disclosure that opens an unnamed region is a control announced as "expanded"
   * with nothing said about what it expanded into.
   */
  controlLabel?: string;
  /**
   * The asset's real control, moved into the popover rather than reimplemented in it. The
   * chip is a way of REACHING a control, so validation, accessible names and change
   * semantics stay exactly where they were.
   */
  children?: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const popover = useLibraryPopover({
    open,
    onClose: () => setOpen(false),
    popoverRef,
    triggerRef,
  });

  const classes = [
    "lib-chip",
    children ? `is-${state ?? "inherited"}` : "is-readonly",
    tone ? `is-${tone}` : "",
    align === "end" ? "is-trailing" : "",
  ].filter(Boolean).join(" ");

  const face = (
    <>
      <span className="lib-chip-k">{name}</span>
      <span className={`lib-chip-v${mono ? " mono" : ""}`}>{value}</span>
    </>
  );

  if (!children) {
    return (
      <Tooltip label={tooltip}>
        <span className={classes}>{face}</span>
      </Tooltip>
    );
  }

  return (
    // The host wraps the trigger too, so a mouse click - which leaves focus on the chip -
    // still has Escape land here rather than on the page ladder behind it.
    <div
      className={`lib-chip-host${align === "end" ? " is-trailing" : ""}`}
      onKeyDown={popover.onKeyDown}
    >
      <Tooltip label={tooltip}>
        <button
          ref={triggerRef}
          type="button"
          className={`${classes}${open ? " is-open" : ""}`}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {face}
          <span className="lib-chip-caret" aria-hidden />
        </button>
      </Tooltip>
      {open && (
        // `role="group"`, deliberately not `dialog` and not `menu`. It holds form controls,
        // so `menu` would announce the wrong interaction model - and `role="dialog"` is
        // what `test/overlay-registry.test.ts` reserves for surfaces that route through
        // `Overlay`, which a chip popover is not and should not become.
        <div
          ref={popoverRef}
          className="lib-chip-pop"
          role="group"
          aria-label={controlLabel}
          tabIndex={-1}
        >
          {children}
        </div>
      )}
    </div>
  );
}
