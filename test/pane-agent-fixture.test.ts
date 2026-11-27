import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";

const source = transformSync(
  readFileSync(new URL("../e2e/fixtures/pane-agent.mjs", import.meta.url), "utf8"),
  { format: "cjs" },
).code;
const ESC = String.fromCharCode(27);
const START = `${ESC}[200~`;
const END = `${ESC}[201~`;

/** Run the actual fixture listener with exact data events, without OS pipe coalescing. */
function paneAgent(wholeTurns = true) {
  const stdin = Object.assign(new EventEmitter(), { resume() {}, setEncoding() {} });
  const turns: string[] = [];
  let screen = "";
  runInNewContext(source, {
    require: (name: string) => {
      if (name === "node:crypto") return { randomUUID: () => "fixture-session" };
      assert.equal(name, "node:fs");
      return { appendFileSync: (_path: string, line: string) => {
        turns.push(JSON.parse(line).text);
      } };
    },
    process: {
      argv: ["node", "pane-agent.mjs", "http://fixture", "token", "%1", "/repo", "/transcripts"],
      env: wholeTurns ? { PANE_AGENT_TURNS: "turns.jsonl" } : {},
      stdin,
      stdout: { write: (text: string) => {
        if (text === `${ESC}[2J${ESC}[H`) screen = "";
        else screen += text;
      } },
    },
    fetch: async () => ({}),
    setTimeout() {},
    setInterval() {},
  });
  return { turns, screen: () => screen, write: (chunk: string) => stdin.emit("data", chunk) };
}

test("pane agent buffers every split of both paste markers until Enter submits the whole turn", () => {
  for (let start = 1; start < START.length; start++) {
    for (let end = 1; end < END.length; end++) {
      const agent = paneAgent();
      agent.write(START.slice(0, start));
      agent.write(`${START.slice(start)}first\nsecond${END.slice(0, end)}`);
      assert.deepEqual(agent.turns, [], `start split ${start}, end split ${end}`);
      agent.write(END.slice(end));
      assert.deepEqual(agent.turns, [], "closing a paste must not submit it");
      // Drawn as Claude draws a pending multi-line paste, which is what `injectPrompt` verifies a submit by.
      assert.equal(agent.screen(), "\r\n> [Pasted text #1 +1 lines]");
      agent.write("\r");
      assert.deepEqual(agent.turns, ["first\nsecond"]);
      agent.write("next\r");
      assert.deepEqual(agent.turns, ["first\nsecond", "next"]);
    }
  }
});

test("pane agent accepts markers arriving one byte at a time", () => {
  const agent = paneAgent();
  for (const ch of `${START}first\nsecond${END}`) {
    agent.write(ch);
    assert.deepEqual(agent.turns, []);
  }
  agent.write("\n");
  assert.deepEqual(agent.turns, ["first\nsecond"]);
  assert.equal(agent.screen(), "[took 12 chars]\r\n\r\n> ", "a submitted paste leaves the composer");
});

test("pane agent numbers each paste in a turn and starts again after a submission", () => {
  const agent = paneAgent();
  agent.write(`${START}one\ntwo${END} ${START}three\nfour${END}`);
  assert.equal(agent.screen(), "\r\n> [Pasted text #2 +2 lines]");
  agent.write("\r");
  agent.write(`${START}five\nsix${END}`);
  assert.equal(agent.screen(), "[took 18 chars]\r\n\r\n> [Pasted text #1 +1 lines]");
  agent.write("single line");
  agent.write("\r");
  assert.deepEqual(agent.turns, ["one\ntwo three\nfour", "five\nsixsingle line"]);
});

test("pane agent preserves complete pastes, ordinary input, tabs and backspace", () => {
  const agent = paneAgent();
  agent.write(`prefix ${START}first\nsecond${END} ${START}third\rfourth${END}\tx\x7fy\rnext\n`);
  assert.deepEqual(agent.turns, ["prefix first\nsecond third\nfourth\ty", "next"]);
});

test("pane agent releases a buffered prefix when subsequent input is not a marker", () => {
  const agent = paneAgent();
  agent.write(`before${ESC}[20`);
  agent.write(`x${START}inside\n`);
  agent.write(`${ESC}[201`);
  agent.write(`!after${END}\r`);
  assert.deepEqual(agent.turns, ["before[20xinside\n[201!after"]);
});

test("pane agent strips split markers in legacy mode without changing newline submission", () => {
  const agent = paneAgent(false);
  for (const ch of `${START}first\nsecond${END}`) agent.write(ch);
  assert.equal(agent.screen(), "[took 5 chars]\r\n\r\n> second");
  agent.write("\r");
  assert.equal(agent.screen(), "[took 5 chars]\r\n[took 6 chars]\r\n\r\n> ");
});
