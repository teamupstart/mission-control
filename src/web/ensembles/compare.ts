import {
  readArtifactAgentCost,
  type EnsembleArtifact,
  type EnsembleEvaluation,
} from "@shared/ensemble.ts";
import type {
  EnsembleArtifactFile,
  EnsembleRunDetailResponse,
} from "./types.ts";

export const MAX_COMPARE_ARTIFACTS = 3;

export const comparePatchKey = (artifactId: string, path: string): string =>
  `${artifactId}\u0000${path}`;

export interface CompareControl {
  artifactIds: string[];
  path: string | null;
}

export interface FileMatrixCell {
  ins: number;
  del: number;
  renamedFrom?: string;
  binary?: boolean;
}

export interface FileMatrixRow {
  path: string;
  totalChurn: number;
  cells: Record<string, FileMatrixCell | undefined>;
  /** The artifact id when exactly one selected artifact touched this path. */
  onlyIn: string | null;
}

export interface RationalePathToken {
  path: string;
  /** UTF-16 string offsets, matching `String.prototype.slice`. */
  start: number;
  end: number;
}

export interface CompareClaim {
  summary: string | null;
  checksCount: number;
  costUsd: number | null;
  score: number | null;
  rank: number | null;
  confidence: number | null;
}

/** Ready commit snapshots are the only artifact adapter the compare workspace understands. */
export function eligibleCompareArtifacts(
  detail: Pick<EnsembleRunDetailResponse, "artifacts">,
): EnsembleArtifact[] {
  return detail.artifacts.filter(
    (artifact) => artifact.kind === "commit" && artifact.status === "ready",
  );
}

/** De-duplicate, discard ineligible ids, and enforce the workspace's three-column ceiling. */
export function capCompareSelection(
  artifactIds: readonly string[],
  eligibleArtifactIds: readonly string[],
): string[] {
  const eligible = new Set(eligibleArtifactIds);
  const selected: string[] = [];
  for (const artifactId of artifactIds) {
    if (
      selected.length >= MAX_COMPARE_ARTIFACTS ||
      !eligible.has(artifactId) ||
      selected.includes(artifactId)
    ) {
      continue;
    }
    selected.push(artifactId);
  }
  return selected;
}

/** One checkbox transition, kept pure so the three-column refusal cannot drift from tests. */
export function updateCompareSelection(
  artifactIds: readonly string[],
  artifactId: string,
  checked: boolean,
  eligibleArtifactIds: readonly string[],
): string[] {
  const current = capCompareSelection(artifactIds, eligibleArtifactIds);
  if (!checked) return current.filter((id) => id !== artifactId);
  if (current.includes(artifactId) || current.length >= MAX_COMPARE_ARTIFACTS) return current;
  return capCompareSelection([...current, artifactId], eligibleArtifactIds);
}

/**
 * Union the complete file lists Phase 2 returns. Rows with the most evidence lead; a path is the
 * deterministic tie-break. Rename provenance stays on the destination-path cell.
 */
export function buildFileMatrix(
  filesByArtifact: ReadonlyMap<string, readonly EnsembleArtifactFile[]>,
): FileMatrixRow[] {
  const rows = new Map<string, FileMatrixRow>();
  for (const [artifactId, files] of filesByArtifact) {
    for (const file of files) {
      let row = rows.get(file.path);
      if (!row) {
        row = { path: file.path, totalChurn: 0, cells: {}, onlyIn: null };
        rows.set(file.path, row);
      }
      const cell: FileMatrixCell = {
        ins: file.insertions,
        del: file.deletions,
        ...(file.oldPath ? { renamedFrom: file.oldPath } : {}),
        ...(file.binary ? { binary: true } : {}),
      };
      row.cells[artifactId] = cell;
      row.totalChurn += file.insertions + file.deletions;
    }
  }

  return [...rows.values()]
    .map((row) => {
      const touchedBy = Object.entries(row.cells)
        .filter(([, cell]) => cell !== undefined)
        .map(([artifactId]) => artifactId);
      return { ...row, onlyIn: touchedBy.length === 1 ? touchedBy[0]! : null };
    })
    .sort((a, b) => b.totalChurn - a.totalChurn || a.path.localeCompare(b.path));
}

const KNOWN_PATH_EXTENSIONS = new Set([
  "bash",
  "c",
  "cc",
  "cjs",
  "cpp",
  "css",
  "go",
  "h",
  "hpp",
  "html",
  "java",
  "js",
  "json",
  "jsx",
  "kt",
  "kts",
  "md",
  "mdx",
  "mjs",
  "php",
  "py",
  "rb",
  "rs",
  "scss",
  "sh",
  "sql",
  "svg",
  "swift",
  "toml",
  "ts",
  "tsx",
  "txt",
  "xml",
  "yaml",
  "yml",
  "zsh",
]);

const LEADING_TOKEN_PUNCTUATION = new Set(["`", "'", "\"", "(", "[", "{", "<"]);
const TRAILING_TOKEN_PUNCTUATION = new Set([
  "`",
  "'",
  "\"",
  ")",
  "]",
  "}",
  ">",
  ".",
  ",",
  ";",
  ":",
  "!",
  "?",
]);

function pathShaped(token: string): boolean {
  if (
    token.length === 0 ||
    token.startsWith("/") ||
    token.includes("\\") ||
    token.includes("://") ||
    !/^[A-Za-z0-9_@+.,=~%/()[\]{}-]+$/.test(token)
  ) {
    return false;
  }
  const segments = token.split("/");
  if (segments.some((segment) => segment === "" || segment === "..")) return false;
  if (token.includes("/")) return true;
  const dot = token.lastIndexOf(".");
  return dot > 0 && KNOWN_PATH_EXTENSIONS.has(token.slice(dot + 1).toLowerCase());
}

/**
 * Detect exact path-shaped tokens without consulting the compare union. A scorecard renders this
 * on its first pass, before selecting artifacts has started any files-only fetch.
 */
export function detectRationalePaths(text: string): RationalePathToken[] {
  const paths: RationalePathToken[] = [];
  for (const match of text.matchAll(/\S+/g)) {
    const raw = match[0];
    const rawStart = match.index;
    if (rawStart === undefined) continue;
    let left = 0;
    let right = raw.length;
    while (left < right && LEADING_TOKEN_PUNCTUATION.has(raw[left]!)) left += 1;
    while (right > left && TRAILING_TOKEN_PUNCTUATION.has(raw[right - 1]!)) right -= 1;
    const token = raw.slice(left, right);
    if (!pathShaped(token)) continue;
    paths.push({
      path: token,
      start: rawStart + left,
      end: rawStart + right,
    });
  }
  return paths;
}

/**
 * Pick an activation-safe compare set for one scored artifact.
 *
 * An existing 2-3 column selection wins when it already contains the scored artifact. Otherwise
 * the recommendation is its counterpart; when the scored artifact IS the recommendation (or
 * there is no recommendation), the highest-ranked other ready artifact keeps the pair distinct.
 */
export function chooseCompareArtifactIds({
  scoredArtifactId,
  currentSelection,
  recommendedArtifactId,
  rankedArtifactIds,
  eligibleArtifactIds,
}: {
  scoredArtifactId: string;
  currentSelection: readonly string[];
  recommendedArtifactId: string | null;
  rankedArtifactIds: readonly string[];
  eligibleArtifactIds: readonly string[];
}): string[] | null {
  const eligible = new Set(eligibleArtifactIds);
  if (!eligible.has(scoredArtifactId)) return null;

  const current = capCompareSelection(currentSelection, eligibleArtifactIds);
  if (current.length >= 2 && current.includes(scoredArtifactId)) return current;

  if (
    recommendedArtifactId &&
    recommendedArtifactId !== scoredArtifactId &&
    eligible.has(recommendedArtifactId)
  ) {
    return [scoredArtifactId, recommendedArtifactId];
  }

  const other = [...rankedArtifactIds, ...eligibleArtifactIds].find(
    (artifactId) => artifactId !== scoredArtifactId && eligible.has(artifactId),
  );
  return other ? [scoredArtifactId, other] : null;
}

function recordSection(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const section = (value as Record<string, unknown>)[key];
  return section && typeof section === "object" && !Array.isArray(section)
    ? (section as Record<string, unknown>)
    : null;
}

function scorecardClaim(
  evaluations: readonly EnsembleEvaluation[],
  artifactId: string,
): Pick<CompareClaim, "score" | "rank" | "confidence"> {
  const newest = [...evaluations]
    .filter((evaluation) => evaluation.status === "succeeded" && evaluation.result)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  for (const evaluation of newest) {
    const body = evaluation.result?.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) continue;
    const cards = (body as Record<string, unknown>).scorecards;
    if (!Array.isArray(cards)) continue;
    const card = cards.find(
      (value) =>
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        (value as Record<string, unknown>).artifactId === artifactId,
    );
    if (!card || typeof card !== "object" || Array.isArray(card)) continue;
    const record = card as Record<string, unknown>;
    return {
      score: typeof record.score === "number" && Number.isFinite(record.score) ? record.score : null,
      rank: typeof record.rank === "number" && Number.isFinite(record.rank) ? record.rank : null,
      confidence:
        typeof record.confidence === "number" && Number.isFinite(record.confidence)
          ? record.confidence
          : null,
    };
  }
  return { score: null, rank: null, confidence: null };
}

/** Claims shown over a diff column, preserving an unreported cost separately from a real zero. */
export function compareClaim(
  detail: Pick<EnsembleRunDetailResponse, "artifacts" | "evaluations">,
  artifactId: string,
): CompareClaim {
  const artifact = detail.artifacts.find((candidate) => candidate.id === artifactId) ?? null;
  const reported = recordSection(artifact?.metadata, "reported");
  const summary =
    typeof reported?.summary === "string"
      ? reported.summary.split(/\r?\n/, 1)[0]!.trim() || null
      : null;
  const checksCount = Array.isArray(reported?.checks)
    ? reported.checks.filter((check) => typeof check === "string").length
    : 0;
  return {
    summary,
    checksCount,
    costUsd: artifact ? readArtifactAgentCost(artifact.metadata) : null,
    ...scorecardClaim(detail.evaluations, artifactId),
  };
}
