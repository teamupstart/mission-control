import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "mission-registry-subscribers-"));
process.env.HARNESS_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { Registry } = await import("../src/server/registry.ts");

// The daemon subscribes about a dozen services at boot and one more per open dashboard tab.
// Node's default of ten made every boot print a leak warning that was not a leak.
test("a hundred subscribers, the daemon's boot set and its dashboard tabs, raise no leak warning", async () => {
  const warnings: Error[] = [];
  const onWarning = (warning: Error) => warnings.push(warning);
  process.on("warning", onWarning);
  try {
    const registry = new Registry();
    const unsubscribes = Array.from({ length: 100 }, () => registry.subscribe(() => {}));
    await new Promise((resolve) => setImmediate(resolve));
    for (const unsubscribe of unsubscribes) unsubscribe();
  } finally {
    process.off("warning", onWarning);
  }
  assert.deepEqual(warnings.filter((w) => w.name === "MaxListenersExceededWarning").map((w) => w.message), []);
});

test("the hundred-and-first subscriber warns, so a leak still does", async () => {
  const warnings: Error[] = [];
  const onWarning = (warning: Error) => warnings.push(warning);
  process.on("warning", onWarning);
  try {
    const registry = new Registry();
    for (let i = 0; i < 101; i++) registry.subscribe(() => {});
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("warning", onWarning);
  }
  assert.equal(warnings.some((w) => w.name === "MaxListenersExceededWarning"), true);
});
