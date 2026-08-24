#!/usr/bin/env node
// Regenerate `src/web/tour/content.generated.ts` from `tours/*.md`.
//
//   npm run tours
//
// Tour copy is browser data, so the authored Markdown is compiled into the web bundle rather
// than read from a checkout-only path at runtime. The generated module embeds the exact source
// bytes; `test/tour-content.test.ts` imports this generator to keep it from drifting.
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { builtinMarkdownSources, renderBuiltinMarkdownModule } from "./builtin-markdown.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = join(root, "tours");
const outFile = join(root, "src", "web", "tour", "content.generated.ts");

export const NON_TOUR_DOCUMENTS = ["README.md"] as const;

const SPEC = {
  script: "scripts/tour-content.ts",
  sourceGlob: "tours/*.md",
  command: "npm run tours",
  constName: "TOUR_CONTENT_SOURCES",
  field: "markdown",
  doc: "/** The exact bytes of each guided tour copy document, in filename order. */",
} as const;

export interface TourContentSource {
  slug: string;
  markdown: string;
}

export function tourContentSources(dir = sourceDir): TourContentSource[] {
  return builtinMarkdownSources(dir, NON_TOUR_DOCUMENTS);
}

export function renderTourContentModule(sources: readonly TourContentSource[]): string {
  return renderBuiltinMarkdownModule(SPEC, sources);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sources = tourContentSources();
  writeFileSync(outFile, renderTourContentModule(sources));
  console.log(`Wrote ${sources.length} guided tour documents to ${outFile}`);
}
