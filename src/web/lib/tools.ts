import type { ToolCall, TranscriptMessage } from "@shared/types.ts";

// The expanded card's tool-call presentation. Pure, and here rather than in the
// component, so the parsing heuristics below can be checked against real transcript
// inputs in a table test instead of through a DOM.

/**
 * A rendered chip: what was invoked, and - the point of this module - what it was
 * invoked ON. A column of "Bash / Bash / Bash" says nothing; "bash ls", "bash curl"
 * is the same pixels carrying the actual story of the turn.
 */
export interface ToolChip {
  /** Tool name, lowercased ("bash", "read"); MCP tools as "server:tool". */
  name: string;
  /** The concrete target, capped for the chip. Null when the input carried none. */
  detail: string | null;
  /** The uncapped source of `detail` (the whole command, the full path) for the tooltip. */
  title: string;
}

/**
 * Cap on chip detail. A chip is a glance: past ~40 chars one long `grep` pattern
 * would push the rest of a merged row off the card, which is the crowding this whole
 * change exists to fix. The full text stays reachable through the shared tooltip.
 */
const DETAIL_CAP = 40;

/**
 * Read a string field out of a tool input.
 *
 * Tries JSON first, then falls back to a regex over the raw text, because the input
 * arrives capped at TOOL_INPUT_CAP and a truncated JSON string won't parse. The
 * fallback still gets the answer whenever the field precedes the cut - which is the
 * common case, since the interesting field (`command`, `file_path`) is rarely last.
 */
function strField(input: string, keys: readonly string[]): string | null {
  let parsed: Record<string, unknown> | null = null;
  try {
    const o: unknown = JSON.parse(input);
    if (o && typeof o === "object" && !Array.isArray(o)) parsed = o as Record<string, unknown>;
  } catch {
    // truncated or malformed - the raw scan below still has a shot
  }
  for (const key of keys) {
    const v = parsed?.[key];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (!parsed) {
      const raw = rawField(input, key);
      if (raw) return raw;
    }
  }
  return null;
}

/**
 * Pull `"key":"value"` out of unparseable JSON text, unescaping the value.
 *
 * Falls back to an UNTERMINATED match when the closing quote never comes, which is
 * not an edge case: TOOL_INPUT_CAP cuts at 1800 chars, and the calls that run past it
 * are the heredocs and long `--instructions` - exactly the ones a reader most wants
 * named. Measured on this machine's transcripts, the closed-only match left 88 `bash`
 * chips bare, nearly all of them a cut-off command. The head of a value is enough for
 * both things it feeds: a command name is its first token, and a title is a preview.
 */
function rawField(input: string, key: string): string | null {
  const closed = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(input);
  if (closed) return unescape(closed[1] ?? "");
  const open = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)$`).exec(input);
  if (!open) return null;
  // Drop the cap's ellipsis and any half-written escape, then re-mark it as cut.
  const head = unescape((open[1] ?? "").replace(/…$/, "").replace(/\\+$/, ""));
  return head ? `${head}…` : null;
}

/** JSON-unescape one string body, or null when it isn't valid. */
function unescape(body: string): string | null {
  try {
    return (JSON.parse(`"${body}"`) as string).trim() || null;
  } catch {
    return null;
  }
}

/** `FOO=bar cmd` - a shell assignment prefix, not the command. */
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Words that run another command; the one after them is the answer. */
const WRAPPERS = new Set(["sudo", "env", "time", "command", "exec", "nohup", "npx", "bunx"]);
/**
 * Scaffolding commands - real, but almost never why a call was made.
 *
 * `echo` earns its place here on the numbers: across this machine's transcripts it was
 * the single most common thing a bash chip named (212 of 940, more than `git` and `npm`
 * combined), essentially all of it the `echo "=== section ==="; git …` header habit. A
 * chip reading "bash echo" is the exact non-information this change exists to delete.
 * These lose to any real command in the line but still win over nothing, so a call that
 * is only an `echo` still gets named.
 */
const SETUP = new Set([
  "cd", "echo", "printf", "export", "set", "unset", "source", ".", "pushd", "popd", "true", ":",
]);

/**
 * The command a shell segment runs, or null when it has none (a comment, a bare
 * assignment). Skips flag and assignment prefixes and wrappers, and strips any
 * directory part, so `sudo /usr/bin/git push` reads `git`.
 */
function segmentCommand(seg: string): string | null {
  for (const token of seg.trim().split(/\s+/)) {
    const t = token.replace(/^[("'`$!{]+/, "");
    if (!t) continue;
    // Everything after a `#` is prose the shell never runs.
    if (t.startsWith("#")) return null;
    // A flag can never be the command; an assignment prefix (`FOO=bar cmd`) isn't it either.
    if (t.startsWith("-") || ENV_ASSIGN.test(t)) continue;
    const base = t.split("/").pop() ?? "";
    if (!base || WRAPPERS.has(base)) continue;
    return base;
  }
  return null;
}

/**
 * Collapse `$(…)` and backtick substitutions to an opaque token.
 *
 * This has to happen before the pipeline split, or the split walks straight into the
 * substitution's own operators: `f=$(ls -t *.jsonl | head -1); grep -c x "$f"` would
 * break at that inner `|` and report `head` - a command from inside an assignment the
 * line only makes to feed the `grep` that is the actual point. Collapsing first leaves
 * `f=$_; grep …`, where the assignment is a plain prefix and the answer is `grep`.
 *
 * Innermost-out, so a nested substitution collapses too; bounded because a heuristic
 * for a hover chip must not loop on pathological input.
 */
function stripSubstitutions(command: string): string {
  let out = command.replace(/`[^`]*`/g, () => "$_");
  for (let i = 0; i < 4; i++) {
    const next = out.replace(/\$\([^()]*\)/g, () => "$_");
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * Split a shell line on its top-level separators (`||`, `&&`, `;`, `|`, newline),
 * stepping over quoted spans.
 *
 * Quoting is structure, not decoration: a separator inside `'…'` or `"…"` is an
 * argument's text and splitting on it invents a segment out of the middle of a string,
 * whose first word then reads as a command. `echo "a|b" | wc -l` named `b"`, and
 * `echo "hello; world"` named `world"` - and it landed hardest on the `echo "=== … ==="`
 * habit this heuristic was tuned for, where the quoted text is the most likely place
 * for a stray `;` or `|` to sit.
 *
 * Same shape as `stripSubstitutions`, which runs first, and deliberately no more of a
 * shell than that: an unterminated quote (the input arrives capped at TOOL_INPUT_CAP)
 * simply swallows the rest of the line, which is the safe way to be wrong here - it
 * can only under-split, never name a fragment.
 */
function splitSegments(line: string): string[] {
  const segs: string[] = [];
  let start = 0;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      // A backslash escapes inside "…" but is a literal inside '…'.
      if (quote === '"' && c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    const two = line.slice(i, i + 2);
    const width = two === "||" || two === "&&" ? 2 : c === ";" || c === "|" || c === "\n" ? 1 : 0;
    if (width === 0) continue;
    segs.push(line.slice(start, i));
    i += width - 1;
    start = i + 1;
  }
  segs.push(line.slice(start));
  return segs;
}

/**
 * The command name a Bash call is really about: the first non-scaffolding command
 * across the line, so `cd /repo && sqlite3 state.db …` reads `sqlite3` rather than
 * `cd`, and `echo "=== status ==="; git log` reads `git`. Scaffolding is the answer
 * only when there's nothing else - naming an `echo` beats naming nothing. A heuristic
 * by nature; the tooltip carries the literal command.
 */
export function commandName(command: string): string | null {
  let scaffold: string | null = null;
  for (const seg of splitSegments(stripSubstitutions(command))) {
    const name = segmentCommand(seg);
    if (!name) continue;
    if (!SETUP.has(name)) return name;
    scaffold ??= name;
  }
  return scaffold;
}

/** Keys worth showing, per tool. First one present wins. */
const DETAIL_KEYS: Record<string, readonly string[]> = {
  read: ["file_path"],
  write: ["file_path"],
  edit: ["file_path"],
  notebookedit: ["notebook_path"],
  glob: ["pattern"],
  grep: ["pattern"],
  task: ["description"],
  agent: ["description"],
  skill: ["skill"],
  webfetch: ["url"],
  websearch: ["query"],
  toolsearch: ["query"],
  artifact: ["file_path"],
  senduserfile: ["caption"],
};
/** Fallback for a tool we don't know (MCP servers, new built-ins). */
const GENERIC_KEYS = ["description", "name", "file_path", "path", "pattern", "query", "url"];

/** Display name for a tool: `mcp__chrome-devtools__click` reads `chrome-devtools:click`. */
function chipName(name: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  return (mcp ? `${mcp[1]}:${mcp[2]}` : name).toLowerCase();
}

/** Head-truncate to the chip cap. */
function cap(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > DETAIL_CAP ? `${flat.slice(0, DETAIL_CAP - 1)}…` : flat;
}

/** What to render for one tool call: its name, and the concrete thing it acted on. */
export function toolChip(t: ToolCall): ToolChip {
  // `chipName` lowercases, so it doubles as the lookup key for the tables above.
  const name = chipName(t.name);
  if (!t.input) return { name, detail: null, title: t.name };

  const isShell = name === "bash" || name === "bashoutput";
  const source = strField(t.input, isShell ? ["command"] : (DETAIL_KEYS[name] ?? GENERIC_KEYS));
  if (!source) return { name, detail: null, title: t.name };

  // A shell call chips the command name (`ls`), not the command line - the line is the
  // tooltip. Path-valued tools chip the basename for the same reason: the leaf identifies
  // the file, the directories just eat the row.
  const detail = isShell
    ? commandName(source)
    : source.startsWith("/")
      ? (source.split("/").pop() ?? source)
      : source;
  return { name, detail: detail ? cap(detail) : null, title: source };
}

/** A transcript row: a real turn, or a run of tool-only turns folded into one line. */
export type TranscriptRow =
  | { kind: "turn"; id: string; ts: number; message: TranscriptMessage }
  | {
      kind: "tools";
      id: string;
      ts: number;
      /**
       * The LAST folded turn's time, where `ts` is the first one's.
       *
       * The only elapsed number this data can honestly produce. There is no per-call
       * duration anywhere in the transcript contract - `ToolCall` carries a name and a
       * capped input and nothing else - so `endTs - ts` is the span the run OCCUPIED
       * between two recorded timestamps, not how long any tool took, and the terminal
       * rendering labels it as exactly that. Equal to `ts` on a run of one, which is why
       * the presentation shows nothing rather than "0s".
       */
      endTs: number;
      tools: ToolCall[];
    };

/**
 * Fold consecutive tool-only assistant turns into one row.
 *
 * An agent working through a task emits a long run of turns that are nothing but a
 * tool call, and each one rendered as its own turn is a screen of "CLAUDE" headers
 * with a lone chip under each - all frame, no content. They're one continuous action
 * as far as a reader is concerned, so they get one line. Turns carrying prose are
 * left exactly as they are: the words are the reason the panel exists.
 *
 * The row keeps the FIRST folded turn's id, so a run that grows as new turns stream
 * in keeps its React key (and the reader's scroll position) instead of remounting.
 * Its `ts` comes from that same first turn, for the same reason and one more: a run
 * that keeps absorbing turns would otherwise walk forward in time while the reader
 * looks at it, and anything interleaved by timestamp (a Foreman episode) would jump
 * position as it did.
 */
export function transcriptRows(messages: TranscriptMessage[]): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  for (const m of messages) {
    if (m.role !== "assistant" || m.text || m.tools.length === 0) {
      rows.push({ kind: "turn", id: m.id, ts: m.ts, message: m });
      continue;
    }
    const last = rows[rows.length - 1];
    if (last?.kind === "tools") {
      last.tools = [...last.tools, ...m.tools];
      // Only ever forward: an undated turn (`ts` 0) joining a dated run must not drag the
      // span backwards into a negative number the presentation would have to guard.
      last.endTs = Math.max(last.endTs, m.ts);
    } else rows.push({ kind: "tools", id: m.id, ts: m.ts, endTs: m.ts, tools: [...m.tools] });
  }
  return rows;
}
