import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { GithubIssuesConfigSchema } from "../src/shared/task-source.ts";
import { githubIssues } from "../src/server/task-sources/github-issues.ts";

for (const abort of [false, true]) {
  test(`linked GitHub reads ${abort ? "stop scheduling after abort" : "use a bounded pool and preserve per-item results"}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "mission-linked-pool-"));
    const bin = join(dir, "gh");
    const log = join(dir, "calls");
    const release = join(dir, "release");
    const previous = process.env.MISSION_GH_BIN;
    writeFileSync(bin, `#!/usr/bin/env node
const fs = require("node:fs");
const url = process.argv[4];
const number = Number(url.split("/").at(-1));
fs.appendFileSync("calls", "start " + number + "\\n");
const timer = setInterval(() => {
  if (!fs.existsSync("release")) return;
  clearInterval(timer);
  fs.appendFileSync("calls", "end " + number + "\\n");
  if (number === 3) { process.stderr.write("private provider diagnostic"); process.exitCode = 1; }
  else process.stdout.write(JSON.stringify({ number, title: "Issue " + number, body: "Body", url, labels: [] }));
}, 10);
`, { mode: 0o755 });
    process.env.MISSION_GH_BIN = bin;
    const controller = new AbortController();
    const refs = Array.from({ length: 9 }, (_, i) => ({
      sourceId: "source", externalId: `acme/demo#${i + 1}`,
      url: i === 8 ? null : `https://github.com/acme/demo/issues/${i + 1}`,
    }));
    const pending = githubIssues.readLinked!(GithubIssuesConfigSchema.parse({}), refs, {
      sourceId: "source", repoRoot: dir, signal: controller.signal,
    });
    const events = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
    try {
      const deadline = Date.now() + 5_000;
      while (events().length < 4 && Date.now() < deadline) await delay(10);
      assert.equal(events().length, 4, "four reads must start before any result is released");
      if (abort) controller.abort();
      writeFileSync(release, "");
      const result = await pending;
      let active = 0;
      let peak = 0;
      for (const event of events()) {
        active += event.startsWith("start") ? 1 : -1;
        peak = Math.max(peak, active);
      }
      assert.equal(peak, 4, "the pool must never exceed four active reads");
      assert.equal(active, 0);
      assert.equal(events().filter((event) => event.startsWith("start")).length, abort ? 4 : 8);
      if (abort) {
        assert.equal(result.error, "the linked refresh was abandoned");
        assert.equal(result.itemErrors, undefined, "aborted refreshes do not expose partial errors");
      } else {
        assert.equal(result.error, null);
        assert.deepEqual(result.items.map((item) => item.ref.externalId).sort(),
          [1, 2, 4, 5, 6, 7, 8].map((n) => `acme/demo#${n}`));
        assert.deepEqual(Object.keys(result.itemErrors!).sort(), ["acme/demo#3", "acme/demo#9"]);
        assert.ok(!JSON.stringify(result).includes("private provider diagnostic"));
      }
    } finally {
      writeFileSync(release, "");
      await pending;
      if (previous === undefined) delete process.env.MISSION_GH_BIN;
      else process.env.MISSION_GH_BIN = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
