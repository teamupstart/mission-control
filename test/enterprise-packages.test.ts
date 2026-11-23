import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import { readEnterprisePackages } from "../src/server/setup/enterprise-packages.ts";
import defaults from "../config/enterprise-packages.json" with { type: "json" };
import { expandPiAgentDir, piExtensionStatus } from "../src/server/setup/pi-package.ts";
import type { EnvironmentDeps, FileRead } from "../src/server/environment/types.ts";

const pkg = { name: "@example/trace", version: "1.2.3", entry: "extensions/trace.js", conflicts: ["other-exporter"] };
const HOME = "/fixture/home";
const ROOT = join(HOME, ".pi", "agent");
const SOURCE = `npm:${pkg.name}@${pkg.version}`;
const MANIFEST = { name: pkg.name, version: pkg.version,
  pi: { extensions: [`./${pkg.entry}`] } };

function fixture(root = ROOT) {
  const settings = join(root, "settings.json");
  const packageDir = join(root, "npm", "node_modules", pkg.name);
  const manifest = join(packageDir, "package.json");
  const entry = join(packageDir, pkg.entry);
  const files = new Map<string, string | FileRead>([
    [settings, JSON.stringify({ packages: [SOURCE] })],
    [manifest, JSON.stringify(MANIFEST)],
    [entry, "throw new Error('the check must never execute this');"],
  ]);
  const reads: string[] = [];
  const deps: EnvironmentDeps = {
    homeDir: HOME,
    readText: async (path) => {
      reads.push(path);
      const value = files.get(path);
      return typeof value === "string" ? { ok: true, text: value, truncated: false }
        : value ?? { ok: false, missing: true, reason: "missing" };
    },
    subdirectories: async () => { throw new Error("The probe must not scan the filesystem"); },
  };
  return { deps, files, reads, settings, manifest, entry };
}

test("Pi package readiness is bounded installation evidence, not execution or export health", async () => {
  const f = fixture();
  const status = await piExtensionStatus(f.deps, pkg);
  assert.equal(status.state, "satisfied");
  assert.ok("evidence" in status && status.evidence?.includes(pkg.name));
  assert.deepEqual(f.reads, [f.settings, f.manifest, f.entry]);
});

test("a configured Pi home is used instead of the default home", async () => {
  const root = "/custom/pi-agent";
  const f = fixture(root);
  const status = await piExtensionStatus(f.deps, pkg, root);
  assert.equal(status.state, "satisfied");
  assert.ok(f.reads.every((path) => path.startsWith(`${root}/`)));
});

test("an installed but unregistered package is not reported ready", async () => {
  for (const contents of [undefined, "{}", JSON.stringify({ packages: [`npm:${pkg.name}-unrelated`] })]) {
    const f = fixture();
    if (contents === undefined) f.files.delete(f.settings);
    else f.files.set(f.settings, contents);
    assert.deepEqual(await piExtensionStatus(f.deps, pkg), { state: "missing" });
    assert.deepEqual(f.reads, [f.settings]);
  }
});

test("unknown settings never expose file contents or read-error messages", async () => {
  for (const value of [
    '{"credential":"secret-marker"',
    JSON.stringify({ packages: 17, credential: "secret-marker" }),
    { ok: false, missing: false, reason: "secret-marker" },
    { ok: true, text: JSON.stringify({ packages: [SOURCE] }), truncated: true },
  ] satisfies Array<string | FileRead>) {
    const f = fixture();
    f.files.set(f.settings, value);
    const status = await piExtensionStatus(f.deps, pkg);
    assert.equal(status.state, "unknown");
    assert.doesNotMatch(JSON.stringify(status), /secret-marker/);
    assert.deepEqual(f.reads, [f.settings]);
  }
});

test("filtered, duplicate or competing package declarations cannot claim readiness", async () => {
  for (const packages of [
    [{ source: SOURCE, autoload: false }],
    [{ source: SOURCE, extensions: [] }],
    [{ source: SOURCE, extensions: ["!**/otel/**"] }],
    [SOURCE, SOURCE],
    [SOURCE, "npm:other-exporter@0.3.0"],
  ]) {
    const f = fixture();
    f.files.set(f.settings, JSON.stringify({ packages }));
    assert.equal((await piExtensionStatus(f.deps, pkg)).state, "unknown");
    assert.deepEqual(f.reads, [f.settings]);
  }
});

test("string and unfiltered object declarations, including BOM settings, are supported", async () => {
  for (const source of [SOURCE, { source: SOURCE }]) {
    const f = fixture();
    f.files.set(f.settings, `\uFEFF${JSON.stringify({ packages: [source] })}`);
    assert.equal((await piExtensionStatus(f.deps, pkg)).state, "satisfied");
  }
});

test("an installed version that does not match the registered pin is not ready", async () => {
  const f = fixture();
  f.files.set(f.settings, JSON.stringify({ packages: [`npm:${pkg.name}@0.1.1-alpha.5`] }));
  assert.equal((await piExtensionStatus(f.deps, pkg)).state, "needs-setup");
  f.files.set(f.settings, JSON.stringify({ packages: [`npm:${pkg.name}@2.0.0`] }));
  f.files.set(f.manifest, JSON.stringify({ ...MANIFEST, version: "2.0.0" }));
  assert.equal((await piExtensionStatus(f.deps, pkg)).state, "needs-setup", "the enterprise pin must also match");
  for (const suffix of ["@alpha", "@^0.1.0"]) {
    f.files.set(f.settings, JSON.stringify({ packages: [`npm:${pkg.name}${suffix}`] }));
    assert.equal((await piExtensionStatus(f.deps, pkg)).state, "unknown");
  }
});

test("an empty npm version suffix cannot claim installation readiness", async () => {
  const source = `npm:${pkg.name}@`;
  for (const declaration of [source, { source }]) {
    const f = fixture();
    f.files.set(f.settings, JSON.stringify({ packages: [declaration] }));
    const status = await piExtensionStatus(f.deps, pkg);
    assert.equal(status.state, "unknown");
    assert.deepEqual(f.reads, [f.settings], "reject the declaration before inspecting installed files");
  }
});

test("a genuinely unversioned package declaration remains supported", async () => {
  const source = `npm:${pkg.name}`;
  for (const declaration of [source, { source }]) {
    const f = fixture();
    f.files.set(f.settings, JSON.stringify({ packages: [declaration] }));
    assert.equal((await piExtensionStatus(f.deps, pkg)).state, "satisfied");
  }
});

test("a non-exact package version stays unknown before installed files are read", async () => {
  for (const suffix of ["@latest", "@^0.1.0"]) {
    const f = fixture();
    f.files.set(f.settings, JSON.stringify({ packages: [`npm:${pkg.name}${suffix}`] }));
    f.files.delete(f.manifest);
    assert.equal((await piExtensionStatus(f.deps, pkg)).state, "unknown");
    assert.deepEqual(f.reads, [f.settings]);
  }
});

test("missing and unsupported package manifests are not healthy installations", async () => {
  for (const [contents, state] of [
    [undefined, "needs-setup"], ["{}", "unknown"],
    [JSON.stringify({ ...MANIFEST, pi: { extensions: [] } }), "unknown"],
  ] as const) {
    const f = fixture();
    if (contents === undefined) f.files.delete(f.manifest);
    else f.files.set(f.manifest, contents);
    assert.equal((await piExtensionStatus(f.deps, pkg)).state, state);
  }
});

test("missing, unreadable and empty extension entries report their specific installation gaps", async () => {
  for (const [value, state] of [
    [undefined, "needs-setup"], ["", "needs-setup"],
    [{ ok: false, missing: false, reason: "private diagnostic" }, "unknown"],
  ] satisfies Array<[string | FileRead | undefined, string]>) {
    const f = fixture();
    if (value === undefined) f.files.delete(f.entry);
    else f.files.set(f.entry, value);
    const status = await piExtensionStatus(f.deps, pkg);
    assert.equal(status.state, state);
    assert.doesNotMatch(JSON.stringify(status), /private diagnostic/);
  }
});

test("PI_CODING_AGENT_DIR expands only a bare leading tilde, as Pi does", () => {
  const home = "/Users/op";
  assert.equal(expandPiAgentDir(undefined, home), undefined);
  assert.equal(expandPiAgentDir("~", home), home);
  assert.equal(expandPiAgentDir("~/pi", home), "/Users/op/pi");
  assert.equal(expandPiAgentDir("", home), undefined);
  assert.equal(expandPiAgentDir("~\\pi", home, "darwin"), resolve("~\\pi"));
  assert.equal(expandPiAgentDir("~\\pi", home, "win32"), resolve("/Users/op\\pi"));
  assert.equal(expandPiAgentDir("~user/pi", home), resolve("~user/pi"));
  assert.equal(expandPiAgentDir("relative/pi", home), join(process.cwd(), "relative/pi"));
  assert.equal(expandPiAgentDir("/abs/pi", home), "/abs/pi");
});

test("the Pi telemetry guide installs and removes the cataloged package pin", () => {
  const guide = readFileSync(new URL("../docs/pi-telemetry.md", import.meta.url), "utf8");
  const pinned = defaults.packages[0]!.source;
  assert.ok(guide.includes(`pi install ${pinned}`), "install command drifted from the catalog pin");
  assert.ok(guide.includes(`pi remove ${pinned}`), "remove command drifted from the catalog pin");
});

test("the catalog replaces the defaults for all harnesses, preserves order and permits an empty deployment", async () => {
  const f = fixture();
  const path = "/fixture/catalog.json";
  const read = () => readEnterprisePackages(f.deps, path);
  assert.deepEqual((await read()).byHarness.pi?.map((p) => p.source), [defaults.packages[0]!.source]);
  const guide = { source: "example-plugin", label: "Example", guide: "https://example.org/install", description: "Example package" };
  const packages = [
    { harness: "codex", ...guide }, { harness: "claude", ...guide },
    { harness: "pi", ...guide, source: SOURCE, piExtension: { entry: pkg.entry } },
    { harness: "codex", ...guide, source: "second" },
  ];
  f.files.set(path, JSON.stringify({ packages }));
  const { byHarness } = await read();
  assert.deepEqual(byHarness.codex?.map((p) => p.source), ["example-plugin", "second"]);
  assert.deepEqual(byHarness.claude, [guide]);
  assert.equal(byHarness.pi?.[0]?.status?.state, "satisfied");
  f.files.set(path, '{"packages":[]}');
  assert.deepEqual(await read(), { byHarness: {} });
});

test("bad catalog data is reported without exposing its contents or probing a package", async () => {
  const f = fixture();
  const path = "/fixture/catalog.json";
  const item = defaults.packages[0]!;
  for (const packages of [
    [item, item], [{ ...item, guide: "javascript:secret" }], [{ ...item, harness: "other" }],
    [{ ...item, harness: "codex" }], [{ ...item, source: "npm:../../secret@1.0.0" }],
    [{ ...item, piExtension: { entry: "../secret" } }], Array(65).fill(item),
  ]) {
    f.files.set(path, JSON.stringify({ packages }));
    const result = await readEnterprisePackages(f.deps, path);
    assert.deepEqual(result.byHarness, {});
    assert.match(result.error!, /Invalid package catalog/);
    assert.doesNotMatch(result.error!, /secret/);
  }
  for (const read of [
    { ok: true, text: '{"secret":', truncated: false },
    { ok: true, text: '{"packages":[]}', truncated: true },
    { ok: false, reason: "secret", missing: false },
  ] satisfies FileRead[]) {
    f.files.set(path, read);
    const result = await readEnterprisePackages(f.deps, path);
    assert.ok(result.error);
    assert.doesNotMatch(result.error, /secret/);
    assert.deepEqual(result.byHarness, {});
  }
  assert.deepEqual([...new Set(f.reads)], [path]);
});
