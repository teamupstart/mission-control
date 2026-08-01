// The one reader and the one renderer behind every "compile authored Markdown into the
// build" generator.
//
// Shared rather than copied, because the two callers make the SAME promise - the committed
// module contains the exact bytes of the documents this build was made from - and their
// drift tests prove it by importing the generator itself. Two renderers would each agree
// with their own test and could still emit different escaping for the same document.
//
// ## Why the Markdown is compiled in rather than read at runtime
//
// These documents are app data: every build serves exactly the text it was made from.
// `docs/` is not in the packaged app, and esbuild collapses the daemon into
// `dist/server/index.mjs`, so any module that read those files at runtime would resolve a
// path that exists in the checkout and not in a packaged build - the failure that looks like
// a feature quietly missing rather than a build that breaks.
//
// This module therefore does one thing and no interpretation: it embeds exact bytes. Names
// and descriptions are derived at load time by the server module that consumes them, and
// the durable id comes from the filename slug.
import { readFileSync, readdirSync } from "node:fs";

/** One authored document: its filename slug and its exact bytes. */
export interface BuiltinMarkdownSource {
  slug: string;
  markdown: string;
}

/**
 * The documents in a directory, in filename order.
 *
 * The slug is the filename, and it is the durable half of each built-in's id, so the sort
 * is explicit and locale-pinned rather than left to whatever order the filesystem returns.
 */
export function builtinMarkdownSources(dir: string): BuiltinMarkdownSource[] {
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".md"))
    .sort((a, b) => a.localeCompare(b, "en-US"))
    .map((entry) => ({
      slug: entry.slice(0, -".md".length),
      markdown: readFileSync(`${dir}/${entry}`, "utf8"),
    }));
}

export interface BuiltinModuleSpec {
  /** The script a reader should run, e.g. `scripts/builtin-personas.ts`. */
  script: string;
  /** The authored source, e.g. `docs/personas/*.md`. */
  sourceGlob: string;
  /** The package script that regenerates this module, e.g. `npm run personas`. */
  command: string;
  /** The exported constant's name, e.g. `BUILTIN_PERSONA_SOURCES`. */
  constName: string;
  /** The field each entry carries its bytes under, e.g. `guidanceMarkdown`. */
  field: string;
  /** The doc comment above the constant, including its `/** … *\/` delimiters. */
  doc: string;
}

export function renderBuiltinMarkdownModule(
  spec: BuiltinModuleSpec,
  sources: readonly BuiltinMarkdownSource[],
): string {
  const entries = sources
    .map((source) => `  {\n    slug: ${JSON.stringify(source.slug)},\n`
      + `    ${spec.field}: ${JSON.stringify(source.markdown)},\n  },`)
    .join("\n");
  return `// GENERATED FILE - do not edit by hand.\n`
    + `//\n`
    + `// Written by \`${spec.script}\` from \`${spec.sourceGlob}\`, which are the\n`
    + `// authored source. Edit the Markdown there and run \`${spec.command}\`.\n`
    + `\n`
    + `${spec.doc}\n`
    + `export const ${spec.constName} = [\n${entries}\n] as const;\n`;
}
