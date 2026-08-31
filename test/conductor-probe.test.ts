import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const home = mkdtempSync(join(tmpdir(), "mission-conductor-probe-"));
process.env.HARNESS_HOME = join(home, "state");

const checkout = join(home, "ai-conductor");
const bin = join(checkout, "bin", "conduct-ts");
const conductorRoot = join(checkout, "src", "conductor");
const versionDir = join(conductorRoot, "dist-versions", "published");
const invocationMarker = join(home, "capability-invoked");

mkdirSync(join(checkout, "bin"), { recursive: true });
mkdirSync(versionDir, { recursive: true });
writeFileSync(join(checkout, "VERSION"), "0.103.0\n");
execFileSync("git", ["init", "-q"], { cwd: checkout });
execFileSync(
  "git",
  ["-c", "user.name=Mission Test", "-c", "user.email=mission@example.invalid", "add", "VERSION"],
  { cwd: checkout },
);
execFileSync(
  "git",
  ["-c", "user.name=Mission Test", "-c", "user.email=mission@example.invalid", "commit", "-qm", "old release"],
  { cwd: checkout },
);
const publishedSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: checkout,
  encoding: "utf8",
}).trim();

writeFileSync(join(versionDir, ".engine-source-sha"), `${publishedSha}\n`);
writeFileSync(join(versionDir, "index.js"), "// published fixture\n");
symlinkSync(join("dist-versions", "published"), join(conductorRoot, "dist"), "dir");
writeFileSync(
  bin,
  `#!/bin/sh
if [ "$2" = "capabilities" ]; then
  printf invoked > ${JSON.stringify(invocationMarker)}
  printf '%s\\n' '{"schemaVersion":1,"engineerLifecycleEventsV1":true}'
else
  printf '%s\\n' '[]'
fi
`,
);
chmodSync(bin, 0o755);

writeFileSync(join(checkout, "VERSION"), "0.104.0\n");
execFileSync(
  "git",
  ["-c", "user.name=Mission Test", "-c", "user.email=mission@example.invalid", "add", "VERSION"],
  { cwd: checkout },
);
execFileSync(
  "git",
  ["-c", "user.name=Mission Test", "-c", "user.email=mission@example.invalid", "commit", "-qm", "new release"],
  { cwd: checkout },
);

process.env.MISSION_CONDUCTOR_BIN = bin;

const { probeConductor } = await import("../src/server/pipelines/conductor/probe.ts");
const {
  CONDUCTOR_ENGINEER_LIFECYCLE,
  resetConductorEngineerCapabilityCache,
} = await import("../src/server/pipelines/conductor/engineer.ts");

after(() => rmSync(home, { recursive: true, force: true }));

test("the probe reports the published executable version instead of the newer checkout marker", async () => {
  const probe = await probeConductor();
  assert.equal(probe.version, "0.103.0");
  assert.match(probe.error ?? "", /bundle is 0\.103\.0, but its checkout is 0\.104\.0/);
  assert.match(probe.error ?? "", /rerun .*bin\/install/);
});

test("a stale published bundle is refused before an old provider can launch an agent", async () => {
  resetConductorEngineerCapabilityCache();
  const answer = await CONDUCTOR_ENGINEER_LIFECYCLE.capability();

  assert.equal(answer.ok, false);
  if (!answer.ok) {
    assert.equal(answer.outcomeUnknown, false);
    assert.match(answer.error, /bundle is 0\.103\.0, but its checkout is 0\.104\.0/);
    assert.match(answer.error, /rerun .*bin\/install/);
  }
  assert.equal(existsSync(invocationMarker), false, "the incompatible provider command ran");
});
