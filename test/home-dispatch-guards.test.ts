// Guards 2 and 3 of the headless-mode plan (4.2): headless mode never touches the existing
// Focus feature. Guard 1 (a home-dispatched task keeps the dashboard's runtime) needs a started
// task and is added by the phase that first starts one.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;
const oracle = JSON.parse(readFileSync(join(root, "test/fixtures/route-surface.json"), "utf8")) as Record<string, string>;

test("guard 2: the route oracle's Focus and terminal entries are the ones `main` recorded", () => {
  // Copied from `main`'s oracle before headless mode. Changing one is a Focus change and must
  // be a deliberate edit of this table, not a side effect of regenerating the oracle.
  const recorded: Record<string, string> = {
    "GET /api/terminal-targets": "200 fields{targets}",
    "GET /api/terminals/config": "200 {\"externalSessions\":false,\"multiplexerTerminal\":{\"cmux\":null,\"herdr\":null,\"tmux\":null}}",
    "POST /api/sessions/:id/focus": "404 {\"error\":\"no such session\"}",
    "PUT /api/terminals/config": "400 {\"error\":\"[\\n  {\\n    \\\"code\\\": \\\"custom\\\",\\n    \\\"path\\\": [],\\n    \\\"message\\\": \\\"empty config update\\\"\\n  }\\n]\"}",
  };
  const current = Object.fromEntries(Object.entries(oracle).filter(([key]) => /focus|terminal/i.test(key) && !key.includes("/dispatch/")));
  assert.deepEqual(current, recorded);
});

test("guard 2: the regenerated oracle adds /dispatch entries and changes no other entry", () => {
  const isDispatch = (key: string) => key.split(" ")[1]?.startsWith("/dispatch/") === true;
  const dispatch = Object.keys(oracle).filter(isDispatch);
  assert.equal(dispatch.length, 14);
  for (const key of dispatch) assert.match(oracle[key]!, /^404 /, `${key} is disabled in the oracle's default build`);
  // The 416 entries `main` records outside /dispatch (refreshed when `main` last changed one), hashed key-sorted. Any added, removed
  // or changed non-dispatch entry changes the digest, so a route change outside /dispatch must
  // be a deliberate edit of this value, never a side effect of regenerating the oracle.
  const others = Object.entries(oracle).filter(([key]) => !isDispatch(key)).sort(([a], [b]) => (a < b ? -1 : 1));
  assert.equal(others.length, 416);
  assert.equal(createHash("sha256").update(JSON.stringify(others)).digest("hex"),
    "a024968494352f725e6f719aabbb86cf9b06a3596e399f35704172ee0e9dab56");
});

function sourceFiles(dir: string): string[] {
  const full = join(root, dir);
  if (!existsSync(full)) return []; // src/mod and src/cli arrive in later phases
  const out: string[] = [];
  for (const entry of readdirSync(full)) {
    const path = join(full, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(relative(root, path)));
    else if (/\.(?:ts|tsx|mts|mjs|js)$/.test(entry)) out.push(path);
  }
  return out;
}

/** Every module specifier a file imports, re-exports or dynamically imports. */
function specifiers(source: string): string[] {
  return [...source.matchAll(/(?:from\s*|import\s*\(\s*|import\s+)["']([^"']+)["']/g)].map((match) => match[1]!);
}

const GUARDED = ["src/mod", "src/cli", "src/server/home-dispatch"];

/** The terminal-import rule: every specifier in `source` that reaches a `terminal` directory. */
export function terminalViolations(source: string): string[] {
  return specifiers(source).filter((specifier) => /(?:^|\/)terminal(?:\/|$)/.test(specifier));
}

/** The actions.ts rule: what `source`, living at `rel`, imports from actions.ts that it may not. */
export function actionsViolations(rel: string, source: string): string[] {
  const out: string[] = [];
  const imports = [...source.matchAll(/import\s+(type\s+)?([^;]*?)\s+from\s+["']([^"']*\/actions\.ts)["']/gs)];
  const reExports = [...source.matchAll(/export\s+[^;]*?from\s+["']([^"']*\/actions\.ts)["']/gs)];
  const dynamic = [...source.matchAll(/import\s*\(\s*["'][^"']*\/actions\.ts["']\s*\)/g)];
  if (reExports.length + dynamic.length > 0) out.push("re-export or dynamic import of actions.ts");
  for (const [, typeOnly, clause] of imports) {
    if (typeOnly) continue;
    if (rel !== "src/server/home-dispatch/chat.ts") out.push(`${rel} imports actions.ts`);
    else if (!/^\{\s*sendText\s*\}$/.test(clause!)) out.push(`imports more than sendText: ${clause}`);
  }
  return out;
}

test("guard 3: nothing headless imports src/server/terminal/", () => {
  for (const file of GUARDED.flatMap(sourceFiles)) {
    assert.deepEqual(terminalViolations(readFileSync(file, "utf8")), [], relative(root, file));
  }
});

test("guard 3: only chat.ts imports from actions.ts, and only sendText", () => {
  for (const file of GUARDED.flatMap(sourceFiles)) {
    assert.deepEqual(actionsViolations(relative(root, file), readFileSync(file, "utf8")), [], relative(root, file));
  }
});

test("guard 3 rejects a violating file and accepts the allowed import", () => {
  const chat = "src/server/home-dispatch/chat.ts";
  assert.deepEqual(terminalViolations(`import { x } from "../terminal/tmux.ts";`), ["../terminal/tmux.ts"]);
  assert.deepEqual(terminalViolations(`await import("../../server/terminal/herdr.ts");`), ["../../server/terminal/herdr.ts"]);
  assert.deepEqual(terminalViolations(`import { z } from "zod";`), []);
  assert.deepEqual(actionsViolations(chat, `import { sendText } from "../actions.ts";`), []);
  assert.equal(actionsViolations(chat, `import { sendText, focus } from "../actions.ts";`).length, 1, "focus beside sendText");
  assert.equal(actionsViolations(chat, `import { raiseThrough } from "../actions.ts";`).length, 1);
  assert.equal(actionsViolations("src/server/home-dispatch/inbox.ts", `import { sendText } from "../actions.ts";`).length, 1, "only chat.ts may import it");
  assert.equal(actionsViolations(chat, `export { focus } from "../actions.ts";`).length, 1, "re-export");
  assert.equal(actionsViolations(chat, `const a = await import("../actions.ts");`).length, 1, "dynamic import");
  assert.deepEqual(actionsViolations("src/mod/x.ts", `import type { Action } from "../actions.ts";`), [], "type-only imports are erased");
});
