import { useEffect, useRef, useState } from "react";
import type { ActionResult } from "../lib/api.ts";
import { Tooltip } from "./Tooltip.tsx";

/**
 * The shared inline rename interaction used by live sessions and archived scouts.
 *
 * Enter or the check commits, Escape or the cross cancels, and clicking away cancels. A
 * server refusal keeps the editor open with its reason. Keeping these mechanics in one
 * component is what makes "rename it like a session" a behavior rather than a resemblance.
 */
export function InlineRenameEditor({
  initialValue,
  ariaLabel,
  onSubmit,
  onClose,
  fallbackError = "rename failed",
  maxLength = 200,
}: {
  initialValue: string;
  ariaLabel: string;
  onSubmit: (value: string) => Promise<ActionResult>;
  onClose: () => void;
  fallbackError?: string;
  maxLength?: number;
}): React.JSX.Element {
  const [value, setValue] = useState(initialValue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  // Disabling the input mid-flight drops focus to <body>; take it back so a rejected name
  // still hears Enter/Escape. Keyed on `busy` too: retrying the same bad name re-reports an
  // identical string, so `error` alone would not re-fire.
  useEffect(() => {
    if (busy || !error) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [busy, error]);

  async function submit(): Promise<void> {
    const name = value.trim();
    if (!name || name === initialValue) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    const result = await onSubmit(name);
    setBusy(false);
    if (result.ok) onClose();
    else setError(result.error ?? fallbackError);
  }

  return (
    <div className="rename-edit" onClick={(event) => event.stopPropagation()}>
      <div className="rename-row">
        <input
          ref={inputRef}
          className="rename-input"
          value={value}
          disabled={busy}
          maxLength={maxLength}
          aria-label={ariaLabel}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") {
              event.preventDefault();
              void submit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
          // Clicking away cancels, but a Cmd+Tab to the terminal must not: the browser fires
          // blur before the window loses focus, so guard on document.hasFocus().
          onBlur={() => {
            if (!busy && document.hasFocus()) onClose();
          }}
        />
        <Tooltip label={busy ? "Renaming…" : "Save the new name (Enter)"}>
          <button
            type="button"
            className="rename-btn rename-save"
            aria-label="Save name"
            disabled={busy}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void submit()}
          >
            ✓
          </button>
        </Tooltip>
        <Tooltip label={busy ? "Renaming…" : "Discard the rename (Escape)"}>
          <button
            type="button"
            className="rename-btn rename-cancel"
            aria-label="Cancel rename"
            disabled={busy}
            onMouseDown={(event) => event.preventDefault()}
            onClick={onClose}
          >
            ✕
          </button>
        </Tooltip>
      </div>
      {error ? <span className="rename-error" role="alert">{error}</span> : null}
    </div>
  );
}
