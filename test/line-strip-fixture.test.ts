import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("./fixtures/line-strip-browser.cjs", import.meta.url), "utf8");

test("the Line fixture flushes its result and exits even when graceful shutdown cannot finish", async () => {
  const measured = { console: { lineHeight: 86, viewport: { width: 1400, height: 900 } } };
  const exits: number[] = [];
  let output = "";
  let flush: (() => void) | undefined;
  const app = {
    whenReady: () => Promise.resolve(),
    // Model a graceful Electron shutdown that never completes. The real failure had
    // all geometry on stdout but kept execFileSync waiting until its launch timeout.
    quit: () => {},
    exit: (code: number) => { exits.push(code); },
  };
  await runInNewContext(source, {
    require: (name: string) => {
      if (name === "electron") return { app };
      assert.equal(name, "./measuring-window.cjs");
      return {
        budgetFromArgv: () => 100,
        pagesFromArgv: () => ["console.html"],
        viewportFromArgv: () => measured.console.viewport,
        measurePages: async () => measured,
      };
    },
    process: { argv: [], stdout: { write: (text: string, callback?: () => void) => {
      output += text;
      flush = callback;
      return false; // stdout is still draining; exiting now could truncate the JSON.
    } } },
    console,
    setImmediate,
  });
  assert.deepEqual(JSON.parse(output), measured);
  assert.deepEqual(exits, [], "the result must finish writing before Electron exits");
  assert.ok(flush, "the fixture must await stdout completion before exiting");
  flush();
  assert.deepEqual(exits, [0], "a completed measurement must not wait on graceful shutdown");
});
