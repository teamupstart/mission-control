// Guards 2 and 3 of the headless-mode plan (4.2): headless mode never touches the existing
// Focus feature. Guard 1 (a home-dispatched task keeps the dashboard's runtime) needs a started
// task, so it lives in `home-dispatch-drafts.test.ts`, where a confirmed draft starts one.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
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
  // The entries outside /dispatch include the 418 `main` records, plus the four flag-gated routes
  // of task shaping (the three /api/shaping routes, refreshed when one last changed, and
  // `GET /api/tasks/:id/shaping`), the three flag-gated session control request routes
  // (`POST /mcp/session-control/requests`, its `GET .../:requestId/wait`, and the dashboard's
  // `POST .../requests/:requestId/decline`), the async-input lifecycle routes
  // `POST /mcp/questions/list` and `POST /mcp/questions/:id/withdraw`, the three routes of
  // a session awaiting a background process (the flag-gated `POST /mcp/awaiting`, and
  // `POST /mcp/awaiting/clear` and the dashboard's `POST /api/sessions/:id/awaiting/clear`,
  // which stay open so a wait can always end), the four flag-gated agent report routes
  // (`POST /mcp/reports`, `POST /api/reports/:id/opened`, `POST /api/reports/:id/read` and
  // `GET /api/sessions/:id/reports`), the two flag-gated report answer routes
  // (`POST /api/reports/:id/reply` and `POST /api/reports/:id/follow-up`), the two flag-gated
  // report document routes (`GET /api/reports/:id/document` and `POST /api/reports/:id/publish`),
  // the Stuck row's flag-gated `POST /api/sessions/:id/inbox-message`, and the report lookup
  // `GET /api/reports/:id`, hashed key-sorted. Any added, removed
  // or changed non-dispatch entry changes the digest, so a route change outside /dispatch must
  // be a deliberate edit of this value, never a side effect of regenerating the oracle. Last
  // edited for task hibernation's two operator routes, `POST /api/sessions/:id/hibernate` and
  // `POST /api/tasks/:id/resume`, and for `GET /api/shipping/config` reporting
  // `codeRabbitAutoResolve: true`, CodeRabbit follow-up's new shipped default, and then for
  // task shaping's `GET /api/tasks/:id/shaping`, which answers 404 with its flag off, and then for
  // the agent report routes, which answer 404 with the `inbox` flag off, and then for the report
  // reply and follow-up routes, which answer 404 with it off too, then for
  // `GET /api/reviews/:id`, the earlier version a revised plan form links to, then for the Stuck
  // row's `POST /api/sessions/:id/inbox-message`, which answers 403 with the `inbox` flag off, and
  // then for the report document and Publish as scout routes, which answer 404 with it off, and
  // then for `GET /api/reports/:id` and `GET /api/ui/config` reporting the "What notifies you"
  // switches in `alerts`, all on. The recurring-mission MCP routes add GET/POST /mcp/schedules
  // and POST /mcp/schedules/preview, all answering 401 without a daemon token. Voice addressing's
  // eight routes (`GET` and `PUT /api/voice/config`, `POST /api/voice/mute`,
  // `POST /voice/listener/hello`, `POST /voice/shell-report`, the speech model's `POST` and
  // `DELETE /api/voice/model/download` and the input devices' `GET /api/voice/devices`) answer 404
  // with the `voice` flag off, and `POST /api/setup/install`'s refusal names the new
  // `voice-previews`, `voice-model` and `voice-microphone` ids. `GET /api/setup/checks` is
  // unchanged, and what voice adds to `GET /api/ui/config` is withheld with the flag off. Then
  // report noise controls' seven flag-gated routes (`GET /mcp/reports/guidance`, `GET` and `PUT
  // /api/reports/guidance`, `GET` and `POST /api/reports/mutes`, `DELETE
  // /api/reports/mutes/:authorKey` and `POST /api/reports/read-all`), which answer 404 with the
  // `inbox` flag off.
  // `POST /api/sessions/:id/inbox-message` then opened to the `idle-stalled` flag as well, so its
  // 403 with both flags off names both previews.
  // The six utterance, card action and Recently heard routes answer 404 with the voice preview off,
  // as do GET /voice/listener/directive and the dashboard's PUT /api/voice/indicators.
  // The macOS Terminal backend extends enum validation for Pipeline console, Pipeline install, and Setup install.
  // The listener's verified model lookup, GET /api/voice/model, answers 404 with the voice preview off.
  // Voice also gates GET, PUT and DELETE /api/voice/decision-key and POST /api/voice/config/provider-intent.
  // PUT /api/voice/confirmation and GET /api/voice/tasks/:id/follow-up both return 404 with Voice off.
  // PUT /api/voice/open-cards also returns 404 with Voice off.
  // The five speech routes for supervision, audio, playback events, Stop and audition also return 404 with Voice off.
  // Persona repository access adds the grant update and per-run repository query audit routes.
  // GET /api/voice/mute and POST /api/voice/hotkey-recording answer 404 with the voice preview off.
  // The synthesis model adds gated POST and DELETE /api/voice/speech/model/download.
  // Form submit refusal and inbox action claim and completion return 404 with Voice off.
  // The listener reports speech onset and completion through one additional voice-gated route.
  // Session settings adds the MCP entry point, the operator access pair and the skin refresh read.
  // Typed settings adds the narrow PATCH /api/workflows/config preference route.
  const others = Object.entries(oracle).filter(([key]) => !isDispatch(key)).sort(([a], [b]) => (a < b ? -1 : 1));
  assert.equal(others.length, 495);
  assert.equal(createHash("sha256").update(JSON.stringify(others)).digest("hex"),
    "c6cf88af34df95964944b4576f9d6bbde16bfd3c368bd04d28a125286cae6d06");
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

/**
 * `source` with comments blanked, so a comment between import tokens, or a commented-out import,
 * cannot hide or fake one. String literals are copied through untouched, so a `"/*"` in one string
 * and a `"*\/"` in a later one cannot swallow the import between them. Regex literals are not
 * parsed; none of the guarded files needs one before its imports.
 */
function withoutComments(source: string): string {
  let out = "";
  for (let i = 0; i < source.length;) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 2;
      out += " ";
    } else if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
    } else if (c === '"' || c === "'" || c === "`") {
      const start = i++;
      while (i < source.length && source[i] !== c) i += source[i] === "\\" ? 2 : 1;
      i++;
      out += source.slice(start, i);
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Every module specifier a file imports, re-exports or dynamically imports. */
function specifiers(source: string): string[] {
  return [...withoutComments(source).matchAll(/(?:from\s*|import\s*\(\s*|import\s+)["']([^"']+)["']/g)].map((match) => match[1]!);
}

const GUARDED = ["src/mod", "src/cli", "src/server/home-dispatch"];

/** The terminal-import rule: every specifier in `source` that reaches a `terminal` directory. */
export function terminalViolations(source: string): string[] {
  return specifiers(source).filter((specifier) => /(?:^|\/)terminal(?:\/|$)/.test(specifier));
}

/** The actions.ts rule: what `source`, living at `rel`, imports from actions.ts that it may not. */
export function actionsViolations(rel: string, source: string): string[] {
  const out: string[] = [];
  source = withoutComments(source);
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
  // A comment between the tokens neither hides a violation nor invents one.
  assert.equal(actionsViolations("src/server/home-dispatch/inbox.ts", `import { focus } from /* rationale */ "../actions.ts";`).length, 1, "comment before the specifier");
  assert.equal(actionsViolations(chat, `import { sendText, focus } /* why */ from "../actions.ts";`).length, 1, "comment before from");
  assert.deepEqual(terminalViolations(`import { x } from /* rationale */ "../terminal/tmux.ts";`), ["../terminal/tmux.ts"], "terminal import with a comment");
  assert.deepEqual(terminalViolations(`// import { x } from "../terminal/tmux.ts";`), [], "commented-out import");
  assert.deepEqual(actionsViolations("src/mod/x.ts", `/* import { focus } from "../actions.ts"; */`), [], "block-commented import");
  // Comment markers inside strings do not hide the import between them.
  const quoted = 'const start = "/*";\nimport { focus } from "../actions.ts";\nconst end = "*/";\n';
  assert.equal(actionsViolations("src/mod/x.ts", quoted).length, 1, "import between strings holding comment markers");
  assert.deepEqual(terminalViolations('const a = "/*";\nimport { x } from "../terminal/tmux.ts";\nconst b = "*/";\n'), ["../terminal/tmux.ts"]);
});
