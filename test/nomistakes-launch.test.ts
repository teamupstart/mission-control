import { test } from "node:test";
import assert from "node:assert/strict";
import { isNomistakesDriver } from "../src/server/discovery/nomistakes-launch.ts";

test("isNomistakesDriver matches only the real no-mistakes run-driving processes", () => {
  // The binary itself, driving or attaching to a run in a worktree.
  assert.equal(
    isNomistakesDriver('/Users/j/gopath/bin/no-mistakes axi run --intent "add a thing"'),
    true,
  );
  assert.equal(isNomistakesDriver("no-mistakes axi respond --action fix --findings a,b"), true);
  assert.equal(isNomistakesDriver("/opt/homebrew/bin/no-mistakes attach"), true);
  assert.equal(isNomistakesDriver("no-mistakes rerun"), true);
});

test("isNomistakesDriver ignores read-only, daemon, wrapper, and look-alike commands", () => {
  // Read-only peeks are not "driving" a run.
  assert.equal(isNomistakesDriver("no-mistakes axi status"), false);
  assert.equal(isNomistakesDriver("no-mistakes runs --limit 5"), false);
  // The daemon and its pipeline agents are not session-launched drivers.
  assert.equal(isNomistakesDriver("no-mistakes daemon run --root /Users/j/.no-mistakes"), false);
  // The wrapper shell that runs `cd <wt> && no-mistakes axi run` - argv0 is zsh,
  // not the binary; we bind to the real child process, not the wrapper.
  assert.equal(
    isNomistakesDriver("/bin/zsh -c 'cd /wt && no-mistakes axi run --intent x'"),
    false,
  );
  // A pipeline review agent whose giant prompt happens to contain "axi run" text.
  assert.equal(isNomistakesDriver("claude -p Context: branch mancej/x ... axi run ..."), false);
  // Unrelated command mentioning the tool.
  assert.equal(isNomistakesDriver('git commit -m "fix no-mistakes axi run parsing"'), false);
});
