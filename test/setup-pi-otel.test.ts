import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import { PI_OTEL_PACKAGE } from "../src/shared/setup-catalog.ts";
import { expandPiAgentDir, piOtelPackageStatus } from "../src/server/setup/pi-otel.ts";
import type { EnvironmentDeps, FileRead } from "../src/server/environment/types.ts";

const HOME = "/fixture/home";
const ROOT = join(HOME, ".pi", "agent");
const SOURCE = `npm:${PI_OTEL_PACKAGE.name}@${PI_OTEL_PACKAGE.version}`;
const MANIFEST = { name: PI_OTEL_PACKAGE.name, version: PI_OTEL_PACKAGE.version,
  pi: { extensions: [`./${PI_OTEL_PACKAGE.entry}`] } };

function fixture(root = ROOT) {
  const settings = join(root, "settings.json");
  const packageDir = join(root, "npm", "node_modules", PI_OTEL_PACKAGE.name);
  const manifest = join(packageDir, "package.json");
  const entry = join(packageDir, PI_OTEL_PACKAGE.entry);
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

test("Pi telemetry readiness is bounded installation evidence, not execution or export health", async () => {
  const f = fixture();
  const status = await piOtelPackageStatus(f.deps);
  assert.equal(status.state, "satisfied");
  assert.ok("evidence" in status && status.evidence?.includes("export health is not checked"));
  assert.deepEqual(f.reads, [f.settings, f.manifest, f.entry]);
});

test("a configured Pi home is used instead of the default home", async () => {
  const root = "/custom/pi-agent";
  const f = fixture(root);
  const status = await piOtelPackageStatus(f.deps, root);
  assert.equal(status.state, "satisfied");
  assert.ok(f.reads.every((path) => path.startsWith(`${root}/`)));
});

test("an installed but unregistered package is not reported ready", async () => {
  for (const contents of [undefined, "{}", JSON.stringify({ packages: ["npm:@upstart/pi-router-otel-unrelated"] })]) {
    const f = fixture();
    if (contents === undefined) f.files.delete(f.settings);
    else f.files.set(f.settings, contents);
    assert.deepEqual(await piOtelPackageStatus(f.deps), { state: "missing" });
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
    const status = await piOtelPackageStatus(f.deps);
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
    [SOURCE, "npm:pi-otel@0.3.0"],
  ]) {
    const f = fixture();
    f.files.set(f.settings, JSON.stringify({ packages }));
    assert.equal((await piOtelPackageStatus(f.deps)).state, "unknown");
    assert.deepEqual(f.reads, [f.settings]);
  }
});

test("string and unfiltered object declarations, including BOM settings, are supported", async () => {
  for (const source of [SOURCE, { source: SOURCE }]) {
    const f = fixture();
    f.files.set(f.settings, `\uFEFF${JSON.stringify({ packages: [source] })}`);
    assert.equal((await piOtelPackageStatus(f.deps)).state, "satisfied");
  }
});

test("an installed version that does not match the registered pin is not ready", async () => {
  const f = fixture();
  f.files.set(f.settings, JSON.stringify({ packages: [`npm:${PI_OTEL_PACKAGE.name}@0.1.1-alpha.5`] }));
  assert.equal((await piOtelPackageStatus(f.deps)).state, "needs-setup");
  for (const suffix of ["@alpha", "@^0.1.0"]) {
    f.files.set(f.settings, JSON.stringify({ packages: [`npm:${PI_OTEL_PACKAGE.name}${suffix}`] }));
    assert.equal((await piOtelPackageStatus(f.deps)).state, "unknown");
  }
});

test("an empty npm version suffix cannot claim installation readiness", async () => {
  const source = `npm:${PI_OTEL_PACKAGE.name}@`;
  for (const declaration of [source, { source }]) {
    const f = fixture();
    f.files.set(f.settings, JSON.stringify({ packages: [declaration] }));
    const status = await piOtelPackageStatus(f.deps);
    assert.equal(status.state, "unknown");
    assert.deepEqual(f.reads, [f.settings], "reject the declaration before inspecting installed files");
  }
});

test("a genuinely unversioned package declaration remains supported", async () => {
  const source = `npm:${PI_OTEL_PACKAGE.name}`;
  for (const declaration of [source, { source }]) {
    const f = fixture();
    f.files.set(f.settings, JSON.stringify({ packages: [declaration] }));
    assert.equal((await piOtelPackageStatus(f.deps)).state, "satisfied");
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
    assert.equal((await piOtelPackageStatus(f.deps)).state, state);
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
    const status = await piOtelPackageStatus(f.deps);
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
  const pinned = `npm:${PI_OTEL_PACKAGE.name}@${PI_OTEL_PACKAGE.version}`;
  assert.ok(guide.includes(`pi install ${pinned}`), "install command drifted from the catalog pin");
  assert.ok(guide.includes(`pi remove ${pinned}`), "remove command drifted from the catalog pin");
});
