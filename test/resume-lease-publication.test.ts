import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createResumeLease, reconcileResumeLeases, resumeLeaseRoot, revokeResumeLease } from "../src/server/terminal/resume-lease.ts";

for (const operation of ["write", "publish"] as const) test(`failed lease ${operation} cannot publish a partial journal`, (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), "resume-publication-"));
  const root = resumeLeaseRoot(home);
  const preparing = new Set<string>();
  const originalOpen = fs.openSync, originalRename = fs.renameSync;
  const injected = Object.assign(new Error("fixture I/O failure"), { code: "EIO" });
  const fault = operation === "write"
    ? t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
      if (String(args[0]).includes("lease.json")) throw injected;
      return originalOpen(...args);
    })
    : t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
      if (String(args[1]).startsWith(join(root, "leases") + "/")) throw injected;
      return originalRename(...args);
    });
  syncBuiltinESMExports();
  try {
    assert.throws(() => createResumeLease(root, "failed", preparing), /fixture I\/O failure/);
  } finally { fault.mock.restore(); syncBuiltinESMExports(); }
  try {
    assert.deepEqual(fs.readdirSync(join(root, "leases")), []);
    assert.deepEqual(fs.readdirSync(join(root, "homes")), []);
    assert.equal(preparing.size, 0);
    const next = createResumeLease(root, "another-conversation", preparing);
    assert.ok(fs.existsSync(next.home), "an unrelated resume still prepares after the I/O failure");
    revokeResumeLease(next);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); }
});

test("a crash before writing the lease leaves no visible malformed journal", () => {
  const home = fs.mkdtempSync(join(tmpdir(), "resume-publication-crash-"));
  const root = resumeLeaseRoot(home);
  const module = pathToFileURL(join(process.cwd(), "src/server/terminal/resume-lease.ts")).href;
  const script = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
import {createResumeLease} from ${JSON.stringify(module)};
const open=fs.openSync;fs.openSync=(...args)=>{if(String(args[0]).includes('lease.json'))process.exit(55);return open(...args);};
syncBuiltinESMExports();createResumeLease(process.argv[1],'crashed',new Set());`;
  try {
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, root], { encoding: "utf8", timeout: 10_000 });
    assert.equal(child.status, 55, child.stderr);
    assert.deepEqual(fs.readdirSync(join(root, "leases")), []);
    assert.deepEqual(reconcileResumeLeases(root), []);
    const recovered = createResumeLease(root, "next", new Set());
    assert.ok(fs.existsSync(recovered.home));
    revokeResumeLease(recovered);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); }
});
