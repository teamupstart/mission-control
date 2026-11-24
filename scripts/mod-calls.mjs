// The `mod-calls` check (spec 7.10): the Claude Code mod calls the daemon at `/api/health` and
// `/dispatch/*` and nowhere else. `src/mod/allowed-calls.json` is the allowlist; this scans the
// mod's source for any path literal that starts a daemon route and is not on it. Shared by
// `smoke-bundles.mjs` and `test/home-dispatch-mod-core.test.ts`, so there is one definition.
//
// The source is read by the TypeScript parser, not by hand. Which `/` starts a regular expression,
// where a template's `${}` ends, and what is a comment are questions only a real tokenizer answers
// in every case; a hand-written one was patched once per case a review found. Comments are not
// nodes, so prose that quotes an example path never counts, and every literal is seen whole.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/** Every `.ts` and `.tsx` file under `dir`. */
function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

/** Whether `path` (query stripped) is on the allowlist. */
export function isAllowedModCall(path, allowed) {
  const bare = path.split("?")[0];
  return allowed.exact.includes(bare) || allowed.prefixes.some((prefix) => bare.startsWith(prefix));
}

/** Whether a literal's static text starts a daemon route, and so is judged. */
const startsDaemonRoute = (text) => text.startsWith("/api") || text.startsWith("/dispatch");

/**
 * The static text of every string and template literal in `source`, in source order. A quoted
 * string and a template with no `${}` are static, so their whole text is a path (`"/api/a${b}/c"` is
 * that exact path). A template with `${}` is built at run time, so only the text before its first
 * `${` is known (`/dispatch/drafts/${id}` is `/dispatch/drafts/`). Literals nested inside a `${}`
 * are visited too.
 */
export function pathLiterals(source, fileName = "source.ts") {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, kind);
  const out = [];
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text);
    else if (ts.isTemplateExpression(node)) out.push(node.head.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

/** The `{ file, path }` of every daemon path literal under `src/mod` that the allowlist refuses. */
export function findDisallowedModCalls(root) {
  const allowed = JSON.parse(readFileSync(join(root, "src/mod/allowed-calls.json"), "utf8"));
  const found = [];
  for (const file of sourceFiles(join(root, "src/mod"))) {
    for (const path of pathLiterals(readFileSync(file, "utf8"), file)) {
      if (startsDaemonRoute(path) && !isAllowedModCall(path, allowed)) found.push({ file, path });
    }
  }
  return found;
}
