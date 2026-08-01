#!/usr/bin/env node
// Regenerate `src/server/workflows/builtin-personas.generated.ts` from `docs/personas/*.md`.
//
//   npm run personas
//
// TypeScript rather than the `.mjs` its sibling scripts use, because `builtin-personas.test.ts`
// imports the two functions below to prove the committed module is exactly what regenerating
// produces. A drift check that re-implemented the renderer would agree with itself, not with
// this script.
//
// Run this after editing, adding or removing a Persona document, and commit the result.
//
// The reading and rendering live in `builtin-markdown.ts`, which also states why the
// Markdown is compiled in rather than read at runtime. This file owns only the two facts
// that are this generator's own: where the documents are, and what the module is called.
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinMarkdownSources, renderBuiltinMarkdownModule } from "./builtin-markdown.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = join(root, "docs", "personas");
const outFile = join(root, "src", "server", "workflows", "builtin-personas.generated.ts");

const SPEC = {
  script: "scripts/builtin-personas.ts",
  sourceGlob: "docs/personas/*.md",
  command: "npm run personas",
  constName: "BUILTIN_PERSONA_SOURCES",
  field: "guidanceMarkdown",
  doc: "/** The exact bytes of each shipped Persona document, in filename order. */",
} as const;

export interface BuiltinPersonaSource {
  slug: string;
  guidanceMarkdown: string;
}

/** The slug is the filename, and it is the durable half of the built-in's id. */
export function builtinPersonaSources(dir = sourceDir): BuiltinPersonaSource[] {
  return builtinMarkdownSources(dir)
    .map((source) => ({ slug: source.slug, guidanceMarkdown: source.markdown }));
}

export function renderBuiltinPersonaModule(sources: readonly BuiltinPersonaSource[]): string {
  return renderBuiltinMarkdownModule(
    SPEC,
    sources.map((source) => ({ slug: source.slug, markdown: source.guidanceMarkdown })),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sources = builtinPersonaSources();
  writeFileSync(outFile, renderBuiltinPersonaModule(sources));
  console.log(`Wrote ${sources.length} built-in Persona${sources.length === 1 ? "" : "s"} to ${outFile}`);
}
