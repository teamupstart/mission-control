import type { LayoutMode } from "./layout.ts";

export type ArrowKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";

export interface MoveOptions {
  mode: LayoutMode;
  key: ArrowKey;
  /** Every visible session id, in display order. */
  ids: readonly string[];
  currentId: string | null;
  /** Live column count of the card grid (grid mode only). */
  cols: number;
  /** Ids per board column, in column order (board mode only). Empty columns included. */
  columns: readonly (readonly string[])[];
}

/**
 * Where the arrow keys land, given the layout on screen.
 *
 * Pure, and the one place the three layouts' navigation differs - so a strategy can
 * be reasoned about (and tested) without mounting a dashboard. Returns the id to
 * select, or null to stay put: every layout treats "no session that way" as a
 * no-op rather than wrapping, so holding an arrow parks you at the edge instead of
 * teleporting you across the fleet.
 */
export function moveSelection(opts: MoveOptions): string | null {
  const { mode, key, ids, currentId } = opts;
  if (ids.length === 0) return null;
  // Nothing selected yet: the first arrow press picks up the first session, whichever
  // direction it was - matching the grid's long-standing behaviour.
  if (currentId === null || !ids.includes(currentId)) return ids[0] ?? null;

  if (mode === "board") return moveOnBoard(opts);
  if (mode === "console") {
    // The console rail is a single vertical column: Up/Down walk it a row at a time,
    // and horizontal arrows have no spatial destination. This is the RAIL cursor's
    // answer only - when the operator has Tabbed focus into the open detail, App
    // routes vertical arrows to scroll that reader BEFORE reaching here, so this stays
    // the pure "where does the rail selection land" question the two focus zones share.
    if (key === "ArrowLeft" || key === "ArrowRight") return null;
    const idx = ids.indexOf(currentId);
    return ids[key === "ArrowDown" ? idx + 1 : idx - 1] ?? null;
  }

  // grid: walk the flat list, a row at a time for vertical moves.
  const idx = ids.indexOf(currentId);
  const cols = Math.max(1, opts.cols);
  const next =
    key === "ArrowRight"
      ? idx + 1
      : key === "ArrowLeft"
        ? idx - 1
        : key === "ArrowDown"
          ? idx + cols
          : idx - cols;
  return ids[next] ?? null;
}

/**
 * Board movement is two-dimensional for real: Up/Down walk a column, Left/Right
 * cross to the neighbouring column. Columns are ragged and some are empty, so a
 * sideways move skips over empty columns and clamps to the end of the one it lands
 * in - otherwise "right" off a deep column would fall into a hole and do nothing.
 */
function moveOnBoard({ key, columns, currentId }: MoveOptions): string | null {
  const col = columns.findIndex((c) => c.includes(currentId!));
  if (col === -1) return null;
  const row = columns[col]!.indexOf(currentId!);

  if (key === "ArrowUp" || key === "ArrowDown") {
    return columns[col]![key === "ArrowDown" ? row + 1 : row - 1] ?? null;
  }

  const step = key === "ArrowRight" ? 1 : -1;
  for (let c = col + step; c >= 0 && c < columns.length; c += step) {
    const target = columns[c]!;
    if (target.length === 0) continue;
    return target[Math.min(row, target.length - 1)] ?? null;
  }
  return null;
}
