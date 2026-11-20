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
  // The 416 entries `main` recorded before headless mode, hashed key-sorted. Any added, removed
  // or changed non-dispatch entry changes the digest, so a route change outside /dispatch must
  // be a deliberate edit of this value, never a side effect of regenerating the oracle.
  const others = Object.entries(oracle).filter(([key]) => !isDispatch(key)).sort(([a], [b]) => (a < b ? -1 : 1));
  assert.equal(others.length, 416);
  assert.equal(createHash("sha256").update(JSON.stringify(others)).digest("hex"),
    "ce6c9ebba3ac9513ba78646bfc575041b80c70ded387d8bc4c5dd786f0cb16af");
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

test("guard 3: nothing headless imports src/server/terminal/", () => {
  for (const file of GUARDED.flatMap(sourceFiles)) {
    for (const specifier of specifiers(readFileSync(file, "utf8"))) {
      assert.doesNotMatch(specifier, /(?:^|\/)terminal(?:\/|$)/, `${relative(root, file)} imports ${specifier}`);
    }
  }
});

test("guard 3: only chat.ts imports from actions.ts, and only sendText", () => {
  for (const file of GUARDED.flatMap(sourceFiles)) {
    const source = readFileSync(file, "utf8");
    const rel = relative(root, file);
    const imports = [...source.matchAll(/import\s+(type\s+)?([^;]*?)\s+from\s+["']([^"']*\/actions\.ts)["']/gs)];
    const reExports = [...source.matchAll(/export\s+[^;]*?from\s+["']([^"']*\/actions\.ts)["']/gs)];
    const dynamic = [...source.matchAll(/import\s*\(\s*["'][^"']*\/actions\.ts["']\s*\)/g)];
    assert.equal(reExports.length + dynamic.length, 0, `${rel} reaches actions.ts by re-export or dynamic import`);
    for (const [, typeOnly, clause] of imports) {
      if (typeOnly) continue;
      assert.equal(rel, "src/server/home-dispatch/chat.ts", `${rel} imports actions.ts`);
      assert.match(clause!, /^\{\s*sendText\s*\}$/, `${rel} imports more than sendText: ${clause}`);
    }
  }
});

test("guard 3 sees a violation when one exists", () => {
  assert.deepEqual(specifiers(`import { focus } from "../actions.ts";\nawait import("../terminal/tmux.ts");`),
    ["../actions.ts", "../terminal/tmux.ts"]);
});
