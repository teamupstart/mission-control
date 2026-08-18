export type WorkflowRunArrowKey = "ArrowUp" | "ArrowDown";
export type WorkflowStageNavigationKey =
  | "ArrowUp"
  | "ArrowDown"
  | "ArrowLeft"
  | "ArrowRight"
  | "Tab";

/**
 * Move the Runs rail cursor by one visible row without wrapping.
 *
 * The rail is ordered before it reaches this helper, so this function owns only the keyboard
 * rule. A missing or stale selection starts at the first row, matching the Fleet rail. At an
 * edge it returns null so holding an arrow keeps the cursor parked instead of jumping across
 * history.
 */
export function moveWorkflowRunSelection(
  ids: readonly string[],
  selectedId: string | null,
  key: WorkflowRunArrowKey,
): string | null {
  if (ids.length === 0) return null;
  const index = selectedId === null ? -1 : ids.indexOf(selectedId);
  if (index < 0) return ids[0] ?? null;
  return ids[key === "ArrowDown" ? index + 1 : index - 1] ?? null;
}

/** Previous or next stage for arrows and Tab. Null leaves the focus at the strip's edge. */
export function moveWorkflowStageSelection(
  stageCount: number,
  currentIndex: number,
  key: WorkflowStageNavigationKey,
  shiftKey = false,
): number | null {
  if (stageCount <= 0 || currentIndex < 0 || currentIndex >= stageCount) return null;
  const backwards = key === "ArrowUp" || key === "ArrowLeft" || (key === "Tab" && shiftKey);
  const next = currentIndex + (backwards ? -1 : 1);
  return next >= 0 && next < stageCount ? next : null;
}
