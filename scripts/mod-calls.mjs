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

/** The index just past a quoted string that starts at `i`. */
function skipString(text, i) {
  const quote = text[i];
  let j = i + 1;
  while (j < text.length && text[j] !== quote) j += text[j] === "\\" ? 2 : 1;
  return j + 1;
}

/**
 * The index just past a template literal that starts at `i` (a backtick). A `${ ... }` inside it is
 * code, so it is walked on its own terms: its braces are counted, and strings and further template
 * literals in it (`/api/${flag ? `a` : `b`}`) are skipped whole instead of closing the outer one.
 */
function skipTemplate(text, i) {
  let j = i + 1;
  while (j < text.length) {
    const c = text[j];
    if (c === "\\") j += 2;
    else if (c === "`") return j + 1;
    else if (c === "$" && text[j + 1] === "{") j = skipExpression(text, j + 2);
    else j += 1;
  }
  return text.length;
}

/** The index just past the `}` that closes a `${` whose expression starts at `j`. */
function skipExpression(text, j) {
  let depth = 1;
  while (j < text.length && depth > 0) {
    const c = text[j];
    if (c === '"' || c === "'") j = skipString(text, j);
    else if (c === "`") j = skipTemplate(text, j);
    else if (c === "/" && text[j + 1] === "/") while (j < text.length && text[j] !== "\n") j += 1;
    else if (c === "/" && text[j + 1] === "*") {
      const end = text.indexOf("*/", j + 2);
      j = end === -1 ? text.length : end + 2;
    } else {
      if (c === "{") depth += 1;
      else if (c === "}") depth -= 1;
      j += 1;
    }
  }
  return j;
}

/**
 * The source with its comments blanked, so prose that quotes an example path is not mistaken for
 * a call. Strings, template literals (with their nested `${}` code) and regular expression literals
 * are walked as units, so a `//` inside one (a URL, or the end of a regex like `/\//`) is not a
 * comment and nothing after it on the line is hidden from the scan.
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
      const stop = c === "`" ? skipTemplate(text, i) : skipString(text, i);
      out += text.slice(i, stop);
      i = stop;
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
    // A quoted or template literal that begins with `/api` or `/dispatch`: its whole text up to the
    // closing quote, or its static prefix up to a `${` (the rest is built at run time, so the prefix is
    // what can be judged: `/dispatch/drafts/${id}` is `/dispatch/drafts/`, and `/api/${x}` is `/api/`).
    for (const match of text.matchAll(/["'`](\/(?:api|dispatch)[^"'`\s$]*)(?:["'`]|\$\{)/g)) {
      const path = match[1];
      if (!isAllowedModCall(path, allowed)) found.push({ file, path });
    }
  }
  return found;
}
