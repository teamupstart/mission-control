import { forwardRef, type ButtonHTMLAttributes } from "react";
import { DELETE_SHORTCUT_ACTION } from "../lib/delete-shortcut.ts";
import { ariaKeyshortcuts, useKeybindings } from "../lib/keybindings.ts";
import { Keycap } from "./Keycap.tsx";

export interface DeleteButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** The current item on a surface with several visible Delete controls. */
  shortcutPrimary?: boolean;
  /** Tiny icon-only controls advertise the chord in their tooltip instead. */
  showShortcutHint?: boolean;
}

/** A destructive button wired to the app's customizable Delete action. */
export const DeleteButton = forwardRef<HTMLButtonElement, DeleteButtonProps>(
  function DeleteButton(
    { children, shortcutPrimary = false, showShortcutHint = true, ...props },
    ref,
  ): React.JSX.Element {
    const { bindings } = useKeybindings();
    const chord = bindings.delete;
    return (
      <button
        {...props}
        ref={ref}
        data-keybinding-action={DELETE_SHORTCUT_ACTION}
        data-delete-shortcut-primary={shortcutPrimary ? "true" : undefined}
        aria-keyshortcuts={ariaKeyshortcuts(chord)}
      >
        {children}
        {showShortcutHint ? <Keycap action="delete" /> : null}
      </button>
    );
  },
);
