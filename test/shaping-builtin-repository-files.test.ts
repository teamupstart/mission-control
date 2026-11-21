// The `repository-files` built-in gatherer, against real temporary worktrees: every skip reason,
// the cuts, the facts file, the limits, a signal between files, and the races its checks close,
// driven through the filesystem seam the reader takes as an argument. Then the engine and the
// `builtin` transport around it. Nothing here starts a shaper process.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import {
  appendFileSync, chmodSync, linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import {
  ShaperSchema, ShapingConfigSchema, SHAPING_LIMITS, SHAPING_PROTOCOL, ShapingRequestSchema, ShapingResultSchema, utf8Length,
  type Shaper, type ShapingRequest,
} from "../src/shared/shaping.ts";
import {
  boundedReadBytes, callRepositoryFiles, contentWithinCap, fileText, gatherRepositoryFiles, NODE_REPOSITORY_FILES_FS, quotedPath, readWorktreeFile, REPOSITORY_FILE_MAX_BYTES, skipNotes,
  type RepositoryFilesFs,
} from "../src/server/shaping/builtin/repository-files.ts";
import { shapeTask, type ShapeTaskInput } from "../src/server/shaping/engine.ts";
import { callBuiltin } from "../src/server/shaping/transports/builtin.ts";
import { SHAPING_TRANSPORT_CALLS, type TransportContext } from "../src/server/shaping/transports/index.ts";

const base = realpathSync(mkdtempSync(join(tmpdir(), "mission-shaping-files-")));
after(() => rmSync(base, { recursive: true, force: true }));
let counter = 0;
/** A fresh worktree and a sibling directory outside it, each holding the files named. */
function fixture(files: Record<string, string | Buffer> = {}, outsideFiles: Record<string, string> = {}) {
  const dir = join(base, `case-${++counter}`);
  const root = join(dir, "worktree");
  const outside = join(dir, "outside");
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const write = (at: string, entries: Record<string, string | Buffer>) => {
    for (const [name, body] of Object.entries(entries)) {
      mkdirSync(join(at, name, ".."), { recursive: true });
      writeFileSync(join(at, name), body);
    }
  };
  write(root, files);
  write(outside, outsideFiles);
  return { root, outside };
}
const never = new AbortController().signal;
const options = (patch: { include?: Array<{ path: string; maxBytes?: number }>; summary?: string; facts?: string }) => ({
  include: (patch.include ?? []).map((entry) => ({ maxBytes: SHAPING_LIMITS.entryBytes, ...entry })),
  ...(patch.summary ? { summary: patch.summary } : {}),
  ...(patch.facts ? { facts: patch.facts } : {}),
});
const mkfifo = (at: string) => execFileSync("mkfifo", [at]);

test("every skip reason, each recorded as one note, and none of them a failure", async (t) => {
  const { root, outside } = fixture({ "AGENTS.md": "# Agents\nRead me.\n", "empty.md": "", "blank.md": " \n\t\n", "bom.md": "﻿", "dir/inner.md": "x" },
    { "secret.md": "outside text" });
  symlinkSync(join(outside, "secret.md"), join(root, "leaves.md"));
  mkfifo(join(root, "pipe"));
  writeFileSync(join(root, "huge.md"), "");
  truncateSync(join(root, "huge.md"), REPOSITORY_FILE_MAX_BYTES + 1);
  writeFileSync(join(root, "locked.md"), "no access");
  chmodSync(join(root, "locked.md"), 0o000);
  t.after(() => chmodSync(join(root, "locked.md"), 0o644));
  const asRoot = process.getuid?.() === 0;

  const cases: Array<[string, string]> = [
    ["absent.md", "missing"],
    ["AGENTS.md/below", "missing"],
    ["/etc/hosts", "outside-worktree"],
    ["../outside/secret.md", "outside-worktree"],
    ["dir/../AGENTS.md", "outside-worktree"],
    ["leaves.md", "outside-worktree"],
    ["dir", "not-a-regular-file"],
    ["pipe", "not-a-regular-file"],
    ["huge.md", "too-large"],
    ["empty.md", "empty"],
    ["blank.md", "empty"],
    ["bom.md", "empty"],
    ...(asRoot ? [] : [["locked.md", "unreadable"] as [string, string]]),
  ];
  for (const [configured, skip] of cases) {
    assert.deepEqual(await readWorktreeFile(root, configured, 1024), { ok: false, skip }, configured);
  }

  const result = await gatherRepositoryFiles(root, options({ include: [{ path: "AGENTS.md" }, ...cases.map(([path]) => ({ path }))] }), never);
  assert.ok(result);
  assert.deepEqual(result.guidance.map((entry) => entry.id), ["AGENTS.md"]);
  assert.equal(result.notes?.length, cases.length);
  cases.forEach(([configured, skip], at) => {
    assert.equal(result.notes![at], `Skipped ${JSON.stringify(configured)} (${skip}).`);
  });
  assert.equal(result.degraded, undefined, "a skip never marks the reply degraded");
  assert.ok(ShapingResultSchema.safeParse(result).success);
  assert.doesNotMatch(JSON.stringify(result), /outside text/);
});

test("a link that stays inside the worktree is read as its target, and a file hard-linked in is a worktree file", async () => {
  const { root, outside } = fixture({ "docs/guide.md": "the guide\n" }, { "linked.md": "hard-linked text\n" });
  symlinkSync("docs/guide.md", join(root, "GUIDE.md"));
  linkSync(join(outside, "linked.md"), join(root, "linked.md"));
  assert.deepEqual(await readWorktreeFile(root, "GUIDE.md", 1024), { ok: true, text: "the guide\n", truncated: false });
  assert.deepEqual(await readWorktreeFile(root, "./linked.md", 1024), { ok: true, text: "hard-linked text\n", truncated: false });
});

test("text is cut at the last line boundary within the cap, invalid UTF-8 is replaced and a byte order mark dropped", async () => {
  const lines = "one\ntwo\nthree\nfour\n";
  const { root } = fixture({
    "lines.md": lines,
    "bom.md": Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("after the mark\n")]),
    "bad.md": Buffer.from([0x61, 0xff, 0x62, 0x0a]),
    "long-line.md": "x".repeat(50),
    "multibyte.md": "é".repeat(20),
  });
  assert.deepEqual(await readWorktreeFile(root, "lines.md", 10), { ok: true, text: "one\ntwo", truncated: true }, "the partial third line is dropped");
  assert.deepEqual(await readWorktreeFile(root, "lines.md", 7), { ok: true, text: "one\ntwo", truncated: true }, "the cap lands on a line's end");
  assert.deepEqual(await readWorktreeFile(root, "lines.md", lines.length), { ok: true, text: lines, truncated: false }, "an exact fit is whole");
  assert.deepEqual(await readWorktreeFile(root, "bom.md", 1024), { ok: true, text: "after the mark\n", truncated: false });
  assert.deepEqual(await readWorktreeFile(root, "bad.md", 1024), { ok: true, text: "a�b\n", truncated: false });
  assert.deepEqual(await readWorktreeFile(root, "long-line.md", 16), { ok: true, text: "x".repeat(16), truncated: true }, "one long line still contributes");
  const cut = await readWorktreeFile(root, "multibyte.md", 9);
  assert.deepEqual(cut, { ok: true, text: "é".repeat(4), truncated: true }, "never ends inside a character");

  // Every invalid byte decodes to three bytes of U+FFFD: the cap applies to the text, not the bytes read.
  const decoded = fileText(Buffer.alloc(30, 0xff), 30, false);
  assert.equal(decoded.truncated, true);
  assert.ok(utf8Length(decoded.text) <= 30);
});

test("include entries carry their path as id and title, truncation, and their own cap", async () => {
  const body = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
  const { root } = fixture({ "AGENTS.md": "short\n", "docs/long.md": body });
  const result = await gatherRepositoryFiles(root, options({ include: [{ path: "AGENTS.md" }, { path: "docs/long.md", maxBytes: 20 }] }), never);
  assert.deepEqual(result?.guidance, [
    { id: "AGENTS.md", title: "AGENTS.md", path: "AGENTS.md", body: "short\n" },
    { id: "docs/long.md", title: "docs/long.md", path: "docs/long.md", body: "line 0\nline 1\nline 2", truncated: true },
  ]);
  assert.equal(result?.notes, undefined);
});

test("the summary is cut to 4 KiB at a line boundary and returned as repo.summary", async () => {
  const line = `${"s".repeat(99)}\n`;
  const { root } = fixture({ "SUMMARY.md": line.repeat(60) });
  const result = await gatherRepositoryFiles(root, options({ summary: "SUMMARY.md" }), never);
  const summary = result?.repo?.summary ?? "";
  assert.ok(utf8Length(summary) <= SHAPING_LIMITS.summaryBytes);
  assert.equal(summary, line.repeat(40).slice(0, -1), "the last whole line within 4 KiB");
  assert.deepEqual(result?.guidance, []);
  assert.equal(result?.truncated, true, "a cut summary says the context is incomplete, entries or not");

  const { root: whole } = fixture({ "SUMMARY.md": "short summary\n" });
  assert.equal((await gatherRepositoryFiles(whole, options({ summary: "SUMMARY.md" }), never))?.truncated, undefined);
});

test("a newline at offset zero is a line boundary, so a cut never publishes part of the next line", async () => {
  const { root } = fixture({ "blank-first.md": `\n${"x".repeat(100)}\n`, "two.md": `\n\n${"y".repeat(100)}` });
  assert.deepEqual(await readWorktreeFile(root, "blank-first.md", 20), { ok: true, text: "", truncated: true });
  assert.deepEqual(fileText(Buffer.from(`\n${"z".repeat(50)}`), 20, false), { text: "", truncated: true }, "a complete read cut the same way");
  assert.deepEqual(fileText(Buffer.from("x".repeat(50)), 20, false), { text: "x".repeat(20), truncated: true }, "no boundary: one long line still contributes");
  const result = await gatherRepositoryFiles(root, options({ include: [{ path: "blank-first.md", maxBytes: 20 }, { path: "two.md", maxBytes: 20 }] }), never);
  assert.deepEqual(result?.guidance, [], "a cut to nothing is no entry");
  assert.equal(result?.truncated, true, "but the reply still says content was cut");
  assert.doesNotMatch(JSON.stringify(result), /x{5}|y{5}/);
});

test("a CRLF separator just past the cap keeps the line it ends, and a cut leaves no carriage return", async () => {
  const crlf = "one\r\ntwo\r\nthree";
  const { root } = fixture({ "crlf.md": crlf, "lf.md": "one\ntwo\nthree" });
  // A cap of 8 lands just before the second CRLF, as one of 7 lands just before the second LF.
  assert.deepEqual(await readWorktreeFile(root, "crlf.md", 8), { ok: true, text: "one\r\ntwo", truncated: true });
  assert.deepEqual(await readWorktreeFile(root, "lf.md", 7), { ok: true, text: "one\ntwo", truncated: true });
  // Between the carriage return and the line feed: the first line, without its carriage return.
  assert.deepEqual(await readWorktreeFile(root, "crlf.md", 4), { ok: true, text: "one", truncated: true });
  // Inside the second line: back to the first, again without its carriage return.
  assert.deepEqual(await readWorktreeFile(root, "crlf.md", 7), { ok: true, text: "one", truncated: true });
  // Both separator bytes past the cap: the line keeps a carriage return of its own.
  const { root: own } = fixture({ "cr.md": "first\r\r\nsecond" });
  assert.deepEqual(await readWorktreeFile(own, "cr.md", 6), { ok: true, text: "first\r", truncated: true });
  // A cap one byte later lands between that CRLF's CR and LF: the separator's CR goes, the line's stays.
  assert.deepEqual(await readWorktreeFile(own, "cr.md", 7), { ok: true, text: "first\r", truncated: true });
  // A complete read cut by the cap follows the same rule.
  assert.deepEqual(fileText(Buffer.from(`${crlf}�`), 8, false), { text: "one\r\ntwo", truncated: true });
  assert.equal(boundedReadBytes(8), 8 + 3 + 2, "the read asks for the cap, a byte order mark and the two-byte lookahead");
});

test("a whole file whose replacement characters outgrow the cap is cut, never reported empty", async () => {
  // Four bytes on disk, read whole: "\n" then two invalid bytes, which decode to seven bytes.
  const { root } = fixture({ "invalid.md": Buffer.from([0x0a, 0xff, 0xfe]) });
  assert.deepEqual(await readWorktreeFile(root, "invalid.md", 4), { ok: true, text: "", truncated: true });
  const result = await gatherRepositoryFiles(root, options({ include: [{ path: "invalid.md", maxBytes: 4 }] }), never);
  assert.deepEqual(result?.guidance, []);
  assert.equal(result?.truncated, true);
  assert.deepEqual(result?.notes, ['Skipped "invalid.md" (cut to nothing at its 4-byte cap).']);
});

test("an include path longer than an entry id is skipped unread, and the other entries stay valid", async () => {
  const { root } = fixture({ "AGENTS.md": "agents\n" });
  const long = Array.from({ length: 6 }, () => "d".repeat(100)).join("/");
  const opened: string[] = [];
  const fs: RepositoryFilesFs = { ...NODE_REPOSITORY_FILES_FS, open: async (target, flags) => { opened.push(target); return NODE_REPOSITORY_FILES_FS.open(target, flags); } };
  const result = await gatherRepositoryFiles(root, options({ include: [{ path: long }, { path: "AGENTS.md" }] }), never, fs);
  assert.ok(ShapingResultSchema.safeParse(result).success, "the reply is valid");
  assert.deepEqual(result?.guidance.map((entry) => entry.id), ["AGENTS.md"]);
  assert.equal(result?.notes?.length, 1);
  assert.match(result!.notes![0]!, /\(path longer than 512 characters, the limit on an entry's id\)\.$/);
  assert.deepEqual(opened, [join(root, "AGENTS.md")], "the long path was never opened");
});

test("a valid facts file becomes repo.facts; anything else is a note and no facts", async () => {
  const many = Object.fromEntries(Array.from({ length: SHAPING_LIMITS.facts + 1 }, (_, i) => [`k${i}`, "v"]));
  const { root } = fixture({
    "facts.json": JSON.stringify({ language: "python", framework: ["django", "celery"] }),
    "list.json": "[]",
    "nested.json": JSON.stringify({ language: { name: "python" } }),
    "number.json": JSON.stringify({ port: 8080 }),
    "too-many.json": JSON.stringify(many),
    "broken.json": "{ not json",
    "null.json": "null",
    "big.json": JSON.stringify({ blob: "x".repeat(70 * 1024) }),
  });
  const valid = await gatherRepositoryFiles(root, options({ facts: "facts.json" }), never);
  assert.deepEqual(valid?.repo, { facts: { language: "python", framework: ["django", "celery"] } });
  assert.equal(valid?.notes, undefined);
  for (const name of ["list.json", "nested.json", "number.json", "too-many.json", "broken.json", "null.json", "big.json"]) {
    const result = await gatherRepositoryFiles(root, options({ facts: name }), never);
    assert.equal(result?.repo, undefined, name);
    assert.equal(result?.notes?.length, 1, name);
    const why = name === "big.json"
      ? "larger than 64 KiB once decoded, so no facts"
      : "not a flat JSON object of strings or string lists with at most 64 names, so no facts";
    assert.deepEqual(result?.notes, [`Skipped the facts file "${name}" (${why}).`], name);
  }
  const missing = await gatherRepositoryFiles(root, options({ facts: "absent.json", summary: "absent.md" }), never);
  assert.deepEqual(missing?.notes, ['Skipped the summary "absent.md" (missing).', 'Skipped the facts file "absent.json" (missing).']);
});

test("the limits: at most 16 includes of at most 16 KiB each, and notes stay within the reply's cap", async () => {
  const definition = (include: unknown[]) => ShaperSchema.safeParse({
    id: "files", label: "Files", stage: "gather", transport: { type: "builtin", builtin: "repository-files", options: { include } },
  });
  assert.equal(definition(Array.from({ length: 16 }, (_, i) => ({ path: `f${i}` }))).success, true);
  assert.equal(definition(Array.from({ length: 17 }, (_, i) => ({ path: `f${i}` }))).success, false);
  assert.equal(definition([{ path: "a", maxBytes: SHAPING_LIMITS.entryBytes + 1 }]).success, false);
  assert.ok(16 <= SHAPING_LIMITS.replyEntries, "a full include list can never be refused for its entry count");

  const { root } = fixture({ "big.md": "y\n".repeat(20_000) });
  const big = await readWorktreeFile(root, "big.md", SHAPING_LIMITS.entryBytes);
  assert.ok(big.ok && big.truncated && utf8Length(big.text) <= SHAPING_LIMITS.entryBytes);

  // The most a valid config can skip: 16 includes, the summary and the facts file, with paths as
  // long as a note quotes. Every skip keeps its path and reason, and the reply stays valid.
  // Directories of 100 characters each, so no one name passes the filesystem's limit.
  const long = (tag: string) => `${tag}/${Array.from({ length: 3 }, () => "p".repeat(100)).join("/")}`;
  const paths = [...Array.from({ length: 16 }, (_, i) => long(`absent-${i}`)), long("summary"), long("facts")];
  const all = await gatherRepositoryFiles(root, options({
    include: paths.slice(0, 16).map((path) => ({ path })), summary: paths[16], facts: paths[17],
  }), never);
  assert.ok(all?.notes && all.notes.length <= SHAPING_LIMITS.replyNotes);
  assert.ok(all.notes.every((note) => note.length <= SHAPING_LIMITS.replyNoteChars));
  const said = all.notes.join(" ");
  for (const path of paths) {
    const quoted = quotedPath(path);
    assert.ok(quoted.length <= 200 + 5, "within its bound, with the quotes and the ellipsis");
    assert.ok(quoted.startsWith(JSON.stringify(path.slice(0, 100)).slice(0, -1)) && quoted.endsWith(`${"p".repeat(97)}"`));
    assert.ok(said.includes(`${quoted} (missing).`), path.slice(0, 12));
  }
  assert.equal(said.match(/Skipped /g)?.length, 18, "18 skips, none reduced to a count");
  assert.ok(ShapingResultSchema.safeParse(all).success);
  assert.deepEqual(skipNotes(["a", "b"]), ["a", "b"], "one note per skip while they fit the cap");
  // Short sentences past the cap share notes in order.
  const many = Array.from({ length: 18 }, (_, i) => `Skipped "f${i}" (missing).`);
  assert.deepEqual(skipNotes(many), [many.join(" ")]);
});

test("a byte order mark never counts against a file's cap", async () => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  // A facts object of exactly 64 KiB of JSON, every value within its own limit.
  const facts: Record<string, string> = Object.fromEntries(Array.from({ length: SHAPING_LIMITS.facts }, (_, i) => [`k${String(i).padStart(2, "0")}`, ""]));
  let room = 64 * 1024 - Buffer.byteLength(JSON.stringify(facts));
  for (const name of Object.keys(facts)) {
    const take = Math.min(room, SHAPING_LIMITS.factValueChars);
    facts[name] = "v".repeat(take);
    room -= take;
  }
  const json = JSON.stringify(facts);
  assert.equal(Buffer.byteLength(json), 64 * 1024);
  const { root } = fixture({
    "facts.json": Buffer.concat([bom, Buffer.from(json)]),
    "ten.md": Buffer.concat([bom, Buffer.from("0123456789")]),
    "eleven.md": Buffer.concat([bom, Buffer.from("01234\n56789")]),
  });
  const result = await gatherRepositoryFiles(root, options({ facts: "facts.json" }), never);
  assert.equal(result?.notes, undefined, "64 KiB of JSON behind a mark is whole");
  assert.deepEqual(result?.repo?.facts, facts);
  assert.deepEqual(await readWorktreeFile(root, "ten.md", 10), { ok: true, text: "0123456789", truncated: false });
  assert.deepEqual(await readWorktreeFile(root, "eleven.md", 10), { ok: true, text: "01234", truncated: true }, "one byte over the cap is still cut");
  assert.deepEqual(contentWithinCap(Buffer.concat([bom, Buffer.from("abc")]), 3), { bytes: Buffer.from("abc"), exceeded: false });
});

test("an incomplete UTF-8 sequence at the true end of a file is replaced, and one at a cut is dropped", async () => {
  // é is 0xC3 0xA9: a file ending in a lone 0xC3 is malformed, not cut.
  const object = Buffer.from(JSON.stringify({ language: "python" }));
  const { root } = fixture({ "facts.json": Buffer.concat([object, Buffer.from([0xc3])]), "tail.md": Buffer.from([0x61, 0x0a, 0x62, 0xc3]) });
  assert.deepEqual(await readWorktreeFile(root, "tail.md", 1024), { ok: true, text: "a\nb�", truncated: false });
  const result = await gatherRepositoryFiles(root, options({ facts: "facts.json" }), never);
  assert.equal(result?.repo, undefined, "trailing malformed bytes never let the valid prefix through as facts");
  assert.match(result!.notes![0]!, /^Skipped the facts file "facts\.json" \(not a flat JSON object/);
  // At a cut, the bytes after the cap are still in the file: the partial character is dropped.
  assert.deepEqual(fileText(Buffer.from("aé"), 2, true), { text: "a", truncated: true });
  assert.deepEqual(fileText(Buffer.from([0x61, 0xc3]), 4, false), { text: "a�", truncated: false }, "U+FFFD is three bytes, within a cap of four");
});

test("a file whose capped prefix is white space is cut, not empty: no entry, and a facts file still reports its size", async () => {
  const { root } = fixture({
    "spaced.md": `${" ".repeat(64)}\n${"text".repeat(8)}\n`,
    "SUMMARY.md": `${"\n".repeat(5000)}summary\n`,
    "facts.json": `${" ".repeat(70 * 1024)}{"language":"python"}`,
  });
  const read = await readWorktreeFile(root, "spaced.md", 32);
  assert.ok(read.ok, "not reported empty");
  assert.equal(read.truncated, true);
  const result = await gatherRepositoryFiles(root, options({ include: [{ path: "spaced.md", maxBytes: 32 }], summary: "SUMMARY.md", facts: "facts.json" }), never);
  assert.deepEqual(result?.guidance, [], "a blank cut is no context");
  assert.equal(result?.truncated, true, "a blank cut still marks the reply truncated");
  const summaryOnly = await gatherRepositoryFiles(root, options({ summary: "SUMMARY.md" }), never);
  assert.deepEqual([summaryOnly?.repo, summaryOnly?.truncated], [undefined, true], "a summary cut to nothing marks it too");
  assert.equal(result?.repo, undefined);
  assert.deepEqual(result?.notes, [
    'Skipped "spaced.md" (cut to nothing at its 32-byte cap).',
    `Skipped the summary "SUMMARY.md" (cut to nothing at its ${SHAPING_LIMITS.summaryBytes}-byte cap).`,
    'Skipped the facts file "facts.json" (larger than 64 KiB once decoded, so no facts).',
  ]);
  assert.ok(result!.notes!.every((note) => !note.includes("(empty)")));
});

test("a skipped path of control characters is quoted within its bound, so the reply and its read entries stay valid", async () => {
  // Every \u0001 escapes to six characters: a raw 200-character clip would quote 1,200.
  const control = "\u0001".repeat(100);
  const path = (tag: string) => `${tag}/${control}/${control}/${control}`;
  const { root } = fixture({ "AGENTS.md": "read this\n" });
  const paths = [...Array.from({ length: 15 }, (_, i) => path(`absent-${i}`)), path("summary"), path("facts")];
  const result = await gatherRepositoryFiles(root, options({
    include: [{ path: "AGENTS.md" }, ...paths.slice(0, 15).map((entry) => ({ path: entry }))], summary: paths[15], facts: paths[16],
  }), never);
  assert.ok(ShapingResultSchema.safeParse(result).success, "the reply is valid");
  assert.deepEqual(result?.guidance.map((entry) => entry.id), ["AGENTS.md"], "the file that was read keeps its entry");
  assert.ok(result!.notes!.length <= SHAPING_LIMITS.replyNotes);
  assert.ok(result!.notes!.every((note) => note.length <= SHAPING_LIMITS.replyNoteChars));
  assert.equal(result!.notes!.join(" ").match(/Skipped /g)?.length, 17, "every skip is still named");

  // The escaped form is what is bounded, and the cut never splits an escape or a surrogate pair.
  const quoted = quotedPath(control.repeat(3));
  assert.equal(quoted, `"${"\\u0001".repeat(16)}...${"\\u0001".repeat(17)}"`);
  assert.equal(quotedPath("😀".repeat(150)), `"${"😀".repeat(50)}...${"😀".repeat(50)}"`);
  // Two long paths under one deep directory keep their file names, so their notes differ.
  const deep = Array.from({ length: 4 }, () => "d".repeat(80)).join("/");
  const [first, second] = [quotedPath(`${deep}/first.md`), quotedPath(`${deep}/second.md`)];
  assert.notEqual(first, second);
  assert.ok(first.endsWith('/first.md"') && second.endsWith('/second.md"'));
  assert.equal(quotedPath('a "b" \\ c'), JSON.stringify('a "b" \\ c'), "a short path is quoted whole, as JSON");
  // Both caps are enforced even for sentences no gatherer writes: none longer than a note, never more than the count.
  const huge = Array.from({ length: 40 }, (_, i) => `${i}`.padEnd(1500, "x"));
  const packed = skipNotes(huge);
  assert.equal(packed.length, SHAPING_LIMITS.replyNotes);
  assert.ok(packed.every((note) => note.length <= SHAPING_LIMITS.replyNoteChars));
});

/** The real filesystem, with a hook before or after chosen calls. */
function seam(hooks: {
  afterLstat?: (target: string, call: number) => void;
  beforeOpen?: (target: string) => void;
  afterOpen?: (target: string) => void;
  afterFstat?: () => void;
}): RepositoryFilesFs & { opened: string[] } {
  let lstats = 0;
  const opened: string[] = [];
  return {
    opened,
    realpath: (target) => NODE_REPOSITORY_FILES_FS.realpath(target),
    async lstat(target) {
      const info = await NODE_REPOSITORY_FILES_FS.lstat(target);
      hooks.afterLstat?.(target, ++lstats);
      return info;
    },
    async open(target, flags) {
      hooks.beforeOpen?.(target);
      opened.push(target);
      const handle = await NODE_REPOSITORY_FILES_FS.open(target, flags);
      hooks.afterOpen?.(target);
      return {
        ...handle,
        async stat() {
          const info = await handle.stat();
          hooks.afterFstat?.();
          return info;
        },
      };
    },
  };
}

test("a file swapped for a link out of the worktree after its path was resolved is refused", async () => {
  const { root, outside } = fixture({ "AGENTS.md": "inside\n" }, { "secret.md": "outside text\n" });
  const target = join(root, "AGENTS.md");
  const fs = seam({
    afterLstat(at, call) {
      if (call !== 1 || at !== target) return;
      unlinkSync(target);
      symlinkSync(join(outside, "secret.md"), target);
    },
  });
  const read = await readWorktreeFile(root, "AGENTS.md", 1024, fs);
  assert.equal(read.ok, false);
  assert.equal(fs.opened.length, 1, "the open itself refused the link");
});

test("a directory on the way swapped for a link out of the worktree while the open runs is refused", async () => {
  const { root, outside } = fixture({ "docs/guide.md": "inside\n" }, { "docs/guide.md": "outside text\n" });
  const fs = seam({
    beforeOpen() {
      renameSync(join(root, "docs"), join(root, "docs-moved"));
      symlinkSync(join(outside, "docs"), join(root, "docs"));
    },
  });
  // The open follows the swapped directory and returns the outside file's handle: the identity
  // check is what refuses it, before a byte is read.
  assert.deepEqual(await readWorktreeFile(root, "docs/guide.md", 1024, fs), { ok: false, skip: "outside-worktree" });
  assert.equal(fs.opened.length, 1);
});

test("a file that grows past the limit while it is read is cut off at the limit", async () => {
  const { root } = fixture({ "growing.md": "a\n" });
  const fs = seam({ afterFstat: () => appendFileSync(join(root, "growing.md"), "b\n".repeat(10_000)) });
  const read = await readWorktreeFile(root, "growing.md", 100, fs);
  assert.ok(read.ok);
  assert.equal(read.truncated, true);
  assert.ok(utf8Length(read.text) <= 100);
});

/**
 * Both named-pipe reads, run in a child process. An open that waits for a writer never returns,
 * and nothing in the process that made it can release it, so the reads run where the test can
 * kill them: the child is killed at its timeout, and the test fails instead of hanging. Nothing
 * is decided by timing inside the reads themselves.
 */
const FIFO_CHILD = `
const m = await import(process.env.SHAPING_READER_URL);
const { unlinkSync } = await import("node:fs");
const { execFileSync } = await import("node:child_process");
const { join } = await import("node:path");
const root = process.env.SHAPING_FIFO_ROOT;
const base = m.NODE_REPOSITORY_FILES_FS;
const counting = (opened, hooks = {}) => ({
  ...base,
  async lstat(target) { const info = await base.lstat(target); hooks.afterLstat?.(target); return info; },
  async open(target, flags) { opened.push(target); return base.open(target, flags); },
});
const presentOpened = [];
const present = await m.readWorktreeFile(root, "pipe", 1024, counting(presentOpened));
const target = join(root, "notes.md");
let lstats = 0;
const swappedOpened = [];
const swapped = await m.readWorktreeFile(root, "notes.md", 1024, counting(swappedOpened, {
  afterLstat(at) { if (++lstats === 1 && at === target) { unlinkSync(target); execFileSync("mkfifo", [target]); } },
}));
process.stdout.write(JSON.stringify({ present, presentOpened: presentOpened.length, swapped, swappedOpened: swappedOpened.length }));
`;

test("a named pipe with no writer is skipped at once, there from the start or swapped in after the lookup", async () => {
  const { root } = fixture({ "notes.md": "regular\n" });
  mkfifo(join(root, "pipe"));
  const reader = new URL("../src/server/shaping/builtin/repository-files.ts", import.meta.url).href;
  const run = await new Promise<{ stdout: string; stderr: string; error: (Error & { killed?: boolean }) | null }>((done) => {
    execFile(process.execPath, ["--import", "tsx", "--input-type=module", "-e", FIFO_CHILD], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, SHAPING_READER_URL: reader, SHAPING_FIFO_ROOT: root },
      // Generous for a busy runner starting tsx: the reads themselves take milliseconds.
      timeout: 30_000, killSignal: "SIGKILL",
    }, (error, stdout, stderr) => done({ stdout, stderr, error }));
  });
  assert.equal(run.error?.killed, undefined, "an open waited for a writer, so the child was killed at its timeout");
  assert.equal(run.error, null, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), {
    present: { ok: false, skip: "not-a-regular-file" },
    presentOpened: 0,
    swapped: { ok: false, skip: "not-a-regular-file" },
    swappedOpened: 1,
  }, "a pipe there from the start is never opened; one swapped in is opened without blocking and refused on the handle");
});

test("a signal stops the run between files", async () => {
  const { root } = fixture({ "one.md": "one\n", "two.md": "two\n" });
  const stop = new AbortController();
  const fs = seam({ afterOpen: () => stop.abort() });
  const options_ = options({ include: [{ path: "one.md" }, { path: "two.md" }], summary: "one.md" });
  assert.equal(await gatherRepositoryFiles(root, options_, stop.signal, fs), null);
  assert.deepEqual(fs.opened, [join(root, "one.md")], "the second file was never opened");

  const request = gatherRequest(root);
  const reply = await callRepositoryFiles(request, options_, { signal: AbortSignal.abort() });
  assert.equal(reply.kind, "timed_out");
});

test("a signal that fires during a file's lookup or its identity checks starts no new I/O for it", async () => {
  const { root } = fixture({ "one.md": "one\n" });
  /** The real filesystem, counting opens, reads and closes, with `stop` fired at a chosen point. */
  const counted = (stopAt: "lookup" | "identity") => {
    const stop = new AbortController();
    const seen = { opens: 0, reads: 0, closes: 0 };
    const fs: RepositoryFilesFs = {
      realpath: (target) => NODE_REPOSITORY_FILES_FS.realpath(target),
      async lstat(target) {
        const info = await NODE_REPOSITORY_FILES_FS.lstat(target);
        if (stopAt === "lookup") stop.abort();
        return info;
      },
      async open(target, flags) {
        seen.opens++;
        const handle = await NODE_REPOSITORY_FILES_FS.open(target, flags);
        return {
          read: ((...args: Parameters<typeof handle.read>) => { seen.reads++; return handle.read(...args); }) as typeof handle.read,
          close: () => { seen.closes++; return handle.close(); },
          async stat() {
            const info = await handle.stat();
            if (stopAt === "identity") stop.abort();
            return info;
          },
        };
      },
    };
    return { stop, seen, fs };
  };

  // A lookup that returns after the deadline: the file is never opened.
  const lookup = counted("lookup");
  assert.deepEqual(await readWorktreeFile(root, "one.md", 1024, lookup.fs, lookup.stop.signal), { ok: false, stopped: true });
  assert.deepEqual(lookup.seen, { opens: 0, reads: 0, closes: 0 });

  // The deadline passes while the opened handle is checked: nothing is read, and the handle is closed.
  const identity = counted("identity");
  assert.deepEqual(await readWorktreeFile(root, "one.md", 1024, identity.fs, identity.stop.signal), { ok: false, stopped: true });
  assert.deepEqual(identity.seen, { opens: 1, reads: 0, closes: 1 });

  // Every point: stopped as the Nth filesystem call returns, the reader starts no other call but
  // the handle's close. Unstopped, the calls are realpath, lstat, open, stat, realpath, lstat, read.
  const recording = (stopAfter: number) => {
    const stop = new AbortController();
    const calls: string[] = [];
    const note = (name: string) => { calls.push(name); if (calls.length === stopAfter) stop.abort(); };
    const fs: RepositoryFilesFs = {
      async realpath(target) { const value = await NODE_REPOSITORY_FILES_FS.realpath(target); note("realpath"); return value; },
      async lstat(target) { const info = await NODE_REPOSITORY_FILES_FS.lstat(target); note("lstat"); return info; },
      async open(target, flags) {
        const handle = await NODE_REPOSITORY_FILES_FS.open(target, flags);
        note("open");
        return {
          read: (async (...args: Parameters<typeof handle.read>) => { const result = await handle.read(...args); note("read"); return result; }) as typeof handle.read,
          close: () => { calls.push("close"); return handle.close(); },
          async stat() { const info = await handle.stat(); note("stat"); return info; },
        };
      },
    };
    return { stop, calls, fs };
  };
  const whole = recording(Infinity);
  assert.equal((await readWorktreeFile(root, "one.md", 1024, whole.fs, whole.stop.signal)).ok, true);
  const unstopped = whole.calls.filter((call) => call !== "close");
  assert.deepEqual(unstopped.slice(0, 6), ["realpath", "lstat", "open", "stat", "realpath", "lstat"]);
  for (let at = 1; at < unstopped.length; at++) {
    const run = recording(at);
    assert.deepEqual(await readWorktreeFile(root, "one.md", 1024, run.fs, run.stop.signal), { ok: false, stopped: true }, `stopped after call ${at}`);
    const opened = run.calls.slice(0, at).includes("open");
    assert.deepEqual(run.calls, [...unstopped.slice(0, at), ...(opened ? ["close"] : [])], `nothing starts after call ${at} (${unstopped[at - 1]})`);
  }
  // The worktree's own lookups: a stop as its realpath returns starts no lstat.
  const rootRun = recording(1);
  assert.equal((await callRepositoryFiles(gatherRequest(root), options({ include: [{ path: "one.md" }] }), { signal: rootRun.stop.signal }, rootRun.fs)).kind, "timed_out");
  assert.deepEqual(rootRun.calls, ["realpath"]);

  // The gatherer stops there too, with no skip recorded for the file it did not read.
  const gathered = counted("identity");
  assert.equal(await gatherRepositoryFiles(root, options({ include: [{ path: "one.md" }] }), gathered.stop.signal, gathered.fs), null);
  assert.deepEqual(gathered.seen, { opens: 1, reads: 0, closes: 1 });
});

const filesShaper = (opts: Record<string, unknown>, extra: Record<string, unknown> = {}) => ShaperSchema.parse({
  id: "files", label: "Repository files", stage: "gather", transport: { type: "builtin", builtin: "repository-files", options: opts }, ...extra,
});
function gatherRequest(path: string | undefined, stage: "gather" | "select" = "gather"): ShapingRequest {
  return ShapingRequestSchema.parse({
    protocol: SHAPING_PROTOCOL, stage, task: "t", repo: { name: "billing-api", ...(path ? { path } : {}) },
    context: {
      taskId: null, title: "t", kind: "ship", harness: null, runtime: null, afterWork: null, labels: [], priority: null,
      repositories: [{ slot: "repo-01", name: "billing-api", role: "primary", branch: null, baseSha: null }],
      target: "repo-01", caller: { user: null, agent: null, conversation: null },
    },
    limits: { maxBytes: 16384, deadlineMs: 5000 },
  });
}
const ctx = (): TransportContext => ({
  deadline: Date.now() + 5000, timeoutMs: 5000, signal: new AbortController().signal,
  scope: { shared: new Map(), defer() {} }, root: null, trace: null,
});

test("the builtin transport dispatches by id, and answers unavailable off its stage or without a worktree", async () => {
  const { root } = fixture({ "AGENTS.md": "agents\n" });
  const shaper = filesShaper({ include: [{ path: "AGENTS.md" }] });
  const reply = await callBuiltin(gatherRequest(root), shaper as Parameters<typeof callBuiltin>[1], ctx());
  assert.equal(reply.kind, "data");
  assert.deepEqual((reply as { data: { guidance: unknown[] } }).data.guidance.length, 1);

  // The schema refuses a built-in off its stage; the transport refuses one that got past it anyway.
  const offStage = { ...shaper, stage: "select" } as Parameters<typeof callBuiltin>[1];
  assert.deepEqual(await callBuiltin(gatherRequest(root, "select"), offStage, ctx()), {
    kind: "unavailable", reason: 'The built-in "repository-files" does not run at the select stage.',
  });
  assert.equal((await callBuiltin(gatherRequest(undefined), shaper as Parameters<typeof callBuiltin>[1], ctx())).kind, "unavailable");
  assert.equal((await callBuiltin(gatherRequest(join(root, "AGENTS.md")), shaper as Parameters<typeof callBuiltin>[1], ctx())).kind, "unavailable",
    "a worktree that is a file is no worktree");
});

test("the engine hands the gatherer's facts and summary to a selector, and two worktrees at one path give two entries", async () => {
  const one = fixture({ "AGENTS.md": "rules of the first worktree\n", "SUMMARY.md": "first summary\n", "facts.json": '{"language":"python"}' });
  const two = fixture({ "AGENTS.md": "rules of the second worktree\n", "SUMMARY.md": "second summary\n", "facts.json": '{"language":"go"}' });
  const selector = ShaperSchema.parse({ id: "sel", label: "Selector", stage: "select", transport: { type: "command", command: "/usr/bin/true" } });
  const files = filesShaper({ include: [{ path: "AGENTS.md" }, { path: "MISSING.md" }], summary: "SUMMARY.md", facts: "facts.json" });
  const config = ShapingConfigSchema.parse({ shapers: [files, selector], overrides: { files: true, sel: true } });
  const seen: ShapingRequest[] = [];
  const input: ShapeTaskInput = {
    task: "Retry failed charges",
    context: {
      taskId: "t_1", title: "Retry", kind: "ship", harness: "claude", runtime: "sdk", afterWork: null, labels: [], priority: null,
      repositories: [
        { name: "billing-api", role: "primary", branch: "a", baseSha: null, path: one.root },
        { name: "billing-api", role: "additional", branch: "b", baseSha: null, path: two.root },
      ],
    },
  };
  const result = await shapeTask(input, {
    config, discovered: [], enabled: true,
    transports: {
      ...SHAPING_TRANSPORT_CALLS,
      command: async (request) => { seen.push(request); return { kind: "data", data: { guidance: [] } }; },
    },
  });
  assert.deepEqual(seen.map((request) => [request.context.target, request.repo.facts, request.repo.summary]), [
    ["repo-01", { language: "python" }, "first summary\n"],
    ["repo-02", { language: "go" }, "second summary\n"],
  ]);
  assert.deepEqual(result.entries.map((entry) => [entry.shaperId, entry.id, entry.body]), [
    ["files", "AGENTS.md", "rules of the first worktree\n"],
    ["files", "AGENTS.md", "rules of the second worktree\n"],
  ]);
  const record = result.summary!.shapers.find((entry) => entry.id === "files")!;
  assert.equal(record.outcome, "ok", "a skipped file is not a failure");
  assert.equal(result.summary!.state, "ok");
  assert.match(record.reason ?? "", /Skipped "MISSING\.md" \(missing\)\./, "the skip is recorded");
});

test("a registered built-in gatherer never reads a file its options do not name", async () => {
  const { root } = fixture({ "AGENTS.md": "named\n", "secret.env": "TOKEN=unnamed\n" });
  const opened: string[] = [];
  const fs: RepositoryFilesFs = { ...NODE_REPOSITORY_FILES_FS, open: async (target, flags) => { opened.push(target); return NODE_REPOSITORY_FILES_FS.open(target, flags); } };
  const shaper: Shaper = filesShaper({ include: [{ path: "AGENTS.md" }] });
  const transport = shaper.transport as Extract<Shaper["transport"], { type: "builtin" }>;
  await callRepositoryFiles(gatherRequest(root), transport.options, ctx(), fs);
  assert.deepEqual(opened, [join(root, "AGENTS.md")]);
});
