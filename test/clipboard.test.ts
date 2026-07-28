import { test } from "node:test";
import assert from "node:assert/strict";
import {
  copyText,
  type CopyTextEnvironment,
} from "../src/web/lib/clipboard.ts";

test("copyText prefers the async Clipboard API", async () => {
  const writes: string[] = [];
  const result = await copyText("repair packet", {
    clipboard: {
      async writeText(text) {
        writes.push(text);
      },
    },
    document: null,
  });

  assert.equal(result, "clipboard");
  assert.deepEqual(writes, ["repair packet"]);
});

test("copyText falls back to a selected textarea when clipboard permission is blocked", async () => {
  const calls: string[] = [];
  const style: Record<string, string> = {};
  const target = {
    value: "",
    style,
    setAttribute(name: string, value: string) {
      calls.push(`attribute:${name}:${value}`);
    },
    focus() {
      calls.push("target:focus");
    },
    select() {
      calls.push("target:select");
    },
    setSelectionRange(start: number, end: number) {
      calls.push(`range:${start}:${end}`);
    },
    remove() {
      calls.push("target:remove");
    },
  };
  const environment = {
    clipboard: {
      async writeText() {
        throw new Error("NotAllowedError");
      },
    },
    document: {
      activeElement: {
        focus() {
          calls.push("prior:focus");
        },
      },
      body: {
        appendChild(value: unknown) {
          assert.equal(value, target);
          calls.push("append");
          return value;
        },
      },
      createElement(name: string) {
        assert.equal(name, "textarea");
        return target;
      },
      execCommand(command: string) {
        calls.push(`command:${command}`);
        return true;
      },
    },
  } as unknown as CopyTextEnvironment;

  const result = await copyText("review feedback", environment);

  assert.equal(result, "fallback");
  assert.equal(target.value, "review feedback");
  assert.equal(style.opacity, "0");
  assert.deepEqual(calls, [
    "attribute:readonly:",
    "append",
    "target:focus",
    "target:select",
    "range:0:15",
    "command:copy",
    "target:remove",
    "prior:focus",
  ]);
});

test("copyText reports a refusal when neither clipboard route works", async () => {
  await assert.rejects(
    copyText("feedback", {
      clipboard: {
        async writeText() {
          throw new Error("clipboard blocked");
        },
      },
      document: null,
    }),
    /clipboard blocked/,
  );
});
