import { useEffect, useState } from "react";
import { KeyboardPanel } from "./KeyboardPanel.tsx";
import { SkillsPanel } from "./SkillsPanel.tsx";
import { useSkills } from "../useSkills.ts";

/**
 * The settings categories, in rail order. Each is a peer destination in the left nav,
 * so adding one - Notifications, Foreman, Appearance - is appending an entry here plus a
 * `case` in `renderCategory`, never lengthening a scroll. Keeping the list as data (not
 * inlined JSX) is also what the render test walks to prove every category is reachable.
 */
export const SETTINGS_CATEGORIES = [
  { id: "keyboard", label: "Keyboard", icon: "⌨" },
  { id: "skills", label: "Skills", icon: "✦" },
] as const;

export type SettingsCategoryId = (typeof SETTINGS_CATEGORIES)[number]["id"];

/**
 * App settings, reached from the topbar gear or the native Settings… menu (⌘,).
 *
 * A two-pane surface: a category rail on the left, the selected category's panel on the
 * right. Only the active category renders, so no setting is ever buried below another -
 * Skills is one click from open, not the tail of a scroll. The panels themselves are
 * unchanged; this component only arranges them and owns which one is showing.
 *
 * `KeyboardPanel` is the modal's local-only, synchronous setting (localStorage). Skills
 * is the one that leaves this machine: it writes to the daemon, and through it to
 * `~/.claude/skills`, so it is also the first that can fail asynchronously. `SkillsPanel`
 * owns that error path. `useSkills` lives here rather than inside the Skills panel so the
 * catalog keeps polling (and `pending` keeps moving) while you're on another category.
 */
export function SettingsModal({
  onClose,
  initialCategory = "keyboard",
}: {
  onClose: () => void;
  /** Which category to open on. Lets the ⌘, menu (or a test) deep-link a category. */
  initialCategory?: SettingsCategoryId;
}): React.JSX.Element {
  const [active, setActive] = useState<SettingsCategoryId>(initialCategory);
  const skills = useSkills();

  // Escape closes the modal. This is a plain bubble-phase handler with no "is a shortcut
  // recording?" guard: while KeyboardPanel records, its capture-phase listener swallows
  // the keystroke (stopPropagation) before this ever runs, so Escape cancels the capture
  // instead of closing - the modal never has to know recording is happening.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function renderCategory(id: SettingsCategoryId): React.JSX.Element {
    switch (id) {
      case "keyboard":
        return <KeyboardPanel />;
      case "skills":
        return <SkillsPanel state={skills} />;
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal settings-modal"
        role="dialog"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2>Settings</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="settings-layout">
          <nav className="settings-nav" aria-label="Settings categories">
            {SETTINGS_CATEGORIES.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`settings-nav-item${active === c.id ? " is-active" : ""}`}
                aria-current={active === c.id ? "page" : undefined}
                onClick={() => setActive(c.id)}
              >
                <span className="settings-nav-icon" aria-hidden>
                  {c.icon}
                </span>
                {c.label}
              </button>
            ))}
          </nav>

          <div className="settings-pane">{renderCategory(active)}</div>
        </div>
      </div>
    </div>
  );
}
