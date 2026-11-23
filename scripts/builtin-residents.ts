#!/usr/bin/env node
// Regenerate `src/server/residents/builtin-residents.generated.ts` from `residents/*.md`.
//
//   npm run residents
//
// The sibling of `builtin-personas.ts`, sharing its reader and renderer, and TypeScript for the
// same reason: `builtin-residents.test.ts` imports the two functions below to prove the
// committed module is exactly what regenerating produces.
//
// Run this after editing, adding or removing a built-in resident document, and commit the
// result.
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinMarkdownSources, renderBuiltinMarkdownModule } from "./builtin-markdown.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = join(root, "residents");
const outFile = join(root, "src", "server", "residents", "builtin-residents.generated.ts");

/** The documents in `residents/` that are not built-in residents: the directory's own README. */
export const NON_RESIDENT_DOCUMENTS = ["README.md"] as const;

const SPEC = {
  script: "scripts/builtin-residents.ts",
  sourceGlob: "residents/*.md",
  command: "npm run residents",
  constName: "BUILTIN_RESIDENT_SOURCES",
  field: "instructionsMarkdown",
  doc: "/** The exact bytes of each shipped resident document, in filename order. */",
} as const;

export interface BuiltinResidentSource {
  slug: string;
  instructionsMarkdown: string;
}

/** The slug is the filename, and it is the durable half of the built-in's profile id. */
export function builtinResidentSources(dir = sourceDir): BuiltinResidentSource[] {
  return builtinMarkdownSources(dir, NON_RESIDENT_DOCUMENTS)
    .map((source) => ({ slug: source.slug, instructionsMarkdown: source.markdown }));
}

export function renderBuiltinResidentModule(sources: readonly BuiltinResidentSource[]): string {
  return renderBuiltinMarkdownModule(
    SPEC,
    sources.map((source) => ({ slug: source.slug, markdown: source.instructionsMarkdown })),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sources = builtinResidentSources();
  writeFileSync(outFile, renderBuiltinResidentModule(sources));
  console.log(`Wrote ${sources.length} built-in resident${sources.length === 1 ? "" : "s"} to ${outFile}`);
}
