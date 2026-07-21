import { test } from "node:test";
import assert from "node:assert/strict";

import { EMULATOR_IDS, MULTIPLEXER_IDS } from "../src/shared/terminal.ts";
import { binPresent, TMUX_BIN, WEZTERM_BIN } from "../src/server/terminal/bin.ts";
import { enumerateTerminals } from "../src/server/terminal/enumerate.ts";
import { EMULATORS, MULTIPLEXERS } from "../src/server/terminal/registry.ts";
import type { BinSpec } from "../src/server/terminal/types.ts";

// What is at stake: the one thing a registry sweep can quietly get wrong, and the one cost it
// must not impose.
//
// Wrong: naming priority. `nameSource` is decided by which backend answers FIRST, and that
// used to be the arm order of an if/else in `correlate.ts`. Moving it into the id arrays only
// helps if the arrays really are the order - a `Promise.all` that returned in completion order
// would make a session's name depend on which backend was slower this tick, which is a rename
// that flickers.
//
// Cost: discovery sweeps every registered backend every 1500ms. The registry must be free to
// know about Ghostty, cmux and iTerm2 without each one costing a doomed `fork` + `execve` per
// tick on a machine that has none of them installed.

test("a session's namer is decided by the id arrays, not by which backend answered first", async () => {
  // The arrays ARE the contract, so assert their shape rather than a shipped id: multiplexers
  // must all precede emulators, because a multiplexer pane lives inside an emulator pane and
  // is therefore the inner, more specific answer to "what is this session's terminal home?".
  const enumerated = await enumerateTerminals();
  const kinds = enumerated.map((e) => e.kind);
  assert.deepEqual(
    kinds,
    [...kinds].sort((a, b) => (a === b ? 0 : a === "multiplexer" ? -1 : 1)),
    "every multiplexer must be enumerated ahead of every emulator",
  );

  // And within an axis, declaration order - which is what makes the arrays the one place a
  // new backend says where it ranks.
  const ids = enumerated.map((e) => e.backend);
  const declared = [...MULTIPLEXER_IDS, ...EMULATOR_IDS].filter((id) => ids.includes(id));
  assert.deepEqual(ids, declared);
});

test("every enumerated backend is the one filed under its id", async () => {
  // A sweep that mislabelled its results would stamp the wrong `nameSource` on every session
  // that backend hosts, and nothing downstream could tell.
  for (const e of await enumerateTerminals()) {
    const backend = e.kind === "multiplexer" ? MULTIPLEXERS[e.backend] : EMULATORS[e.backend];
    assert.equal(backend.id, e.backend);
  }
});

test("a backend that is not installed costs no subprocess", () => {
  // Answered from the filesystem, never by running anything. A failed spawn is ~1-3ms and
  // scales with the number of registered adapters; a PATH walk is microseconds. This is the
  // whole reason the registry can carry adapters for backends this machine has never had.
  const absent: BinSpec = { env: null, candidates: ["definitely-not-a-real-binary-xyzzy"], dropEnv: [] };
  assert.equal(binPresent(absent), false);

  // A bare name is resolved against PATH rather than assumed present - the case
  // `resolveBin` deliberately cannot answer, since it returns the name unprobed.
  assert.equal(binPresent({ ...absent, candidates: ["sh"] }, { PATH: "/usr/bin:/bin" }), true);
  assert.equal(binPresent({ ...absent, candidates: ["sh"] }, { PATH: "" }), false);

  // An absolute path is tested as one, and an env override is re-tested rather than trusted -
  // which is what catches a stale WEZTERM_BIN pointing at an uninstalled app bundle.
  assert.equal(binPresent({ ...absent, candidates: ["/bin/sh"] }), true);
  assert.equal(binPresent({ ...absent, candidates: ["/nope/sh"] }), false);
  process.env.MISSION_TEST_ABSENT_BIN = "/nope/widget";
  try {
    assert.equal(binPresent({ ...absent, env: "MISSION_TEST_ABSENT_BIN" }), false);
  } finally {
    delete process.env.MISSION_TEST_ABSENT_BIN;
  }
});

test("presence is about the binary, not about the backend running", () => {
  // The distinction the gate must not blur. wezterm installed with no GUI up still gets
  // swept, and still degrades to [] - fast, via `--no-auto-start`. Skipping it because it
  // answered nothing last tick would mean a session never appearing after the user opens
  // their terminal. Only "could not possibly answer" is skippable.
  for (const spec of [TMUX_BIN, WEZTERM_BIN]) {
    assert.equal(typeof binPresent(spec), "boolean");
  }
});
