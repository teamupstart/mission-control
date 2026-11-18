import { CONDUCTOR_INTEGRATION_ENABLED } from "@shared/conductor-integration.ts";
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
/** A trailing `<!-- requires: <id> -->` on a definition entry: shown only while `<id>` is on. */
const REQUIRES = /\s*<!--\s*requires:\s*([a-z0-9]+(?:-[a-z0-9]+)*)\s*-->$/;

/**
 * Which optional integrations this build offers, by the id a tour entry names in `requires`.
 *
 * An entry describing something a build has switched off would teach a control that is not
 * there, so the copy stays authored and the switch decides whether it is shown. A requirement
 * missing from this table is an authoring error, refused like any other malformed entry.
 */
export type TourRequirements = Readonly<Record<string, boolean>>;

export const TOUR_REQUIREMENTS: TourRequirements = {
  "ai-conductor": CONDUCTOR_INTEGRATION_ENABLED,
};
const BULLET = /^-(?:\s+|$)/;

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

function parseStageBody(
  slug: string,
  stageId: string,
  lines: readonly string[],
  requirements: TourRequirements,
): {
  description: string;
  details?: readonly TourStopDetail[];
} {
  const descriptionLines: string[] = [];
  const details: TourStopDetail[] = [];
  let readingDetails = false;

  for (const raw of lines) {
    const line = raw.trim();
    const match = DETAIL.exec(line);
    if (match) {
      readingDetails = true;
      const required = REQUIRES.exec(match[2]!);
      if (required) {
        // Own keys only: an inherited name such as `constructor` is not a requirement.
        const offered = Object.hasOwn(requirements, required[1]!) ? requirements[required[1]!] : undefined;
        if (offered === undefined) {
          throw new TourContentError(
            `tour ${slug} stage ${stageId} requires unknown integration ${required[1]}`,
          );
        }
        if (!offered) continue;
      }
      const description = (required ? match[2]!.slice(0, required.index) : match[2]!).trim();
      details.push({ label: match[1]!.trim(), description });
      continue;
    }
    if (BULLET.test(line)) {
      throw new TourContentError(
        `tour ${slug} stage ${stageId} has a malformed definition list entry`,
      );
    }
    if (readingDetails && line) {
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
export function parseTourContent(
  slug: string,
  markdown: string,
  requirements: TourRequirements = TOUR_REQUIREMENTS,
): TourContent {
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
    stages[stageId] = { title: stageTitle, ...parseStageBody(slug, stageId, body, requirements) };
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
