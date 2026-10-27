import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat, readlink } from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { crc32, deflateRawSync } from "node:zlib";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { latestStableBinary, binaryForCommit } from "../src/main/update-binary-release.ts";
import { downloadBinaryAsset } from "../src/main/update-binary-download.ts";
import { extractBinaryArchive } from "../src/main/update-binary-archive.ts";
import { stageBinaryUpdate, discardBinaryUpdate, retainBinaryHandoff } from "../src/main/update-binary.ts";
import { binaryOffer, binaryStaged } from "./helpers/binary-update.ts";
import type { GhRunner } from "../src/main/updater.ts";

const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const release = (tag: string, id: number) => ({id, tag_name: tag, name: tag, body: "Changes", published_at: "2026-10-25T00:00:00Z", draft: false, prerelease: tag.startsWith("alpha-")});
function fakeGithub({alpha = false, incomplete = false, wrongCommit = false, badManifest = false, version = "1.2.4"} = {}) {
  const offer = binaryOffer("b".repeat(40), alpha ? "alpha" : "stable", version);
  const text = JSON.stringify(badManifest ? {...offer.manifest, arch: "x64"} : offer.manifest);
  const tag = alpha ? `alpha-${offer.manifest.commit}` : `v${version}`;
  const calls: string[][] = [];
  const run: GhRunner = async args => {
    calls.push(args);
    assert.deepEqual(args.slice(0, 3), ["api", "--hostname", "github.com"]);
    assert.ok(args[3]!.startsWith("repos/teamupstart/mission-control/"));
    const path = args[3]!.slice("repos/teamupstart/mission-control/".length);
    let value: unknown;
    if (path === "releases?per_page=30&page=1") value = [release("v1.2.5", 5), release(tag, 4)];
    else if (path === `releases/tags/${tag}`) value = release(tag, 4);
    else if (path === "releases/5/assets?per_page=30&page=1") value = [];
    else if (path === "releases/4/assets?per_page=30&page=1") value = [
      {id: 1, name: "mission-control-manifest.json", state: "uploaded", size: Buffer.byteLength(text)},
      ...offer.manifest.assets.filter(a => !incomplete || a.kind === "app-zip").map(a => ({id: Number(a.id), name: a.name, size: a.bytes, state: "uploaded"})),
    ];
    else if (path === "releases/assets/1") return {code: 0, stdout: text, stderr: ""};
    else if (path === `commits/${tag}`) value = {sha: wrongCommit ? "c".repeat(40) : offer.manifest.commit};
    else return {code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)"};
    return {code: 0, stdout: JSON.stringify(value), stderr: ""};
  };
  return {run, offer, text, calls};
}

test("stable skips a newer incomplete release and pins the complete manifest digest and asset identity", async () => {
  const f = fakeGithub();
  const release = await latestStableBinary(f.run, "1.2.3");
  assert.equal(release?.tagName, "v1.2.4");
  assert.equal(release?.binary?.manifestSha256, digest(f.text));
  assert.deepEqual(release?.binary?.manifest, f.offer.manifest);
});

for (const installed of ["1.2.3", "1.2.4"]) {
  test(`stable keeps pending 1.2.5 when the complete 1.2.3 is not newer than installed ${installed}`, async () => {
    const f = fakeGithub({version: "1.2.3"});
    const selected = await latestStableBinary(f.run, installed);
    assert.equal(selected?.tagName, "v1.2.5");
    assert.match(selected?.unavailable ?? "", /pending or unavailable/);
    assert.equal(selected?.binary, undefined);
  });
}

test("stable still offers complete 1.2.3 above installed 1.2.2 while 1.2.5 is pending", async () => {
  const f = fakeGithub({version: "1.2.3"});
  const selected = await latestStableBinary(f.run, "1.2.2");
  assert.equal(selected?.tagName, "v1.2.3");
  assert.deepEqual(selected?.binary?.manifest, f.offer.manifest);
});

test("stable selects the newest of multiple complete releases regardless of inventory order", async t => {
  const candidates = ["1.2.9", "1.2.10"].map((version, index) => {
    const id = index + 4;
    const manifest = binaryOffer(String(id).repeat(40), "stable", version).manifest;
    manifest.assets = manifest.assets.map((asset, offset) => ({...asset, id: String(id * 10 + offset + 1)}));
    const text = JSON.stringify(manifest);
    return {id, tag: `v${version}`, manifest, text};
  });
  const newest = candidates[1]!;
  for (const order of [candidates, [...candidates].reverse()]) {
    await t.test(`inventory starts with ${order[0]!.tag}`, async () => {
      const responses = new Map<string, unknown>([
        ["releases?per_page=30&page=1", order.map(candidate => release(candidate.tag, candidate.id))],
      ]);
      for (const candidate of candidates) {
        responses.set(`releases/${candidate.id}/assets?per_page=30&page=1`, [
          {id: candidate.id * 10, name: "mission-control-manifest.json", state: "uploaded", size: Buffer.byteLength(candidate.text)},
          ...candidate.manifest.assets.map(asset => ({id: Number(asset.id), name: asset.name, size: asset.bytes, state: "uploaded"})),
        ]);
        responses.set(`releases/assets/${candidate.id * 10}`, candidate.manifest);
        responses.set(`commits/${candidate.tag}`, {sha: candidate.manifest.commit});
      }
      const selected = await latestStableBinary(async args => {
        assert.deepEqual(args.slice(0, 3), ["api", "--hostname", "github.com"]);
        const prefix = "repos/teamupstart/mission-control/";
        assert.ok(args[3]!.startsWith(prefix));
        const path = args[3]!.slice(prefix.length);
        assert.ok(responses.has(path), `Unexpected GitHub request: ${path}`);
        return {code: 0, stdout: JSON.stringify(responses.get(path)), stderr: ""};
      }, "1.2.3");
      assert.equal(selected?.tagName, newest.tag);
      assert.deepEqual(selected?.binary, {
        manifest: newest.manifest, manifestText: newest.text, manifestSha256: digest(newest.text),
      });
      assert.ok(selected?.binary);
      assert.deepEqual(selected.binary.manifest.assets.map(asset => asset.id), ["51", "52"]);
    });
  }
});

test("alpha resolves only the exact observed main SHA; pending and retired identities do not fall back", async () => {
  const f = fakeGithub({alpha: true});
  assert.equal((await binaryForCommit(f.run, "b".repeat(40)))?.manifest.commit, "b".repeat(40));
  assert.equal(await binaryForCommit(f.run, "c".repeat(40)), null);
  const incomplete = fakeGithub({alpha: true, incomplete: true});
  assert.equal(await binaryForCommit(incomplete.run, "b".repeat(40)), null);
  assert.ok(f.calls.every(args => !args[3]!.startsWith("repos/teamupstart/mission-control/releases?")));
});

test("stable scans past 300 ineligible releases and orders eligible releases across pages", async () => {
  const f = fakeGithub();
  const calls: number[] = [];
  const selected = await latestStableBinary(async args => {
    const page = args[3]!.match(/\/releases\?per_page=30&page=(\d+)$/);
    if (!page) return f.run(args);
    const number = Number(page[1]); calls.push(number);
    const batch = number <= 10 ? Array.from({length: 30}, (_, index) => {
      const entry = release("v9.9.9", number * 30 + index);
      if (index % 3 === 0) entry.draft = true;
      else if (index % 3 === 1) entry.prerelease = true;
      else entry.tag_name = "not-a-version";
      return entry;
    }) : number === 11 ? [release("v1.2.3", 3), ...Array.from({length: 29}, () => release("alpha-old", 2))]
      : [release("v1.2.4", 4)];
    return {code: 0, stdout: JSON.stringify(batch), stderr: ""};
  }, "1.2.3");
  assert.deepEqual(calls, Array.from({length: 12}, (_, index) => index + 1));
  assert.equal(selected?.tagName, "v1.2.4");
  assert.deepEqual(selected?.binary?.manifest, f.offer.manifest);
  assert.equal(selected?.binary?.manifestSha256, digest(f.text));
});

test("incomplete stable sets remain visibly unavailable and substituted tag/protocol/platform fail closed", async () => {
  const unavailable = await latestStableBinary(fakeGithub({incomplete: true}).run, "1.2.3");
  assert.match(unavailable?.unavailable ?? "", /pending or unavailable/);
  assert.equal(unavailable?.binary, undefined);
  await assert.rejects(latestStableBinary(fakeGithub({wrongCommit: true}).run, "1.2.3"), /tag no longer matches/);
  await assert.rejects(latestStableBinary(fakeGithub({badManifest: true}).run, "1.2.3"), /incompatible protocol, platform/);
});

test("discovery bounds pagination and preserves authentication and rate-limit errors without leaking stderr", async () => {
  let calls = 0;
  await assert.rejects(latestStableBinary(async () => {calls++; return {code: 0, stdout: JSON.stringify(Array.from({length: 30}, () => release("v1.2.4", 4))), stderr: ""};}, "1.2.3"), /inventory limit/);
  assert.equal(calls, 11);
  calls = 0;
  await assert.rejects(latestStableBinary(async () => {calls++; return {code: 0, stdout: JSON.stringify(Array.from({length: 30}, () => release("alpha-old", 4))), stderr: ""};}, "1.2.3"), /inventory limit/);
  assert.equal(calls, 100);
  for (const [stderr, expected] of [["HTTP 401 secret-token", /not authenticated/], ["HTTP 429 secret-token", /rate limit/]] as const) {
    await assert.rejects(latestStableBinary(async () => ({code: 1, stdout: "", stderr}), "1.2.3"), error => error instanceof Error && expected.test(error.message) && !error.message.includes("secret-token"));
  }
});

// Small ZIP fixture writer gives tests direct control over malicious central
// directory metadata, without invoking a host archiver or touching real apps.
function zip(entries: {name: string; data?: string; mode?: number; size?: number}[]): Buffer {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name), data = Buffer.from(e.data ?? ""), compressed = deflateRawSync(data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc32(data), 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(e.size ?? data.length, 22); header.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(0x314, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(8, 10);
    record.writeUInt32LE(crc32(data), 16); record.writeUInt32LE(compressed.length, 20); record.writeUInt32LE(e.size ?? data.length, 24); record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(((e.mode ?? 0o100644) * 65536) >>> 0, 38); record.writeUInt32LE(offset, 42);
    local.push(header, name, compressed); central.push(record, name); offset += header.length + name.length + compressed.length;
  }
  const records = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(records.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, records, end]);
}
const executable = {name: "Mission Control.app/Contents/MacOS/Mission Control", data: "binary", mode: 0o100755};

test("bounded extraction preserves executables and internal Electron framework links", async t => {
  const root = await mkdtemp(join(tmpdir(), "mission-binary-zip-")); t.after(() => rm(root, {recursive: true, force: true}));
  const archive = join(root, "app.zip"), out = join(root, "out"); await mkdir(out);
  await writeFile(archive, zip([executable,
    {name: "Mission Control.app/Contents/Frameworks/Example.framework/Versions/A/Example", data: "framework", mode: 0o100755},
    {name: "Mission Control.app/Contents/Frameworks/Example.framework/Versions/Current", data: "A", mode: 0o120777},
    {name: "Mission Control.app/Contents/Frameworks/Example.framework/Example", data: "Versions/Current/Example", mode: 0o120777},
    {name: "__MACOSX/Mission Control.app/Contents/._Info.plist", data: "resource"},
  ]));
  const app = await extractBinaryArchive(archive, out, new AbortController().signal);
  assert.equal((await lstat(join(out, executable.name))).mode & 0o777, 0o755);
  assert.equal(await readlink(join(app, "Contents/Frameworks/Example.framework/Versions/Current")), "A");
  assert.equal(await readFile(join(app, "Contents/Frameworks/Example.framework/Example"), "utf8"), "framework");
});

test("archive traversal, roots, aliases, links, collisions and expansion limits are refused", async t => {
  const root = await mkdtemp(join(tmpdir(), "mission-binary-zip-refused-")); t.after(() => rm(root, {recursive: true, force: true}));
  const bad = [
    {name: "/tmp/escape", data: "x"}, {name: "Mission Control.app/../escape", data: "x"}, {name: "Other.app/file", data: "x"},
    {name: executable.name, data: "duplicate"}, {name: executable.name.toUpperCase(), data: "case alias"},
    {name: "Mission Control.app/contents/other", data: "implicit directory alias"},
    {name: `Mission Control.app/Contents/${"deep/".repeat(64)}file`, data: "too deep"},
    {name: "Mission Control.app/Contents/link", data: "../../../escape", mode: 0o120777},
    {name: "Mission Control.app/Contents/link", data: "/tmp/escape", mode: 0o120777},
    {name: "Mission Control.app/Contents/link", data: "link", mode: 0o120777},
    {name: "Mission Control.app/Contents/MacOS", data: "target", mode: 0o120777},
    {name: "Mission Control.app/Contents/bomb", data: "x", size: 4 * 1024 ** 3 - 2},
  ];
  for (const [i, entry] of bad.entries()) {
    const out = join(root, String(i)); await mkdir(out);
    const archive = join(root, `${i}.zip`); await writeFile(archive, zip([executable, entry]));
    await assert.rejects(extractBinaryArchive(archive, out, new AbortController().signal), entry.name);
  }
  const archive = join(root, "limit.zip"); await writeFile(archive, zip([executable]));
  await assert.rejects(extractBinaryArchive(archive, root, new AbortController().signal, {bytes: 2, entries: 10}), /size limit/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(extractBinaryArchive(archive, root, abort.signal), /aborted/);
});

test("corrupt archive streams reject safely when destination creation is delayed", async t => {
  const root = await mkdtemp(join(tmpdir(), "mission-binary-zip-stream-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const archive = join(root, "corrupt.zip");
  await writeFile(archive, zip([{...executable, size: 100}]));
  const originalMkdir = fsPromises.mkdir;
  const delayed = t.mock.method(fsPromises, "mkdir", (async (...args: Parameters<typeof fsPromises.mkdir>) => {
    await new Promise(resolve => setTimeout(resolve, 50));
    return originalMkdir(...args);
  }) as typeof fsPromises.mkdir);
  syncBuiltinESMExports();
  t.after(() => {delayed.mock.restore(); syncBuiltinESMExports();});
  await assert.rejects(extractBinaryArchive(archive, join(root, "out"), new AbortController().signal), /not enough bytes/);
});

test("canonical download streams progress, redacts credentials, detects corruption/truncation and settles cancellation", async t => {
  const root = await mkdtemp(join(tmpdir(), "mission-binary-download-")); t.after(() => rm(root, {recursive: true, force: true}));
  const payload = "published immutable bytes", command = join(root, "gh"), asset = {...binaryOffer().manifest.assets[0]!, bytes: Buffer.byteLength(payload), sha256: digest(payload)};
  const script = async (body: string) => writeFile(command, `#!${process.execPath}\n${body}\n`, {mode: 0o700});
  await script(`if (process.env.GH_DEBUG || process.env.DEBUG) process.exit(4); console.log = () => {}; process.stdout.write(${JSON.stringify(payload)});`);
  const progress: number[] = [];
  const run = (name: string, signal = new AbortController().signal, selected = asset, timeoutMs = 1000) => downloadBinaryAsset({command, env: {...process.env, GH_DEBUG: "api", DEBUG: "headers"}, asset: selected,
    path: join(root, name), signal, timeoutMs, onBytes: n => progress.push(n)});
  await run("valid"); assert.deepEqual(progress, [0, payload.length]); assert.equal(await readFile(join(root, "valid"), "utf8"), payload);
  await assert.rejects(run("digest", undefined, {...asset, sha256: "0".repeat(64)}), /SHA-256/);
  await assert.rejects(run("truncated", undefined, {...asset, bytes: asset.bytes + 1}), /truncated/);
  await assert.rejects(run("oversized", undefined, {...asset, bytes: 2}), /exceeds/);
  await script('process.stderr.write("private URL secret (HTTP 404)"); process.exitCode = 1;');
  await assert.rejects(run("expired"), /expired or is unavailable/);
  await script('setInterval(() => {}, 100);');
  const abort = new AbortController(); const pending = run("cancelled", abort.signal); setTimeout(() => abort.abort(), 50);
  await assert.rejects(pending, /aborted/);
  await assert.rejects(run("timeout", undefined, asset, 50), /timed out/);
});

test("a cancelled preparation settles its worker before cleanup and exposes only bundled-runtime environment", async t => {
  const root = await mkdtemp(join(tmpdir(), "mission-binary-worker-")); t.after(() => rm(root, {recursive: true, force: true}));
  const worker = join(root, "worker.cjs");
  await writeFile(worker, `process.on('message', m => { if(m.kind === 'prepare') { if(process.env.ELECTRON_RUN_AS_NODE !== '1' || process.env.NODE_OPTIONS || process.env.NODE_PATH) process.exit(3); process.send({kind:'progress',stage:'download',transfer:{received:25,total:100}}); } if(m.kind === 'cancel') setTimeout(()=>process.disconnect(), 30); });`);
  const abort = new AbortController(); let reported = false;
  const outcome = await stageBinaryUpdate({offer: binaryOffer(), receipt: {schema: 1, repo: "teamupstart/mission-control", appPath: "/tmp/Mission Control.app", sourceClone: "/missing", installedVersion: "1.2.3", releaseTag: "v1.2.3", installedAt: "2026-10-25T00:00:00Z"}, targetTag: "v1.2.4", signal: abort.signal,
    onStage: (stage, transfer) => {assert.equal(stage, "download"); assert.equal(transfer?.received, 25); reported = true; abort.abort();}},
  {worker, stateDirectory: root, gh: "/not-invoked", env: {...process.env, NODE_OPTIONS: "--invalid", NODE_PATH: "/untrusted"}, log: () => {}});
  assert.equal(reported, true); assert.equal(outcome.ok, false); if (!outcome.ok) assert.equal(outcome.reason, "cancelled");
  const {readdir} = await import("node:fs/promises"); assert.deepEqual(await readdir(join(root, "update-downloads")), []);
});

test("download cleanup preserves live, unknown and handed-off attempts", async t => {
  const {cleanupBinaryDownloads} = await import("../src/main/update-binary.ts");
  const {atomicMigrationJson} = await import("../scripts/install-migration.mjs");
  const {processIdentity} = await import("../scripts/update-lock.mjs");
  const {realpath, readdir} = await import("node:fs/promises");
  const root = await realpath(await mkdtemp(join(tmpdir(), "mission-binary-cleanup-")));
  t.after(() => rm(root, {recursive: true, force: true}));
  const store = join(root, "update-downloads"); await mkdir(store);
  const dead = {pid: 99999999, identity: "old process"};
  for (const name of ["dead", "live", "unknown", "handoff"]) {
    const directory = join(store, `attempt-${name}`); await mkdir(directory);
    if (name === "unknown") continue;
    atomicMigrationJson(join(directory, "owner.json"), {protocol: 1, path: directory,
      parent: name === "live" ? {pid: process.pid, identity: processIdentity(process.pid)} : dead, worker: dead});
    if (name === "handoff") atomicMigrationJson(join(directory, "handoff.json"), {nonce: "a".repeat(64)});
  }
  cleanupBinaryDownloads(root);
  assert.deepEqual((await readdir(store)).sort(), ["attempt-handoff", "attempt-live", "attempt-unknown"]);
});

test("discard protects uncertain helper handoffs but removes candidates when no helper started", async t => {
  const {realpath} = await import("node:fs/promises");
  for (const scenario of ["unhanded", "orphan", "live", "unknown", "invalid"] as const) {
    await t.test(scenario, async t => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "mission-binary-discard-")));
      t.after(() => rm(root, {recursive: true, force: true}));
      const directory = join(root, "update-downloads", "attempt-candidate");
      const bundle = join(directory, "extracted", "Mission Control.app");
      await mkdir(bundle, {recursive: true});
      await writeFile(join(bundle, "candidate"), "accepted binary");
      const descriptor = binaryStaged({offer: binaryOffer(), receipt: {schema: 1, repo: "teamupstart/mission-control",
        appPath: "/tmp/Mission Control.app", sourceClone: "/missing", installedVersion: "1.2.3", releaseTag: "v1.2.3", installedAt: "2026-10-25T00:00:00Z"}}, bundle).descriptor;
      const nonce = "a".repeat(64);
      if (scenario !== "unhanded") retainBinaryHandoff(descriptor, root, nonce);
      if (scenario === "live" || scenario === "unknown") {
        const runtime = join(root, "update-runtimes", `attempt-${nonce}`);
        await mkdir(runtime, {recursive: true});
        if (scenario === "live") {
          const {processIdentity} = await import("../scripts/update-lock.mjs");
          await writeFile(join(runtime, "owner.json"), JSON.stringify({protocol: 1, nonce, path: runtime,
            helper: {pid: process.pid, identity: processIdentity(process.pid)}}));
        }
      }
      if (scenario === "invalid") await writeFile(join(directory, "handoff.json"), "{}");
      await discardBinaryUpdate(descriptor, root);
      if (scenario === "unhanded" || scenario === "orphan") await assert.rejects(lstat(directory), {code: "ENOENT"});
      else assert.equal(await readFile(join(bundle, "candidate"), "utf8"), "accepted binary");
    });
  }
});

test("native platform checks reject old macOS, wrong architecture and conflicting bundle metadata", async () => {
  const {verifyBinaryPlatform} = await import("../src/main/update-binary-platform.ts");
  const {binaryReceipt} = await import("./helpers/binary-update.ts");
  const receipt = binaryReceipt(binaryOffer(), {schema: 1, repo: "teamupstart/mission-control", appPath: "/tmp/Mission Control.app", sourceClone: "/missing", installedVersion: "1.2.3", releaseTag: "v1.2.3", installedAt: "2026-10-25T00:00:00Z"});
  assert.equal(receipt.kind, "binary"); if (receipt.kind !== "binary") return;
  const native = (os = "12.0", arch = "arm64", bundle = "com.mission-control.app") => (command: string, args: string[]) => {
    if (command === "/usr/bin/sw_vers") return os;
    if (command === "/usr/bin/lipo") return arch;
    return args[1] === "Print :CFBundleIdentifier" ? bundle : "12.0";
  };
  verifyBinaryPlatform("/fixture.app", receipt, native());
  verifyBinaryPlatform("/fixture.app", receipt, native("26.1"));
  assert.throws(() => verifyBinaryPlatform("/fixture.app", receipt, native("11.7")), /newer macOS/);
  assert.throws(() => verifyBinaryPlatform("/fixture.app", receipt, native("unknown")), /Cannot determine/);
  assert.throws(() => verifyBinaryPlatform("/fixture.app", receipt, native("12.0", "x86_64")), /wrong architecture/);
  assert.throws(() => verifyBinaryPlatform("/fixture.app", receipt, native("12.0", "arm64", "wrong.product")), /disagrees/);
});

test("the shared binary trust gate refuses a wrong signer and a non-notarized app", async t => {
  const {verifyBinaryPublisher} = await import("../scripts/install-staged-app.mjs");
  const {binaryPublisherPolicy} = await import("../src/shared/binary-publisher-policy.mjs");
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", {value: "darwin"});
  let wrongSigner = true;
  let notarized = false;
  const signature = t.mock.method(childProcess, "execFileSync", ((command: string, args: readonly string[]) => {
    assert.equal(command, "/usr/bin/codesign");
    assert.ok(args.includes("--strict"));
    assert.ok(args.some(arg => arg.includes(binaryPublisherPolicy().teamId)));
    if (wrongSigner) throw new Error("signature requirement rejected");
    return "";
  }) as typeof childProcess.execFileSync);
  const assessment = t.mock.method(childProcess, "spawnSync", ((command: string) => {
    assert.equal(command, "/usr/sbin/spctl");
    return {status: 0, stderr: notarized ? "source=Notarized Developer ID\n" : "source=Developer ID\n"};
  }) as typeof childProcess.spawnSync);
  syncBuiltinESMExports();
  t.after(() => {signature.mock.restore(); assessment.mock.restore(); syncBuiltinESMExports(); Object.defineProperty(process, "platform", platform);});
  assert.throws(() => verifyBinaryPublisher("/fixture.app", binaryPublisherPolicy()), /signature requirement rejected/);
  assert.equal(assessment.mock.callCount(), 0);
  wrongSigner = false;
  assert.throws(() => verifyBinaryPublisher("/fixture.app", binaryPublisherPolicy()), /notarized Developer ID/);
  notarized = true;
  verifyBinaryPublisher("/fixture.app", binaryPublisherPolicy());
});

test("the embedded preparation worker exits cleanly if its parent disconnects during download", async t => {
  const root = await mkdtemp(join(tmpdir(), "mission-binary-disconnect-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const gh = join(root, "gh");
  await writeFile(gh, `#!${process.execPath}\nsetInterval(() => {}, 100);\n`, {mode: 0o700});
  const worker = childProcess.fork(new URL("../src/main/update-binary-worker.ts", import.meta.url), [],
    {execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"]});
  t.after(() => worker.kill("SIGKILL"));
  let stderr = "";
  worker.stderr!.on("data", chunk => {stderr += chunk;});
  const exited = new Promise<number | null>(resolve => worker.once("exit", resolve));
  worker.on("message", (message: {kind: string}) => {if (message.kind === "progress" && worker.connected) worker.disconnect();});
  worker.send({kind: "prepare", work: {offer: binaryOffer(), directory: root, gh, env: process.env,
    receipt: {schema: 1, repo: "teamupstart/mission-control", appPath: "/tmp/Mission Control.app", sourceClone: "/missing", installedVersion: "1.2.3", releaseTag: "v1.2.3", installedAt: "2026-10-25T00:00:00Z"}}});
  assert.equal(await exited, 0, stderr);
  assert.equal(stderr, "");
});

for (const appName of ['Mission Control.app', 'Agent Mission Control.app']) test(`archive root is pinned to the accepted manifest layout: ${appName}`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'mission-layout-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const archive = join(root, 'app.zip');
  const entry = {...executable, name: `${appName}/Contents/MacOS/Mission Control`};
  await writeFile(archive, zip([entry]));
  const target = await extractBinaryArchive(archive, join(root, 'valid'), new AbortController().signal, undefined, undefined, appName);
  assert.equal(await readFile(join(target, 'Contents/MacOS/Mission Control'), 'utf8'), 'binary');
  const other = appName === 'Mission Control.app' ? 'Agent Mission Control.app' : 'Mission Control.app';
  await assert.rejects(extractBinaryArchive(archive, join(root, 'mismatch'), new AbortController().signal, undefined, undefined, other));
  await writeFile(archive, zip([entry, {...executable, name: `${other}/Contents/MacOS/Mission Control`}]));
  await assert.rejects(extractBinaryArchive(archive, join(root, 'mixed'), new AbortController().signal, undefined, undefined, appName));
});
