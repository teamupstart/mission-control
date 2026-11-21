// The shapers folder, read from a temporary state home: every rule a folder must satisfy before
// its shaper can run, the bound, and the re-read that notices a replaced manifest whatever its
// size or timestamps.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "mission-shaping-discovery-"));
process.env.MISSION_HOME = home;
const { scanShaperFolder, shapersFolder, SHAPER_FOLDER_ENTRIES } = await import("../src/server/shaping/discovery.ts");
const { SHAPING_CONFIG_DEFAULTS } = await import("../src/shared/shaping.ts");

const root = shapersFolder(home);
const none = { shapers: [] as Array<{ id: string }> };

after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => rmSync(root, { recursive: true, force: true }));

function manifest(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, label: `Shaper ${id}`, stage: "gather", transport: { type: "command", command: "/bin/echo" }, ...extra };
}

/** A shaper folder, owner-only writable as the check requires, holding `files`. */
function folder(name: string, files: Record<string, string | Buffer> = {}, base: string = root): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  chmodSync(dir, 0o755);
  for (const [file, content] of Object.entries(files)) {
    const path = join(dir, file);
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o755 });
    writeFileSync(path, content, { mode: 0o644 });
    chmodSync(path, 0o644);
  }
  return dir;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

async function scan() {
  return await scanShaperFolder({ home, config: none });
}

async function only() {
  const { shapers } = await scan();
  assert.equal(shapers.length, 1);
  return shapers[0]!;
}

test("a missing folder is an empty result, and the scan never creates it", async () => {
  const result = await scan();
  assert.deepEqual(result, { shapers: [], folder: { path: root, ignored: 0 } });
  assert.equal(existsSync(root), false);
});

test("a valid folder is ok, with its real path, the manifest's hash and the parsed shaper", async () => {
  const text = json(manifest("acme-notes", { enabled: false }));
  const dir = folder("acme-notes", { "shaper.json": text });
  const entry = await only();
  assert.equal(entry.state, "ok");
  assert.equal(entry.problem, null);
  assert.equal(entry.path, realpathSync(dir));
  assert.equal(entry.sha256, createHash("sha256").update(text).digest("hex"));
  assert.equal(entry.shaper?.id, "acme-notes");
  assert.equal(entry.shaper?.enabled, false);
});

test("stray files and hidden entries are not shapers", async () => {
  folder("acme-notes", { "shaper.json": json(manifest("acme-notes")) });
  writeFileSync(join(root, ".DS_Store"), "");
  writeFileSync(join(root, "README"), "");
  mkdirSync(join(root, ".hidden"));
  assert.deepEqual((await scan()).shapers.map((entry) => entry.id), ["acme-notes"]);
});

test("a manifest that is not JSON is invalid, and the problem never quotes its text", async () => {
  folder("acme-notes", { "shaper.json": "{ \"id\": \"acme-notes\", \"token\": \"sk-live-123456\" " });
  const entry = await only();
  assert.equal(entry.state, "invalid");
  assert.equal(entry.problem, "Its shaper.json is not valid JSON.");
  assert.equal(entry.shaper, null);
  assert.ok(entry.sha256, "an invalid manifest is still hashed");
});

test("a manifest that fails the schema is invalid with the problem as a sentence", async () => {
  folder("acme-notes", { "shaper.json": json(manifest("acme-notes", { stage: "summon" })) });
  const entry = await only();
  assert.equal(entry.state, "invalid");
  assert.match(entry.problem ?? "", /^stage: /);
});

test("a stage or transport this build does not know is invalid, never preserved", async () => {
  folder("acme-notes", { "shaper.json": json(manifest("acme-notes", { transport: { type: "carrier-pigeon" } })) });
  const entry = await only();
  assert.equal(entry.state, "invalid");
  assert.match(entry.problem ?? "", /^transport/);
});

test("an id that differs from the folder name is invalid", async () => {
  folder("acme-notes", { "shaper.json": json(manifest("other-notes")) });
  const entry = await only();
  assert.equal(entry.state, "invalid");
  assert.match(entry.problem ?? "", /Its id "other-notes" is not its folder's name/);
});

test("a manifest of exactly 16 KiB is read, and one byte more is invalid", async () => {
  const cap = 16 * 1024;
  // A valid manifest whose text, padded with whitespace JSON ignores, is exactly `bytes` long.
  const sized = (id: string, bytes: number): string => {
    const text = json(manifest(id, { transport: { type: "command", command: "/bin/echo", args: ["x".repeat(4000), "y".repeat(4000), "z".repeat(4000)] } }));
    assert.ok(Buffer.byteLength(text) < bytes);
    return text + " ".repeat(bytes - Buffer.byteLength(text));
  };
  folder("at-limit", { "shaper.json": sized("at-limit", cap) });
  folder("over-limit", { "shaper.json": sized("over-limit", cap + 1) });
  assert.equal(statSync(join(root, "at-limit", "shaper.json")).size, cap);
  assert.equal(statSync(join(root, "over-limit", "shaper.json")).size, cap + 1);
  const byId = new Map((await scan()).shapers.map((entry) => [entry.id, entry]));
  assert.equal(byId.get("at-limit")?.state, "ok");
  assert.equal(byId.get("at-limit")?.problem, null);
  assert.equal(byId.get("over-limit")?.state, "invalid");
  assert.equal(byId.get("over-limit")?.problem, `Its shaper.json is ${cap + 1} bytes, over the 16 KiB limit.`);
  assert.equal(byId.get("over-limit")?.shaper, null);
});

test("a manifest that is not UTF-8 is invalid, with no parsed shaper", async () => {
  // A lone 0xff byte inside an otherwise valid JSON string is never UTF-8.
  const bytes = Buffer.concat([Buffer.from("{\"id\": \"acme-notes\", \"label\": \""), Buffer.from([0xff, 0xfe]), Buffer.from("\"}")]);
  folder("acme-notes", { "shaper.json": bytes });
  const entry = await only();
  assert.equal(entry.state, "invalid");
  assert.equal(entry.problem, "Its shaper.json is not UTF-8 text.");
  assert.equal(entry.shaper, null);
  assert.equal(entry.sha256, createHash("sha256").update(bytes).digest("hex"));
});

test("a manifest that is not a regular file is invalid: a directory, a link, a missing file", async () => {
  folder("as-dir");
  mkdirSync(join(root, "as-dir", "shaper.json"));
  const elsewhere = folder("source", { "real.json": json(manifest("as-link")) }, home);
  folder("as-link");
  symlinkSync(join(elsewhere, "real.json"), join(root, "as-link", "shaper.json"));
  folder("missing");
  const byId = new Map((await scan()).shapers.map((entry) => [entry.id, entry]));
  assert.equal(byId.get("as-dir")?.state, "invalid");
  assert.equal(byId.get("as-dir")?.problem, "Its shaper.json is not a regular file.");
  assert.equal(byId.get("as-link")?.state, "invalid");
  assert.equal(byId.get("as-link")?.problem, "Its shaper.json is a symbolic link, not a regular file.");
  assert.equal(byId.get("missing")?.problem, "The folder has no shaper.json.");
});

test("a folder may be a link to a directory, and is reported at its real path", async () => {
  const target = folder("linked-notes", { "shaper.json": json(manifest("linked-notes")) }, join(home, "elsewhere"));
  mkdirSync(root, { recursive: true });
  symlinkSync(target, join(root, "linked-notes"));
  const entry = await only();
  assert.equal(entry.state, "ok");
  assert.equal(entry.path, realpathSync(target));
});

test("a link that leads nowhere, or to a file, is invalid", async () => {
  mkdirSync(root, { recursive: true });
  symlinkSync(join(home, "nowhere"), join(root, "dangling"));
  writeFileSync(join(home, "a-file"), "");
  symlinkSync(join(home, "a-file"), join(root, "to-file"));
  const byId = new Map((await scan()).shapers.map((entry) => [entry.id, entry]));
  assert.equal(byId.get("dangling")?.state, "invalid");
  assert.equal(byId.get("to-file")?.problem, "This entry is not a folder.");
});

test("a group- or other-writable folder or manifest is refused, with the reason", async () => {
  const dir = folder("group-dir", { "shaper.json": json(manifest("group-dir")) });
  chmodSync(dir, 0o775);
  const other = folder("other-file", { "shaper.json": json(manifest("other-file")) });
  chmodSync(join(other, "shaper.json"), 0o646);
  const byId = new Map((await scan()).shapers.map((entry) => [entry.id, entry]));
  assert.equal(byId.get("group-dir")?.state, "refused");
  assert.match(byId.get("group-dir")?.problem ?? "", /The folder is writable by its group or by other users/);
  assert.equal(byId.get("other-file")?.state, "refused");
  assert.match(byId.get("other-file")?.problem ?? "", /Its shaper\.json is writable by its group or by other users/);
});

test("a folder that belongs to another user is refused", async () => {
  folder("acme-notes", { "shaper.json": json(manifest("acme-notes")) });
  const owner = statSync(root).uid;
  const { shapers } = await scanShaperFolder({ home, config: none, uid: owner + 1 });
  assert.equal(shapers[0]?.state, "refused");
  assert.match(shapers[0]?.problem ?? "", /belongs to another user/);
});

test("a link in shapers/ that another user made is refused before its target is checked", async () => {
  const target = folder("linked-notes", { "shaper.json": json(manifest("linked-notes")) }, join(home, "elsewhere"));
  mkdirSync(root, { recursive: true });
  symlinkSync(target, join(root, "linked-notes"));
  // The daemon modelled as another user: the link, made by this one, is not its own.
  const owner = statSync(root).uid;
  const { shapers } = await scanShaperFolder({ home, config: none, uid: owner + 1 });
  assert.equal(shapers.length, 1);
  assert.equal(shapers[0]?.state, "refused");
  assert.equal(shapers[0]?.problem, "The link to this folder belongs to another user. It must belong to the user Mission Control runs as.");
  // Refused at the link: its target was never resolved, so the path is the link's own.
  assert.equal(shapers[0]?.path, join(root, "linked-notes"));
  assert.equal(shapers[0]?.sha256, null);
});

test("a ./ command resolves inside the folder; one that is group-writable, or under such a directory, is refused", async () => {
  folder("runs-ok", { "shaper.json": json(manifest("runs-ok", { transport: { type: "command", command: "./bin/run" } })), "bin/run": "#!/bin/sh\n" });
  const loose = folder("loose-program", { "shaper.json": json(manifest("loose-program", { transport: { type: "command", command: "./run" } })), run: "#!/bin/sh\n" });
  chmodSync(join(loose, "run"), 0o664);
  const looseDir = folder("loose-dir", { "shaper.json": json(manifest("loose-dir", { transport: { type: "command", command: "./bin/run" } })), "bin/run": "#!/bin/sh\n" });
  chmodSync(join(looseDir, "bin"), 0o775);
  // A local MCP server's program is held to the same rule.
  const mcp = folder("loose-mcp", {
    "shaper.json": json(manifest("loose-mcp", { stage: "select", transport: { type: "mcp", server: { type: "stdio", command: "./server" }, tool: "guidance" } })),
    server: "#!/bin/sh\n",
  });
  chmodSync(join(mcp, "server"), 0o666);
  const byId = new Map((await scan()).shapers.map((entry) => [entry.id, entry]));
  assert.equal(byId.get("runs-ok")?.state, "ok");
  assert.equal(byId.get("loose-program")?.state, "refused");
  assert.match(byId.get("loose-program")?.problem ?? "", /The program "\.\/run" is writable by its group/);
  assert.equal(byId.get("loose-dir")?.state, "refused");
  assert.match(byId.get("loose-dir")?.problem ?? "", /The folder "bin" that holds "\.\/bin\/run" is writable by its group/);
  assert.equal(byId.get("loose-mcp")?.state, "refused");
  // A refused program still shows what the manifest would run.
  assert.equal(byId.get("loose-program")?.shaper?.id, "loose-program");
});

test("the ownership of a ./ program is checked at every scan, though the manifest is unchanged", async () => {
  const dir = folder("runs-ok", { "shaper.json": json(manifest("runs-ok", { transport: { type: "command", command: "./run" } })), run: "#!/bin/sh\n" });
  assert.equal((await only()).state, "ok");
  chmodSync(join(dir, "run"), 0o666);
  assert.equal((await only()).state, "refused");
});

test("a ./ command that escapes the folder through a link, or names nothing, is invalid", async () => {
  writeFileSync(join(home, "outside"), "#!/bin/sh\n", { mode: 0o755 });
  const dir = folder("escapes", { "shaper.json": json(manifest("escapes", { transport: { type: "command", command: "./run" } })) });
  symlinkSync(join(home, "outside"), join(dir, "run"));
  folder("absent", { "shaper.json": json(manifest("absent", { transport: { type: "command", command: "./run" } })) });
  const byId = new Map((await scan()).shapers.map((entry) => [entry.id, entry]));
  assert.equal(byId.get("escapes")?.state, "invalid");
  assert.equal(byId.get("escapes")?.problem, "\"./run\" resolves outside the shaper's folder.");
  assert.equal(byId.get("absent")?.problem, "\"./run\" was not found in the shaper's folder.");
});

test("a literal credential in a header is invalid, naming the header and never its value", async () => {
  const secret = "sk-live-0123456789abcdef";
  folder("acme-guidance", {
    "shaper.json": json(manifest("acme-guidance", {
      stage: "select", transport: { type: "http", url: "https://context.acme.example/shape", headers: { authorization: `Bearer ${secret}` } },
    })),
  });
  const entry = await only();
  assert.equal(entry.state, "invalid");
  assert.match(entry.problem ?? "", /"authorization" header carries a credential/);
  assert.equal(JSON.stringify(entry).includes(secret), false);
});

test("a registered shaper with the same id shadows the folder's", async () => {
  folder("acme-notes", { "shaper.json": json(manifest("acme-notes")) });
  const config = { ...SHAPING_CONFIG_DEFAULTS, shapers: [{ id: "acme-notes", label: "Registered notes", stage: "gather", transport: { type: "command" } }] };
  const { shapers } = await scanShaperFolder({ home, config });
  assert.equal(shapers[0]?.state, "shadowed");
  assert.match(shapers[0]?.problem ?? "", /A registered shaper has the id "acme-notes"/);
});

test(`at most ${SHAPER_FOLDER_ENTRIES} folders are read, in name order, and the rest are reported`, async () => {
  const names = Array.from({ length: SHAPER_FOLDER_ENTRIES + 1 }, (_, at) => `shaper-${String(at).padStart(2, "0")}`);
  for (const name of [...names].reverse()) folder(name, { "shaper.json": json(manifest(name)) });
  const { shapers, folder: status } = await scan();
  assert.equal(shapers.length, SHAPER_FOLDER_ENTRIES);
  assert.deepEqual(shapers.map((entry) => entry.id), names.slice(0, SHAPER_FOLDER_ENTRIES));
  assert.equal(status.ignored, 1);
});

test("every scan re-reads the manifest: a change is noticed, and so is a same-size replacement that keeps its timestamps", async () => {
  const dir = folder("acme-notes", { "shaper.json": json(manifest("acme-notes", { label: "First label" })) });
  const path = join(dir, "shaper.json");
  const first = await only();
  assert.equal(first.shaper?.label, "First label");

  writeFileSync(path, json(manifest("acme-notes", { label: "A longer second label" })));
  const second = await only();
  assert.equal(second.shaper?.label, "A longer second label");
  assert.notEqual(second.sha256, first.sha256);

  // Whole seconds, which every file system keeps exactly.
  utimesSync(path, 1_700_000_000, 1_700_000_000);
  const before = statSync(path);
  writeFileSync(path, json(manifest("acme-notes", { label: "A longer second LABEL" })));
  utimesSync(path, 1_700_000_000, 1_700_000_000);
  assert.equal(statSync(path).size, before.size);
  assert.equal(statSync(path).mtimeMs, before.mtimeMs);
  const third = await only();
  assert.equal(third.shaper?.label, "A longer second LABEL");
  assert.notEqual(third.sha256, second.sha256);
});

test("an unchanged manifest whose id now differs from a renamed folder is caught, though its parse is reused", async () => {
  const text = json(manifest("acme-notes"));
  folder("acme-notes", { "shaper.json": text });
  assert.equal((await only()).state, "ok");
  rmSync(join(root, "acme-notes"), { recursive: true });
  folder("renamed", { "shaper.json": text });
  const entry = await only();
  assert.equal(entry.id, "renamed");
  assert.equal(entry.state, "invalid");
});
