// The `mod-calls` check (spec 7.10): the Claude Code mod calls the daemon at `/api/health` and
// `/dispatch/*` and nowhere else. `src/mod/allowed-calls.json` is the allowlist; this scans the
// mod's source for any path literal that starts a daemon route and is not on it. Shared by
// `smoke-bundles.mjs` and `test/home-dispatch-mod-core.test.ts`, so there is one definition.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

/**
 * Whether a `/` here starts a regular expression rather than dividing: after an operator, an open
 * bracket, a separator, a keyword like `return`, or at the start of the file.
 */
function startsRegex(out) {
  const before = out.trimEnd();
  if (before === "") return true;
  if ("(,=:[!&|?{};+-*%<>~^".includes(before.at(-1))) return true;
  return /(?:^|[^\w])(?:return|typeof|case|in|of|void|delete|throw|yield|await)$/.test(before);
}

/**
 * The source with its comments blanked, so prose that quotes an example path is not mistaken for
 * a call. Strings, template literals and regular expression literals are walked as units, so a
 * `//` inside one (a URL, or the end of a regex like `/\//`) is not a comment and nothing after it
 * on the line is hidden from the scan.
 */
export function stripComments(text) {
  let out = "";
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
    } else if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      // Keep the line breaks so nothing else shifts.
      out += text.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else if (c === "/" && startsRegex(out)) {
      let j = i + 1;
      let inClass = false;
      while (j < text.length && text[j] !== "\n") {
        if (text[j] === "\\") j += 2;
        else if (text[j] === "[") { inClass = true; j += 1; }
        else if (text[j] === "]") { inClass = false; j += 1; }
        else if (text[j] === "/" && !inClass) break;
        else j += 1;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/** The `{ file, path }` of every daemon path literal under `src/mod` that the allowlist refuses. */
export function findDisallowedModCalls(root) {
  const allowed = JSON.parse(readFileSync(join(root, "src/mod/allowed-calls.json"), "utf8"));
  const found = [];
  for (const file of sourceFiles(join(root, "src/mod"))) {
    const text = stripComments(readFileSync(file, "utf8"));
    // A quoted or template literal that begins with `/api` or `/dispatch`.
    for (const match of text.matchAll(/["'`](\/(?:api|dispatch)[^"'`\s]*)["'`]/g)) {
      const path = match[1];
      if (!isAllowedModCall(path, allowed)) found.push({ file, path });
    }
  }
  return found;
}
