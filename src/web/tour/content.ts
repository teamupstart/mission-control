import { TOUR_CONTENT_SOURCES } from "./content.generated.ts";
import type { TourId, TourStep, TourStopDetail } from "./contracts.ts";

export interface TourStageContent {
  title: string;
  description: string;
  details?: readonly TourStopDetail[];
}

export interface TourContent {
  title: string;
  stages: Readonly<Record<string, TourStageContent>>;
}

export class TourContentError extends Error {}

const STAGE_MARKER = /^<!--\s*stage:\s*([a-z0-9]+(?:-[a-z0-9]+)*)\s*-->$/;
const DETAIL = /^-\s+\*\*(.+?):\*\*\s+(.+)$/;

function prose(lines: readonly string[]): string {
  const paragraphs: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (!current.length) return;
    paragraphs.push(current.join(" "));
    current = [];
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) flush();
    else current.push(line);
  }
  flush();
  return paragraphs.join("\n\n");
}

function parseStageBody(slug: string, stageId: string, lines: readonly string[]): {
  description: string;
  details?: readonly TourStopDetail[];
} {
  const descriptionLines: string[] = [];
  const details: TourStopDetail[] = [];
  let readingDetails = false;

  for (const raw of lines) {
    const match = DETAIL.exec(raw.trim());
    if (match) {
      readingDetails = true;
      details.push({ label: match[1]!.trim(), description: match[2]!.trim() });
      continue;
    }
    if (readingDetails && raw.trim()) {
      throw new TourContentError(
        `tour ${slug} stage ${stageId} has prose after its definition list`,
      );
    }
    if (!readingDetails) descriptionLines.push(raw);
  }

  const description = prose(descriptionLines);
  if (!description) {
    throw new TourContentError(`tour ${slug} stage ${stageId} has no description`);
  }
  return details.length ? { description, details } : { description };
}

/** Parse the deliberately small Markdown shape documented in `tours/README.md`. */
export function parseTourContent(slug: string, markdown: string): TourContent {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const h1 = lines.findIndex((line) => line.startsWith("# "));
  if (h1 < 0 || !lines[h1]!.slice(2).trim()) {
    throw new TourContentError(`tour ${slug} has no H1 title`);
  }
  if (lines.slice(0, h1).some((line) => line.trim())) {
    throw new TourContentError(`tour ${slug} has content before its H1 title`);
  }

  const title = lines[h1]!.slice(2).trim();
  const stages: Record<string, TourStageContent> = {};
  const headings: number[] = [];
  for (let index = h1 + 1; index < lines.length; index += 1) {
    if (lines[index]!.startsWith("## ")) headings.push(index);
    else if (lines[index]!.startsWith("# ")) {
      throw new TourContentError(`tour ${slug} repeats its H1 title`);
    }
  }
  if (!headings.length) throw new TourContentError(`tour ${slug} has no stages`);
  if (lines.slice(h1 + 1, headings[0]).some((line) => line.trim())) {
    throw new TourContentError(`tour ${slug} has content between its title and first stage`);
  }

  for (const [position, heading] of headings.entries()) {
    const stageTitle = lines[heading]!.slice(3).trim();
    const end = headings[position + 1] ?? lines.length;
    const section = lines.slice(heading + 1, end);
    const markerIndex = section.findIndex((line) => line.trim());
    const marker = markerIndex >= 0 ? STAGE_MARKER.exec(section[markerIndex]!.trim()) : null;
    if (!stageTitle || !marker) {
      throw new TourContentError(
        `tour ${slug} stage "${stageTitle || "untitled"}" needs a stage comment directly below its H2`,
      );
    }
    const stageId = marker[1]!;
    if (stages[stageId]) throw new TourContentError(`tour ${slug} repeats stage ${stageId}`);
    const body = section.slice(markerIndex + 1);
    stages[stageId] = { title: stageTitle, ...parseStageBody(slug, stageId, body) };
  }

  return { title, stages };
}

const CONTENT = new Map<string, TourContent>(
  TOUR_CONTENT_SOURCES.map((source) => [source.slug, parseTourContent(source.slug, source.markdown)]),
);

export function tourContent(id: TourId): TourContent {
  const content = CONTENT.get(id);
  if (!content) throw new TourContentError(`no authored content for tour ${id}`);
  return content;
}

export function tourStageContent(tourId: TourId, stageId: string): TourStageContent {
  const content = tourContent(tourId).stages[stageId];
  if (!content) throw new TourContentError(`tour ${tourId} has no authored stage ${stageId}`);
  return content;
}

/** Refuse authored stages that no code-owned tour step consumes. */
export function assertTourContentStages<Runtime, Navigation>(
  tourId: TourId,
  steps: readonly TourStep<Runtime, Navigation>[],
): TourContent {
  const content = tourContent(tourId);
  const expected = new Set(steps.map((step) => step.id));
  const extra = Object.keys(content.stages).filter((stageId) => !expected.has(stageId));
  if (extra.length) {
    throw new TourContentError(`tour ${tourId} has unused authored stage${extra.length === 1 ? "" : "s"} ${extra.join(", ")}`);
  }
  return content;
}
