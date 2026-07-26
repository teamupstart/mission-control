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
// ## Why the Markdown is compiled in rather than read at runtime
//
// The built-in Personas are app data: every build serves exactly the guidance it was made
// from. `docs/personas/` is not in the packaged app, and esbuild collapses the daemon into
// `dist/server/index.mjs`, so any module that read those files at runtime would resolve a
// path that exists in the checkout and not in a packaged build - the failure that looks
// like a feature quietly missing rather than a build that breaks.
//
// This script therefore does one thing and no interpretation: it embeds the exact bytes of
// each document. Name, description and id are derived from those bytes at load time by
// `builtin-personas.ts`, using the same shared helpers `Import .md` uses, so nothing about
// a Persona is stated twice.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = join(root, "docs", "personas");
const outFile = join(root, "src", "server", "workflows", "builtin-personas.generated.ts");

export interface BuiltinPersonaSource {
  slug: string;
  guidanceMarkdown: string;
}

/** The slug is the filename, and it is the durable half of the built-in's id. */
export function builtinPersonaSources(dir = sourceDir): BuiltinPersonaSource[] {
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".md"))
    .sort((a, b) => a.localeCompare(b, "en-US"))
    .map((entry) => ({
      slug: entry.slice(0, -".md".length),
      guidanceMarkdown: readFileSync(join(dir, entry), "utf8"),
    }));
}

export function renderBuiltinPersonaModule(sources: readonly BuiltinPersonaSource[]): string {
  const entries = sources
    .map((source) => `  {\n    slug: ${JSON.stringify(source.slug)},\n`
      + `    guidanceMarkdown: ${JSON.stringify(source.guidanceMarkdown)},\n  },`)
    .join("\n");
  return `// GENERATED FILE - do not edit by hand.\n`
    + `//\n`
    + `// Written by \`scripts/builtin-personas.ts\` from \`docs/personas/*.md\`, which are the\n`
    + `// authored source. Edit the Markdown there and run \`npm run personas\`.\n`
    + `\n`
    + `/** The exact bytes of each shipped Persona document, in filename order. */\n`
    + `export const BUILTIN_PERSONA_SOURCES = [\n${entries}\n] as const;\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sources = builtinPersonaSources();
  writeFileSync(outFile, renderBuiltinPersonaModule(sources));
  console.log(`Wrote ${sources.length} built-in Persona${sources.length === 1 ? "" : "s"} to ${outFile}`);
}
