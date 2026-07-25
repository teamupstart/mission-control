import { useEffect, useMemo, useState } from "react";
import type { MissionSchedule } from "@shared/schedules.ts";
import { Overlay, OVERLAY_IDS } from "./Overlay.tsx";
import { Tooltip } from "./Tooltip.tsx";
import { ScheduleCatalog } from "./schedules/ScheduleCatalog.tsx";
import { ScheduleDetail } from "./schedules/ScheduleDetail.tsx";
import { ScheduleEditor } from "./schedules/ScheduleEditor.tsx";
import { ScheduleHistory } from "./schedules/ScheduleHistory.tsx";
import { SchedulePreview } from "./schedules/SchedulePreview.tsx";
import { sortSchedulesForCatalog } from "../lib/schedules.ts";
import type { ScheduleDefinitionPayload } from "../lib/api.ts";

/**
 * The Scheduled Catalog overlay: one mounted surface that routes between catalog/detail,
 * create/edit, preview, and run history.
 *
 * Registered through the shared `<Overlay>` primitive (see Overlay.tsx), so it is counted
 * as open, stands the global shortcuts down, and owns Escape - App never hand-maintains a
 * stand-down list. App owns only the cross-surface state (open, deep-link target, and the
 * callbacks that close a Sitrep/Dispatch surface before opening Missions); the screen a
 * schedule is shown on is local here and survives while the overlay is mounted.
 *
 * The catalog is `MissionState.schedules` and nothing else - it is SSE-owned and never
 * polled. History is the one page-oriented read, fetched on demand inside `ScheduleHistory`.
 * A deep link from a generated task can carry an occurrence id, which opens straight to that
 * run's history even for an archived schedule the live catalog no longer lists.
 */

type Screen =
  | { kind: "catalog" }
  | { kind: "editor"; scheduleId: string | null }
  | { kind: "preview"; scheduleId: string }
  | { kind: "history"; scheduleId: string; occurrenceId: string | null };

/** Build a preview definition from a saved schedule's active revision (Preview screen). */
function scheduleToDefinition(schedule: MissionSchedule): ScheduleDefinitionPayload | null {
  if (!schedule.template || !schedule.overlapPolicy || !schedule.missedPolicy) return null;
  return {
    name: schedule.name,
    expression: schedule.expression,
    timezone: schedule.timezone,
    overlapPolicy: schedule.overlapPolicy,
    missedPolicy: schedule.missedPolicy,
    template: schedule.template,
  };
}

export function RecurringMissionsPanel({
  schedules,
  connected,
  hasSnapshot,
  initialScheduleId = null,
  initialOccurrenceId = null,
  onClose,
  onOpenTask,
}: {
  schedules: MissionSchedule[];
  connected: boolean;
  hasSnapshot: boolean;
  /** A schedule to open on, from a generated task's provenance deep link. */
  initialScheduleId?: string | null;
  /** An occurrence to open history at; its presence sends the panel straight to history. */
  initialOccurrenceId?: string | null;
  onClose: () => void;
  /** Open a generated task (backlog edit or finished result) from history. */
  onOpenTask?: (taskId: string) => void;
}): React.JSX.Element {
  const sorted = useMemo(() => sortSchedulesForCatalog(schedules), [schedules]);

  const [screen, setScreen] = useState<Screen>(() =>
    initialScheduleId && initialOccurrenceId
      ? { kind: "history", scheduleId: initialScheduleId, occurrenceId: initialOccurrenceId }
      : { kind: "catalog" },
  );
  const [selectedId, setSelectedId] = useState<string | null>(
    initialScheduleId ?? sorted[0]?.id ?? null,
  );
  const [editorDirty, setEditorDirty] = useState(false);
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

  const selectedSchedule = useMemo(
    () => schedules.find((s) => s.id === selectedId) ?? null,
    [schedules, selectedId],
  );

  function handleClose(): void {
    if (screen.kind === "editor" && editorDirty) {
      setConfirmDiscard("close");
      return;
    }
    onClose();
  }

  function handleBack(): void {
    if (screen.kind === "editor" && editorDirty) {
      setConfirmDiscard("catalog");
      return;
    }
    toCatalog();
  }

  function toCatalog(id?: string | null): void {
    setEditorDirty(false);
    if (id !== undefined && id !== null) setSelectedId(id);
    setScreen({ kind: "catalog" });
  }

  const title =
    screen.kind === "editor"
      ? screen.scheduleId
        ? "Edit recurring mission"
        : "Create recurring mission"
      : screen.kind === "preview"
        ? "Occurrence preview"
        : screen.kind === "history"
          ? "Run history"
          : "Scheduled Catalog";

  return (
    <Overlay
      id={OVERLAY_IDS.recurringMissions}
      onClose={handleClose}
      className="rm-panel"
      as="aside"
      role="dialog"
      ariaLabel="Recurring missions"
    >
      <header className="rm-topline">
        <div className="rm-topline-titles">
          <span className="rm-eyebrow">Recurring Missions</span>
          <h2>{title}</h2>
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
            <Tooltip label="Back to the catalog">
              <button className="btn" onClick={handleBack}>
                ← Catalog
              </button>
            </Tooltip>
          )}
          <Tooltip label="Close (Escape)">
            <button className="icon-btn" aria-label="Close" onClick={handleClose}>
              ✕
            </button>
          </Tooltip>
        </div>
      </header>

      <div className="rm-content">
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
                schedule={selectedSchedule}
                onEdit={() => setScreen({ kind: "editor", scheduleId: selectedSchedule.id })}
                onPreview={() => setScreen({ kind: "preview", scheduleId: selectedSchedule.id })}
                onHistory={() =>
                  setScreen({ kind: "history", scheduleId: selectedSchedule.id, occurrenceId: null })
                }
                onArchived={() => {
                  // Archive removes it from the live catalog via SSE; drop the selection so
                  // the reconcile effect picks a neighbour on the next render.
                  setSelectedId((prev) => (prev === selectedSchedule.id ? null : prev));
                }}
              />
            ) : (
              <div className="rm-detail rm-detail-empty">
                <p className="rm-empty">Select a schedule, or create a new recurring mission.</p>
              </div>
            )}
          </div>
        )}

        {screen.kind === "editor" && (
          <ScheduleEditor
            schedule={screen.scheduleId ? (selectedSchedule ?? null) : null}
            onDirtyChange={setEditorDirty}
            onSaved={(saved) => toCatalog(saved.id)}
            onCancel={handleBack}
          />
        )}

        {screen.kind === "preview" && <PreviewScreen schedule={selectedSchedule} />}

        {screen.kind === "history" && (
          <ScheduleHistory
            scheduleId={screen.scheduleId}
            fallbackName={selectedSchedule?.name ?? null}
            initialOccurrenceId={screen.occurrenceId}
            onOpenTask={onOpenTask}
          />
        )}
      </div>

      {confirmDiscard && (
        <div className="rm-confirm">
          <div className="rm-confirm-box" role="alertdialog" aria-label="Discard unsaved schedule">
            <p>Discard this unsaved schedule?</p>
            <div className="rm-confirm-actions">
              <Tooltip label="Keep editing this schedule">
                <button className="btn" onClick={() => setConfirmDiscard(null)}>
                  Keep editing
                </button>
              </Tooltip>
              <Tooltip label="Discard the unsaved changes">
                <button
                  className="btn btn-danger"
                  onClick={() => {
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

function PreviewScreen({ schedule }: { schedule: MissionSchedule | null }): React.JSX.Element {
  if (!schedule) return <p className="rm-empty">Select a schedule to preview.</p>;
  const definition = scheduleToDefinition(schedule);
  if (!definition) {
    return <p className="rm-empty">This schedule cannot be previewed as read.</p>;
  }
  return (
    <div className="rm-preview-screen">
      <div className="rm-panel-head">
        <h3>{schedule.name} · next occurrences</h3>
        <span className="rm-dim rm-tiny">
          {schedule.timezone} · revision {schedule.revision}
        </span>
      </div>
      <SchedulePreview definition={definition} excludeScheduleId={schedule.id} />
    </div>
  );
}
