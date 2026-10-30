import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { ResidentMcpEntry } from "../types.ts";

// A resident run's private `CODEX_HOME`: the measured Codex control that starts exactly the
// run's MCP snapshot (`HARNESS_CAPABILITIES.codex.mcpSelection`).
//
// The overlay links every entry of the operator's Codex home back to it - authentication, the
// session files Mission Control reads, instructions, rules, state - except `config.toml`, which
// it generates on every start: the operator's configuration with every MCP server statement
// removed, then the snapshot's servers. The native MCP table is never copied, rendered or
// logged, and the generated file holds no secret: secret-bearing servers are launcher entries.
//
// An overlay alone is not an exact set. Codex also merges a trusted project's
// `.codex/config.toml` and any system or managed configuration, so every start is verified
// against `config/read`'s layers before a thread loads a server (`codexResidentMcpVerdict`).

/** The operator's Codex home, as the daemon sees it. */
export function operatorCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME || join(homedir(), ".codex");
}

// ---- removing MCP statements from TOML without re-serializing it ----

class TomlScanError extends Error {}

/** The decoded segments of a TOML key starting at `i`, and where the key ends. */
function readKey(text: string, start: number, stop: (ch: string) => boolean): { path: string[]; end: number } {
  const path: string[] = [];
  let i = start;
  const skipSpace = (): void => {
    while (text[i] === " " || text[i] === "\t") i++;
  };
  skipSpace();
  for (;;) {
    const ch = text[i];
    if (ch === '"') {
      let out = "";
      i++;
      while (text[i] !== '"') {
        if (i >= text.length || text[i] === "\n") throw new TomlScanError("unterminated key");
        if (text[i] === "\\") {
          const esc = text[i + 1];
          const map: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
          if (esc && esc in map) {
            out += map[esc];
            i += 2;
          } else if (esc === "u" || esc === "U") {
            const length = esc === "u" ? 4 : 8;
            out += String.fromCodePoint(Number.parseInt(text.slice(i + 2, i + 2 + length), 16));
            i += 2 + length;
          } else throw new TomlScanError("bad escape in key");
        } else out += text[i++];
      }
      i++;
      path.push(out);
    } else if (ch === "'") {
      const close = text.indexOf("'", i + 1);
      if (close < 0) throw new TomlScanError("unterminated key");
      path.push(text.slice(i + 1, close));
      i = close + 1;
    } else {
      const begin = i;
      while (i < text.length && /[A-Za-z0-9_-]/.test(text[i]!)) i++;
      if (i === begin) throw new TomlScanError("empty key");
      path.push(text.slice(begin, i));
    }
    skipSpace();
    if (text[i] === ".") {
      i++;
      skipSpace();
      continue;
    }
    if (!stop(text[i] ?? "")) throw new TomlScanError("unexpected character after key");
    return { path, end: i };
  }
}

/** Skip one TOML value starting at `i`; returns the index just after it. */
function skipValue(text: string, start: number): number {
  let i = start;
  const ch = text[i];
  if (text.startsWith('"""', i) || text.startsWith("'''", i)) {
    const quote = text.slice(i, i + 3);
    i += 3;
    for (;;) {
      if (i >= text.length) throw new TomlScanError("unterminated string");
      if (quote === '"""' && text[i] === "\\") {
        i += 2;
        continue;
      }
      if (text.startsWith(quote, i)) {
        i += 3;
        // Up to two more quote characters belong to the string's content.
        for (let extra = 0; extra < 2 && text[i] === quote[0]; extra++) i++;
        return i;
      }
      i++;
    }
  }
  if (ch === '"') {
    i++;
    while (text[i] !== '"') {
      if (i >= text.length || text[i] === "\n") throw new TomlScanError("unterminated string");
      i += text[i] === "\\" ? 2 : 1;
    }
    return i + 1;
  }
  if (ch === "'") {
    const close = text.indexOf("'", i + 1);
    if (close < 0 || text.slice(i, close).includes("\n")) throw new TomlScanError("unterminated string");
    return close + 1;
  }
  if (ch === "[" || ch === "{") {
    const closer = ch === "[" ? "]" : "}";
    i++;
    for (;;) {
      while (i < text.length && /[\s,]/.test(text[i]!)) i++;
      if (text[i] === "#") {
        while (i < text.length && text[i] !== "\n") i++;
        continue;
      }
      if (text[i] === closer) return i + 1;
      if (i >= text.length) throw new TomlScanError("unterminated array or table");
      if (closer === "}") {
        const key = readKey(text, i, (c) => c === "=");
        i = key.end + 1;
        while (text[i] === " " || text[i] === "\t") i++;
      }
      i = skipValue(text, i);
    }
  }
  // A bare scalar: number, boolean or date-time, up to a delimiter.
  while (i < text.length && !/[,\]}\n#]/.test(text[i]!)) i++;
  return i;
}

const isMcp = (path: readonly string[]): boolean => path[0] === "mcp_servers";

/**
 * The same TOML with every statement that defines an MCP server removed: a `[mcp_servers...]`
 * table and everything under it, a root `mcp_servers = {...}` or `mcp_servers.x.y = ...` key,
 * and the same under `[mcp_servers]`. Every other byte is kept as written, so number types,
 * dates and comments survive exactly - nothing is re-serialized.
 *
 * Throws on TOML this scanner cannot follow; the launch then fails rather than guessing. What
 * it produces is checked by Codex itself before any server loads (`codexResidentMcpVerdict`).
 */
export function stripMcpServers(text: string, onKey?: (path: readonly string[]) => void): string {
  let out = "";
  let i = 0;
  let table: string[] = [];
  while (i < text.length) {
    const lineStart = i;
    while (text[i] === " " || text[i] === "\t" || text[i] === "\r") i++;
    const ch = text[i];
    if (ch === "\n" || ch === undefined) {
      out += text.slice(lineStart, i + 1);
      i++;
      continue;
    }
    if (ch === "#") {
      const end = text.indexOf("\n", i);
      const stop = end < 0 ? text.length : end + 1;
      if (!isMcp(table)) out += text.slice(lineStart, stop);
      i = stop;
      continue;
    }
    let end: number;
    let drop: boolean;
    if (ch === "[") {
      const array = text[i + 1] === "[";
      const key = readKey(text, i + (array ? 2 : 1), (c) => c === "]");
      end = key.end + (array ? 2 : 1);
      if (array && text[key.end + 1] !== "]") throw new TomlScanError("unterminated table header");
      table = key.path;
      drop = isMcp(table);
    } else {
      const key = readKey(text, i, (c) => c === "=");
      let at = key.end + 1;
      while (text[at] === " " || text[at] === "\t") at++;
      end = skipValue(text, at);
      const path = [...table, ...key.path];
      onKey?.(path);
      drop = isMcp(path);
    }
    // The rest of the line: whitespace and an optional comment.
    while (text[end] === " " || text[end] === "\t" || text[end] === "\r") end++;
    if (text[end] === "#") while (end < text.length && text[end] !== "\n") end++;
    if (end < text.length && text[end] !== "\n") throw new TomlScanError("unexpected text after a statement");
    const stop = end < text.length ? end + 1 : end;
    if (!drop) out += text.slice(lineStart, stop);
    i = stop;
  }
  return out;
}

// ---- serializing the snapshot's servers ----

/** A TOML basic string. JSON's escapes are TOML's for every string a server definition holds. */
function str(value: string): string {
  return JSON.stringify(value);
}

function num(value: number): string {
  if (!Number.isFinite(value)) throw new Error("a timeout must be finite");
  return String(value);
}

function inlineTable(values: Record<string, string>): string {
  return `{ ${Object.entries(values).map(([key, value]) => `${str(key)} = ${str(value)}`).join(", ")} }`;
}

/**
 * The snapshot's servers as TOML tables, each under a QUOTED key, so `foo.bar` stays one server.
 * Never string interpolation of a name into a dotted path.
 */
export function residentMcpToml(entries: readonly ResidentMcpEntry[], disabled: readonly string[] = []): string {
  const blocks = entries.map((entry) => {
    const lines = [`[mcp_servers.${str(entry.name)}]`];
    if (entry.shape === "http") {
      lines.push(`url = ${str(entry.url)}`);
      if (Object.keys(entry.headers).length > 0) lines.push(`http_headers = ${inlineTable(entry.headers)}`);
    } else {
      lines.push(`command = ${str(entry.command)}`);
      lines.push(`args = [${entry.args.map(str).join(", ")}]`);
      lines.push(`env = ${inlineTable(entry.env)}`);
    }
    const codex = entry.options.codex;
    if (codex?.startupTimeoutSec !== undefined) lines.push(`startup_timeout_sec = ${num(codex.startupTimeoutSec)}`);
    if (codex?.toolTimeoutSec !== undefined) lines.push(`tool_timeout_sec = ${num(codex.toolTimeoutSec)}`);
    if (codex?.enabledTools) lines.push(`enabled_tools = [${codex.enabledTools.map(str).join(", ")}]`);
    if (codex?.disabledTools) lines.push(`disabled_tools = [${codex.disabledTools.map(str).join(", ")}]`);
    return lines.join("\n");
  });
  // A server another configuration layer defines, switched off from this layer. Codex merges
  // layers field by field, so this holds unless that layer sets `enabled` itself, which the
  // verification after it refuses.
  for (const name of disabled) blocks.push(`[mcp_servers.${str(name)}]\nenabled = false`);
  return blocks.length > 0 ? `${blocks.join("\n\n")}\n` : "";
}

// ---- the overlay directory ----

/** Entries of the operator's home the overlay never links: it generates its own. */
const GENERATED = new Set(["config.toml"]);

function writePrivate(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, content, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/**
 * The operator's configuration, stripped of MCP servers, then the run's.
 *
 * Codex keeps its databases in `CODEX_HOME` unless `sqlite_home` says otherwise, and a database
 * it cannot find through a link it creates in the overlay - where it would be lost with the run
 * and split from every other session's state. So the overlay points `sqlite_home` at the
 * operator's home whenever the operator has not chosen one.
 */
export function residentCodexConfig(
  operatorConfig: string | null,
  entries: readonly ResidentMcpEntry[],
  disabled: readonly string[],
  operatorHome: string,
): string {
  let sqliteHome = false;
  const stripped = operatorConfig === null
    ? ""
    : stripMcpServers(operatorConfig, (path) => {
        if (path.length === 1 && path[0] === "sqlite_home") sqliteHome = true;
      });
  const base = sqliteHome ? stripped : `sqlite_home = ${str(operatorHome)}\n${stripped}`;
  const servers = residentMcpToml(entries, disabled);
  if (!servers) return base;
  return `${base}${base && !base.endsWith("\n") ? "\n" : ""}\n# Mission Control resident MCP servers.\n${servers}`;
}

/**
 * Build or refresh the overlay at `overlay` and write its `config.toml`. Called on every start,
 * so a native entry added since the last one is linked and the configuration is regenerated
 * from the operator's file as it is now - never its MCP table, which is the snapshot's alone.
 */
export function prepareResidentCodexHome(input: {
  overlay: string;
  entries: readonly ResidentMcpEntry[];
  disabled?: readonly string[];
  operatorHome?: string;
}): string {
  const operator = input.operatorHome ?? operatorCodexHome();
  mkdirSync(input.overlay, { recursive: true, mode: 0o700 });
  // The rollouts Mission Control reads live in the operator's home; create the directory there
  // first so Codex writes through the link rather than into the overlay.
  mkdirSync(join(operator, "sessions"), { recursive: true });
  const wanted = new Set<string>();
  for (const name of readdirSync(operator)) {
    if (GENERATED.has(name)) continue;
    wanted.add(name);
    const link = join(input.overlay, name);
    const target = join(operator, name);
    let current: string | null = null;
    try {
      current = lstatSync(link).isSymbolicLink() ? readlinkSync(link) : "";
    } catch {
      current = null;
    }
    if (current === target) continue;
    // A real file Codex created in the overlay before the operator's home had it: keep the
    // operator's copy, which is the one every other session reads.
    if (current !== null) rmSync(link, { recursive: true, force: true });
    symlinkSync(target, link);
  }
  for (const name of readdirSync(input.overlay)) {
    if (GENERATED.has(name) || wanted.has(name)) continue;
    const link = join(input.overlay, name);
    if (lstatSync(link).isSymbolicLink()) unlinkSync(link);
  }
  const configPath = join(operator, "config.toml");
  const operatorConfig = existsSync(configPath) ? readFileSync(configPath, "utf8") : null;
  const overlayConfig = join(input.overlay, "config.toml");
  let generated: string;
  try {
    generated = residentCodexConfig(operatorConfig, input.entries, input.disabled ?? [], operator);
  } catch (error) {
    if (!(error instanceof TomlScanError)) throw error;
    throw new Error(`could not read ${configPath} to leave its MCP servers out of the resident's configuration (${error.message})`);
  }
  writePrivate(overlayConfig, generated);
  return overlayConfig;
}

/**
 * Map a rollout path Codex reported through the overlay back to the operator's home, where the
 * linked `sessions` directory really is. The overlay is removed with the run; the rollout is not.
 */
export function operatorRolloutPath(path: string | null | undefined, overlay: string, operatorHome = operatorCodexHome()): string | null | undefined {
  if (!path || !path.startsWith(`${overlay}/`)) return path;
  return join(operatorHome, path.slice(overlay.length + 1));
}

// ---- verifying what Codex will load, before it loads anything ----

export type CodexResidentMcpVerdict =
  | { kind: "exact" }
  /** Servers only another layer defines: switch them off in the overlay and verify again. */
  | { kind: "disable"; names: string[] }
  | { kind: "refuse"; reason: string };

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function layerLabel(name: unknown): string {
  if (!plain(name)) return "a configuration layer";
  const where = typeof name.file === "string" ? name.file : typeof name.dotCodexFolder === "string" ? name.dotCodexFolder : null;
  return where ? `the ${String(name.type)} configuration ${where}` : `the ${String(name.type)} configuration`;
}

/**
 * Decide, from `config/read` with `includeLayers`, whether this start will load exactly the
 * run's servers plus Mission Control's own.
 *
 * - The overlay's user layer must hold exactly the snapshot (and any switched-off names).
 * - A server only another layer defines (a trusted project, the system or managed
 *   configuration) is switched off from the overlay - `disable` - and verified again.
 * - Another layer that adds a field to a snapshot server, or enables a server the overlay
 *   switched off, refuses the start, naming the layer: its definition would no longer be the
 *   snapshot's, and nothing can remove a field another layer sets.
 * - Mission Control's own server rides the session flags, as on every Codex launch.
 */
export function codexResidentMcpVerdict(
  result: unknown,
  input: { overlayConfig: string; names: readonly string[]; disabled: readonly string[]; missionServer: string },
): CodexResidentMcpVerdict {
  if (!plain(result) || !plain(result.config) || !Array.isArray(result.layers)) {
    return { kind: "refuse", reason: "Codex did not report its configuration layers, so the resident's MCP servers cannot be verified" };
  }
  const expected = new Set(input.names);
  const disabled = new Set(input.disabled);
  let user: Record<string, unknown> | null = null;
  const foreign = new Map<string, string>();
  for (const layer of result.layers) {
    if (!plain(layer) || !plain(layer.name)) continue;
    const servers = plain(layer.config) && plain(layer.config.mcp_servers) ? layer.config.mcp_servers : {};
    if (layer.name.type === "user" && layer.name.file === input.overlayConfig) {
      user = servers;
      continue;
    }
    if (layer.name.type === "sessionFlags") {
      const extra = Object.keys(servers).find((name) => name !== input.missionServer);
      if (extra) return { kind: "refuse", reason: `the launch flags define an MCP server ${extra} outside the resident's snapshot` };
      continue;
    }
    for (const name of Object.keys(servers)) {
      if (name === input.missionServer) continue;
      if (expected.has(name)) {
        return { kind: "refuse", reason: `${layerLabel(layer.name)} also defines the resident's MCP server ${name}; remove it there to launch this resident` };
      }
      foreign.set(name, layerLabel(layer.name));
    }
  }
  if (!user) return { kind: "refuse", reason: "Codex did not load the resident's generated configuration" };
  const userNames = Object.keys(user);
  const unexpected = userNames.find((name) => !expected.has(name) && !disabled.has(name));
  if (unexpected) return { kind: "refuse", reason: `the generated configuration still defines ${unexpected}` };
  const missing = input.names.find((name) => !userNames.includes(name));
  if (missing) return { kind: "refuse", reason: `the generated configuration does not define ${missing}` };
  const effective = plain(result.config.mcp_servers) ? result.config.mcp_servers : {};
  const pending: string[] = [];
  for (const [name, layer] of foreign) {
    if (!disabled.has(name)) {
      pending.push(name);
      continue;
    }
    const server = effective[name];
    if (plain(server) && server.enabled !== false) {
      return { kind: "refuse", reason: `${layer} enables the MCP server ${name} itself, so a resident cannot leave it out` };
    }
  }
  if (pending.length > 0) return { kind: "disable", names: pending };
  for (const name of Object.keys(effective)) {
    const server = effective[name];
    if (name === input.missionServer || expected.has(name)) continue;
    if (plain(server) && server.enabled === false) continue;
    return { kind: "refuse", reason: `Codex would also start the MCP server ${name}` };
  }
  return { kind: "exact" };
}
