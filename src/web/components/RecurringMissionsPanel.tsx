import { useEffect, useMemo, useRef, useState } from "react";
import type { MissionSchedule } from "@shared/schedules.ts";
import { Overlay, OVERLAY_IDS } from "./Overlay.tsx";
import { Tooltip } from "./Tooltip.tsx";
import { ScheduleCatalog } from "./schedules/ScheduleCatalog.tsx";
import { ScheduleDetail } from "./schedules/ScheduleDetail.tsx";
import { ScheduleEditor } from "./schedules/ScheduleEditor.tsx";
import { ScheduleSpine } from "./schedules/ScheduleSpine.tsx";
import { sortSchedulesForCatalog } from "../lib/schedules.ts";

/**
 * The Recurring Missions overlay: one mounted surface that routes between catalog/detail,
 * create/edit, and the deep-linked run history.
 *
 * Registered through the shared `<Overlay>` primitive (see Overlay.tsx), so it is counted
 * as open, stands the global shortcuts down, and owns Escape - App never hand-maintains a
 * stand-down list. App owns only the cross-surface state (open, deep-link target, and the
 * callbacks that close a Sitrep/Dispatch surface before opening Missions); the screen a
 * mission is shown on is local here and survives while the overlay is mounted.
 *
 * The catalog is `MissionState.schedules` and nothing else - it is SSE-owned and never
 * polled. History is the one page-oriented read, fetched on demand inside `ScheduleSpine`.
 *
 * **There used to be four screens and now there are three.** Preview and Run history each
 * answered half a question about the mission the operator had just been looking at, and
 * both are now the two halves of one time axis inside the detail. The `history` route
 * survives for a single case the detail cannot serve: a generated task's deep link into a
 * mission the live catalog no longer lists, because it was archived. That route renders the
 * SAME spine, standalone, over the schedule the history page carries with it.
 *
 * One vocabulary throughout: these are recurring MISSIONS. The heading used to say
 * "Recurring missions" under an eyebrow saying "Recurring Missions", beside a topbar button
 * saying "Missions", routing to screens called "Occurrence preview" and "Run history".
 */

type Screen =
  | { kind: "catalog" }
  | { kind: "editor"; scheduleId: string | null }
  | {
      kind: "history";
      scheduleId: string;
      occurrenceId: string | null;
      /** The deep-linked occurrence's instant, so history opens the exact run. */
      scheduledFor: number | null;
    };

export function RecurringMissionsPanel({
  schedules,
  connected,
  hasSnapshot,
  initialScheduleId = null,
  initialOccurrenceId = null,
  initialScheduledFor = null,
  onClose,
  onOpenTask,
  resolveTaskLink,
}: {
  schedules: MissionSchedule[];
  connected: boolean;
  hasSnapshot: boolean;
  /** A schedule to open on, from a generated task's provenance deep link. */
  initialScheduleId?: string | null;
  /** An occurrence to open history at; its presence sends the panel straight to history. */
  initialOccurrenceId?: string | null;
  /** The occurrence's instant, so history can open the exact run without a page cap. */
  initialScheduledFor?: number | null;
  onClose: () => void;
  /** Open a generated task (backlog edit or finished result) from history. */
  onOpenTask?: (taskId: string) => void;
  /** Whether a generated-task link leads anywhere live, and why not when it does not. */
  resolveTaskLink?: (taskId: string) => { openable: boolean; blockedReason: string | null };
}): React.JSX.Element {
  const sorted = useMemo(() => sortSchedulesForCatalog(schedules), [schedules]);

  const [screen, setScreen] = useState<Screen>(() =>
    initialScheduleId && initialOccurrenceId
      ? {
          kind: "history",
          scheduleId: initialScheduleId,
          occurrenceId: initialOccurrenceId,
          scheduledFor: initialScheduledFor,
        }
      : { kind: "catalog" },
  );
  const [selectedId, setSelectedId] = useState<string | null>(
    initialScheduleId ?? sorted[0]?.id ?? null,
  );
  const [editorDirty, setEditorDirty] = useState(false);
  const [editorBusy, setEditorBusy] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const keepEditingRef = useRef<HTMLButtonElement>(null);
  // Where a confirmed discard should land: closing the overlay (Escape/✕) or returning to
  // the catalog (the Back/Cancel routes). Null when no confirmation is pending.
  const [confirmDiscard, setConfirmDiscard] = useState<null | "close" | "catalog">(null);

  // Keep a valid catalog selection as SSE reorders or removes rows: hold the current one
  // if it still exists, otherwise fall to the top of the sorted list (or nothing).
  useEffect(() => {
    if (screen.kind !== "catalog") return;
    if (selectedId && schedules.some((s) => s.id === selectedId)) return;
    setSelectedId(sorted[0]?.id ?? null);
  }, [schedules, sorted, selectedId, screen.kind]);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    if (confirmDiscard) keepEditingRef.current?.focus();
  }, [confirmDiscard]);

  const selectedSchedule = useMemo(
    () => schedules.find((s) => s.id === selectedId) ?? null,
    [schedules, selectedId],
  );
  const routedSchedule = useMemo(() => {
    if (screen.kind === "catalog" || (screen.kind === "editor" && screen.scheduleId === null)) {
      return null;
    }
    return schedules.find((schedule) => schedule.id === screen.scheduleId) ?? null;
  }, [schedules, screen]);

  function handleClose(): void {
    if (editorBusy) return;
    if (screen.kind === "editor" && editorDirty) {
      setConfirmDiscard("close");
      return;
    }
    onClose();
  }

  function handleBack(): void {
    if (editorBusy) return;
    if (screen.kind === "editor" && editorDirty) {
      setConfirmDiscard("catalog");
      return;
    }
    toCatalog();
  }

  function toCatalog(id?: string | null): void {
    setEditorBusy(false);
    setEditorDirty(false);
    if (id !== undefined && id !== null) setSelectedId(id);
    setScreen({ kind: "catalog" });
  }

  const title =
    screen.kind === "editor"
      ? screen.scheduleId
        ? "Edit mission"
        : "New mission"
      : screen.kind === "history"
        ? "Run history"
        : "Missions";

  return (
    <Overlay
      id={OVERLAY_IDS.recurringMissions}
      onClose={handleClose}
      className="rm-panel"
      as="aside"
      role="dialog"
      ariaLabel="Recurring missions"
    >
      <header className="rm-topline" inert={confirmDiscard !== null}>
        <div className="rm-topline-titles">
          <span className="rm-eyebrow">Recurring missions</span>
          {/* tabIndex -1, so no keyboard user can ever land here by tabbing; the focus
              exists only to move an assistive-tech reader's cursor to the new screen. The
              browser still applied :focus-visible to it, painting a full-width ring across
              the panel on every open - see .rm-topline-titles h2:focus in styles.css. */}
          <h2 ref={headingRef} tabIndex={-1}>
            {title}
          </h2>
        </div>
        <div className="rm-topline-actions">
          {screen.kind === "catalog" ? (
            <Tooltip label="Create a new recurring mission">
              <button
                className="btn btn-primary"
                onClick={() => {
                  setEditorDirty(false);
                  setScreen({ kind: "editor", scheduleId: null });
                }}
              >
                ＋ Create mission
              </button>
            </Tooltip>
          ) : (
            <Tooltip label="Back to the mission list">
              <button className="btn" onClick={handleBack} disabled={editorBusy}>
                ← Missions
              </button>
            </Tooltip>
          )}
          <Tooltip label="Close (Escape)">
            <button
              className="icon-btn"
              aria-label="Close"
              onClick={handleClose}
              disabled={editorBusy}
            >
              ✕
            </button>
          </Tooltip>
        </div>
      </header>

      <div className="rm-content" inert={confirmDiscard !== null}>
        {screen.kind === "catalog" && (
          <div className="rm-catalog-layout">
            <ScheduleCatalog
              schedules={schedules}
              selectedId={selectedId}
              onSelect={setSelectedId}
              connected={connected}
              hasSnapshot={hasSnapshot}
            />
            {selectedSchedule ? (
              <ScheduleDetail
                key={selectedSchedule.id}
                schedule={selectedSchedule}
                onEdit={() => setScreen({ kind: "editor", scheduleId: selectedSchedule.id })}
                onOpenTask={onOpenTask}
                resolveTaskLink={resolveTaskLink}
                onArchived={() => {
                  // Archive removes it from the live catalog via SSE; drop the selection so
                  // the reconcile effect picks a neighbour on the next render.
                  setSelectedId((prev) => (prev === selectedSchedule.id ? null : prev));
                }}
              />
            ) : (
              <div className="rm-detail rm-detail-empty">
                <p className="rm-empty">Select a mission, or create a new one.</p>
              </div>
            )}
          </div>
        )}

        {screen.kind === "editor" &&
          (screen.scheduleId !== null && !routedSchedule ? (
            <div className="rm-detail rm-detail-empty">
              <p className="rm-empty">This schedule is no longer available.</p>
              <Tooltip label="Return to the mission list">
                <button className="btn" onClick={() => toCatalog()}>
                  Back to catalog
                </button>
              </Tooltip>
            </div>
          ) : (
            <ScheduleEditor
              schedule={routedSchedule}
              onDirtyChange={setEditorDirty}
              onBusyChange={setEditorBusy}
              onSaved={(saved) => toCatalog(saved.id)}
              onCancel={handleBack}
            />
          ))}

        {screen.kind === "history" && (
          <div className="rm-detail rm-detail-standalone">
            <div className="rm-detail-body">
              <ScheduleSpine
                key={screen.scheduleId}
                scheduleId={screen.scheduleId}
                schedule={routedSchedule}
                fallbackName={routedSchedule?.name ?? null}
                initialOccurrenceId={screen.occurrenceId}
                initialScheduledFor={screen.scheduledFor}
                onOpenTask={onOpenTask}
                resolveTaskLink={resolveTaskLink}
              />
            </div>
          </div>
        )}
      </div>

      {confirmDiscard && (
        <div className="rm-confirm">
          <div className="rm-confirm-box" role="alertdialog" aria-label="Discard unsaved mission">
            <p>Discard this unsaved mission?</p>
            <div className="rm-confirm-actions">
              <Tooltip label="Keep editing this mission">
                <button
                  ref={keepEditingRef}
                  className="btn"
                  onClick={() => !editorBusy && setConfirmDiscard(null)}
                  disabled={editorBusy}
                >
                  Keep editing
                </button>
              </Tooltip>
              <Tooltip label="Discard the unsaved changes">
                <button
                  className="btn btn-danger"
                  disabled={editorBusy}
                  onClick={() => {
                    if (editorBusy) return;
                    const target = confirmDiscard;
                    setConfirmDiscard(null);
                    setEditorDirty(false);
                    if (target === "close") onClose();
                    else toCatalog();
                  }}
                >
                  Discard
                </button>
              </Tooltip>
            </div>
          </div>
        </div>
      )}
    </Overlay>
  );
}

