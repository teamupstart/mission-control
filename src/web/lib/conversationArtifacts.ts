import type { SessionFileDocument } from "@shared/types.ts";
import { matchCheckoutPaths, splitPathLocation } from "./workspaceLinks.ts";

export interface ConversationArtifact {
  /** Checkout-relative path, exactly as the session file API takes it. */
  path: string;
}

export type ArtifactPreviewResult =
  | { kind: "ready"; document: SessionFileDocument }
  | {
      kind: "refusal";
      title: string;
      explanation: string;
      size: number | null;
    };

const MAX_ARTIFACTS_PER_TURN = 3;
const SHORT_LABEL = /^[A-Za-z][A-Za-z ]{0,31}:\s*$/;
const HTML_EXTENSION = /\.html?$/i;

function lineBounds(text: string, start: number, end: number): [number, number] {
  const before = text.lastIndexOf("\n", start - 1);
  const after = text.indexOf("\n", end);
  return [before < 0 ? 0 : before + 1, after < 0 ? text.length : after];
}

function isOwnLinePresentation(text: string, start: number, end: number): boolean {
  const [lineStart, lineEnd] = lineBounds(text, start, end);
  const before = text.slice(lineStart, start);
  const after = text.slice(end, lineEnd);
  if (after.trim() !== "") return false;
  return before.trim() === "" || SHORT_LABEL.test(before.trimStart());
}

interface ArtifactCandidate {
  path: string;
  start: number;
  end: number;
  markdownDestination: boolean;
}

function markdownDestinations(text: string, paths: ReadonlySet<string>): ArtifactCandidate[] {
  const candidates: ArtifactCandidate[] = [];
  const links = /\[[^\]\n]*\]\((?:<([^>\n]+)>|([^\s)\n]+))\)/g;
  for (const match of text.matchAll(links)) {
    if (match.index == null) continue;
    const raw = match[1] ?? match[2];
    if (!raw) continue;
    const [locatedPath] = splitPathLocation(raw);
    const path = locatedPath.startsWith("./") ? locatedPath.slice(2) : locatedPath;
    if (!paths.has(path)) continue;
    const offset = match[0].indexOf(raw);
    candidates.push({
      path,
      start: match.index + offset,
      end: match.index + offset + raw.length,
      markdownDestination: true,
    });
  }
  return candidates;
}

/**
 * Find the real checkout HTML files one turn deliberately presents as artifacts.
 *
 * Checkout membership supplies the path grammar and existence boundary. The extra
 * presentation check keeps incidental prose such as "edited src/web/index.html" as an
 * ordinary link instead of turning every HTML mention into a large preview.
 */
export function conversationArtifacts(
  text: string,
  paths: ReadonlySet<string>,
): ConversationArtifact[] {
  if (paths.size === 0 || !text.toLowerCase().includes(".htm")) return [];

  const candidates: ArtifactCandidate[] = [
    ...matchCheckoutPaths(text, paths).map((token) => ({
      path: token.path,
      start: token.start,
      end: token.end,
      markdownDestination: false,
    })),
    ...markdownDestinations(text, paths),
  ].sort((a, b) => a.start - b.start);

  const seen = new Set<string>();
  const artifacts: ConversationArtifact[] = [];
  for (const token of candidates) {
    if (!HTML_EXTENSION.test(token.path)) continue;
    if (
      !isOwnLinePresentation(text, token.start, token.end)
      && !token.markdownDestination
    ) continue;
    if (seen.has(token.path)) continue;
    seen.add(token.path);
    artifacts.push({ path: token.path });
    if (artifacts.length === MAX_ARTIFACTS_PER_TURN) break;
  }
  return artifacts;
}

/** Translate the contained file API's response into the card's reader-facing states. */
export function classifyArtifactPreview(
  result:
    | { ok: true; file: SessionFileDocument }
    | { ok: false; error: string },
): ArtifactPreviewResult {
  if (!result.ok) {
    if (/no longer exists|not found/i.test(result.error)) {
      return {
        kind: "refusal",
        title: "File no longer exists.",
        explanation: "It was present when this turn was written. Refresh after restoring it, or open Files to choose another file.",
        size: null,
      };
    }
    if (/checkout|path|symbolic-link|regular file/i.test(result.error)) {
      return {
        kind: "refusal",
        title: "Preview blocked for safety.",
        explanation: "The daemon refused this path at the checkout boundary. Open Files to inspect the available checkout files.",
        size: null,
      };
    }
    return {
      kind: "refusal",
      title: "Preview unavailable.",
      explanation: "The file could not be read. Refresh to try again, or open it in Files.",
      size: null,
    };
  }

  const { file } = result;
  if (file.kind === "oversized") {
    return {
      kind: "refusal",
      title: "Too large to preview.",
      explanation: "This file is over the 5 MiB preview cap. Open it in Files to inspect it there.",
      size: file.size,
    };
  }
  if (file.text === null || file.kind === "binary") {
    return {
      kind: "refusal",
      title: "Not valid UTF-8.",
      explanation: "HTML previews require decodable UTF-8 text. Open the file in Files to inspect its details.",
      size: file.size,
    };
  }
  return { kind: "ready", document: file };
}

const expandedArtifacts = new Map<string, boolean>();
const discoveredArtifacts = new Map<
  string,
  { text: string; artifacts: ConversationArtifact[] }
>();
const artifactKey = (sessionId: string, path: string): string => `${sessionId}\0${path}`;
const turnKey = (sessionId: string, turnId: string): string => `${sessionId}\0${turnId}`;

/**
 * Keep a path after this view has positively matched it against the checkout listing.
 *
 * The listing is live and drops a deleted file before the card's next read can report the
 * deletion. Remembering only already-confirmed paths lets that card keep its refusal state
 * without weakening the rule that an absent path can never create a card in the first place.
 */
export function retainDiscoveredArtifacts(
  sessionId: string,
  turnId: string,
  text: string,
  current: ConversationArtifact[],
): ConversationArtifact[] {
  const key = turnKey(sessionId, turnId);
  const previous = discoveredArtifacts.get(key);

  if (!previous) {
    if (current.length === 0) return [];
    const next = { text, artifacts: current.slice(0, MAX_ARTIFACTS_PER_TURN) };
    discoveredArtifacts.set(key, next);
    return next.artifacts;
  }

  if (previous.text !== text) {
    if (current.length === 0) {
      discoveredArtifacts.delete(key);
      return [];
    }
    const next = { text, artifacts: current.slice(0, MAX_ARTIFACTS_PER_TURN) };
    discoveredArtifacts.set(key, next);
    return next.artifacts;
  }

  if (current.every((artifact) => previous.artifacts.some(({ path }) => path === artifact.path))) {
    return previous.artifacts;
  }

  const seen = new Set(previous.artifacts.map(({ path }) => path));
  const artifacts = [...previous.artifacts];
  for (const artifact of current) {
    if (artifacts.length >= MAX_ARTIFACTS_PER_TURN) break;
    if (!seen.has(artifact.path)) artifacts.push(artifact);
  }
  discoveredArtifacts.set(key, { text, artifacts });
  return artifacts;
}

/** Expanded is the default until a reader explicitly collapses this session artifact. */
export function readArtifactExpanded(sessionId: string, path: string): boolean {
  return expandedArtifacts.get(artifactKey(sessionId, path)) ?? true;
}

export function writeArtifactExpanded(sessionId: string, path: string, expanded: boolean): void {
  expandedArtifacts.set(artifactKey(sessionId, path), expanded);
}

/** Collect artifact UI memory only when the registry positively removes the session. */
export function dropSessionArtifactState(sessionId: string): void {
  const prefix = `${sessionId}\0`;
  for (const key of expandedArtifacts.keys()) {
    if (key.startsWith(prefix)) expandedArtifacts.delete(key);
  }
  for (const key of discoveredArtifacts.keys()) {
    if (key.startsWith(prefix)) discoveredArtifacts.delete(key);
  }
}

/** Test seam. */
export function resetArtifactState(): void {
  expandedArtifacts.clear();
  discoveredArtifacts.clear();
}

/** Test seam for proving artifact-free turns do not accumulate retained state. */
export function artifactStateEntryCounts(): { expanded: number; discovered: number } {
  return {
    expanded: expandedArtifacts.size,
    discovered: discoveredArtifacts.size,
  };
}
