import { test } from "node:test";
import assert from "node:assert/strict";
import {
  injectPrompt,
  paneAcceptsPrompt,
  sendText,
  type InjectDeps,
  type PaneDeps,
} from "../src/server/actions.ts";
import { capturePaneText } from "../src/server/discovery/pane-capture.ts";
import { bindSession } from "../src/server/terminal/registry.ts";
import type { BoundPane } from "../src/server/terminal/registry.ts";
import type { Key, TerminalResult } from "../src/server/terminal/types.ts";
import { stubRun, type RunResult } from "../src/server/util/exec.ts";
import type { Session } from "@shared/types.ts";
import { mkEmuHandle, mkMuxHandle } from "./helpers/session-fixture.ts";

// What is at stake: that a terminal backend which CANNOT do something refuses by
// declaration, rather than doing nothing quietly or typing into the wrong pane.
//
// Every read and write here used to be an open-coded `if (session.tmux) … else if
// (session.wezterm) …`, and a third backend fell off the end of that chain: every writer
// answered "this session has no handle to send to" about a pane it was holding, and the
// card looked entirely normal while nothing could be sent to it. Now the chain is
// `bindPane`, and what a caller branches on is a CAPABILITY - no write, no paste, no mode -
// which is a real difference in what can be done rather than in who is doing it.
//
// The capability nulls are asserted against hand-built panes, because no REGISTERED backend
// declares one yet: tmux and wezterm can both be typed into, and Ghostty - which can be
// launched into and raised, and neither enumerated nor captured nor written to - is the
// phase 5 acceptance test. A path first exercised by the adapter that depends on it is a
// path that ships broken, so it is driven here first.

const noHandles = (over: Partial<Session> = {}): Session =>
  ({ id: "s1", agent: "claude", terminals: [], ...over }) as Session;

const tmuxSession = (): Session =>
  ({
    id: "s1",
    agent: "claude",
    terminals: [mkMuxHandle({ session: "s", windowName: "w", windowIndex: 0, paneId: "%1" })],
  }) as Session;

const weztermSession = (): Session =>
  ({
    id: "s2",
    agent: "claude",
    terminals: [mkEmuHandle({ paneId: "7", tabId: "3", windowId: "0", tabTitle: "", isActive: true })],
  }) as Session;

/** A session hosted by BOTH: a tmux pane living inside a wezterm pane, the ordinary case. */
const nestedSession = (): Session =>
  ({
    id: "s3",
    agent: "claude",
    terminals: [mkMuxHandle({ session: "s", windowName: "w", windowIndex: 0, paneId: "%1" }), mkEmuHandle({ paneId: "7", tabId: "3", windowId: "0", tabTitle: "", isActive: true })],
  }) as Session;

const ok = (): TerminalResult => ({ ok: true, outcomeUnknown: false });

/**
 * A pane assembled by hand, one capability at a time, recording what was asked of it.
 *
 * Each option DECLARES a capability the way an adapter does, rather than overriding the
 * object wholesale, so a test that turns paste off still records the text writes it must
 * not have made instead.
 *
 * `backend` borrows a registered id because the union only admits backends that exist;
 * what is under test is the capability SHAPE a new one would declare, and `label` is what
 * a refusal has to name.
 */
function fakePane(opts: {
  label: string;
  canType?: boolean;
  canPaste?: boolean;
  mode?: () => Promise<string | null>;
}): { pane: BoundPane; did: string[] } {
  const did: string[] = [];
  const write = {
    text: async (text: string) => (did.push(`text:${text}`), ok()),
    keys: async (keys: readonly Key[]) => (did.push(`keys:${keys.join(",")}`), ok()),
    paste:
      opts.canPaste === false
        ? null
        : async (text: string) => (did.push(`paste:${text}`), ok()),
  };
  return {
    did,
    pane: {
      kind: "emulator",
      backend: "wezterm",
      label: opts.label,
      token: "fake:1",
      write: opts.canType === false ? null : write,
      capture: async () => null,
      mode: opts.mode ?? null,
    },
  };
}

const depsFor = (pane: BoundPane, screen: string | null = null): InjectDeps => ({
  pane: () => pane,
  capture: async () => screen,
  sleep: async () => {},
});

// ---- a backend that cannot be typed into at all ----

test("a backend with no write capability refuses every write, and types nothing", async () => {
  // Ghostty: discoverable, raisable, and there is no scripting CLI to put a keystroke
  // through. The old chain had no way to say this - a pane was a pane - so the refusal
  // would have arrived as "no handle", which is a claim about the session rather than
  // about the terminal, and is false.
  const { pane, did } = fakePane({ label: "Ghostty", canType: false });
  const deps = depsFor(pane);
  // No `tmux` and no `wezterm` field, deliberately: that is exactly the shape of a session
  // on a backend with no legacy field of its own, until phase 3 gives `Session` a list. The
  // writers must reach the pane through `deps.pane`, never through those two fields.
  const session = noHandles();

  const typed = await sendText(session, "hello", true, deps);
  assert.equal(typed.ok, false);
  assert.match(typed.error ?? "", /Ghostty/, "the refusal names the backend that cannot type");
  assert.notEqual(typed.paneBlocked, true, "not transient - nobody should retry this forever");

  const injected = await injectPrompt(session, "a\nb", deps);
  assert.equal(injected.ok, false);
  assert.equal(injected.pasted, false, "nothing reached the pane, so this stays retryable");
  assert.equal(injected.submitVerified, false);

  assert.deepEqual(did, [], "not one keystroke was attempted");
});

test("the destructive caller can ask first, and is told the same thing", async () => {
  // `TaskManager.assign` resets an agent's checkout before it types. Learning only
  // afterwards that the terminal cannot take a keystroke leaves an agent stripped for a
  // task that went straight back to the backlog.
  const { pane } = fakePane({ label: "Ghostty", canType: false });
  const r = await paneAcceptsPrompt(noHandles(), depsFor(pane));
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /Ghostty/);
});

// ---- a backend that can type but cannot paste ----

test("a backend with no bracketed paste refuses a prompt rather than shredding it", async () => {
  // The one substitution a caller must never make. Typing a multi-line body submits at
  // every newline, so "just use `text`" delivers the first line as a whole prompt and the
  // rest as follow-ups the agent answers one at a time.
  const { pane, did } = fakePane({ label: "cmux", canPaste: false });
  const r = await injectPrompt(noHandles(), "line one\nline two", depsFor(pane));

  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /cmux/);
  assert.equal(r.pasted, false, "nothing was delivered, so the caller may take it elsewhere");
  assert.deepEqual(did, [], "and it was refused BEFORE anything was typed - not typed instead");
});

// ---- the two nulls a mode probe must not confuse ----

test("no mode CONCEPT is not the same claim as no mode, and the write goes through", async () => {
  // An emulator has no session-level input mode to be stuck in, so there is nothing to
  // ask. Reading that as "cannot tell" would refuse every write on such a backend; the
  // wezterm path never probed for exactly this reason, and the null is that stated.
  const { pane, did } = fakePane({ label: "WezTerm" });
  const r = await sendText(noHandles(), "hello", true, depsFor(pane));

  assert.equal(r.ok, true);
  assert.deepEqual(did, ["text:hello", "keys:enter"], "typed, then submitted");
});

test("a pane in a mode is refused in the name of the backend that refused it", async () => {
  // The sentence is read by someone who has to go and leave that mode. It said "tmux"
  // literally while tmux was the only backend with the concept; a second multiplexer
  // would have sent them looking for a tmux they are not running.
  const { pane, did } = fakePane({ label: "cmux", mode: async () => "copy-mode" });
  const r = await sendText(noHandles(), "hello", true, depsFor(pane));

  assert.equal(r.ok, false);
  assert.equal(r.paneBlocked, true, "transient, and a caller rationing attempts must not spend one");
  assert.match(r.error ?? "", /cmux copy-mode/);
  assert.deepEqual(did, [], "nothing was written into a mode that would have eaten it");
});

// ---- through the real adapters ----

/** The real adapter for whichever backend holds the session, on a recording subprocess. */
function recorded(): { deps: InjectDeps & PaneDeps; argv: string[] } {
  const argv: string[] = [];
  return {
    argv,
    deps: {
      pane: (session) =>
        bindSession(session, async (bin, args) => {
          argv.push([bin, ...args].join(" "));
          return stubRun({ stdout: "", stderr: "", code: 0 });
        }),
      capture: async () => "",
      sleep: async () => {},
    },
  };
}

test("a nested session is typed into at its innermost pane, never at the tab showing it", async () => {
  // The composition rule, from the caller's end. The agent sits on the tmux pane; the
  // wezterm handle addresses the client displaying it, so typing there types at whatever
  // that client happens to be showing - another session, if the human switched windows.
  const { deps, argv } = recorded();
  const r = await injectPrompt(nestedSession(), "a\nb", deps);

  assert.equal(r.ok, true);
  assert.ok(argv.length > 0, "something was written");
  assert.ok(
    argv.every((a) => !a.includes("send-text")),
    `the emulator was written to: ${argv.join(" | ")}`,
  );
  assert.ok(argv.some((a) => a.includes("paste-buffer")), "the multiplexer took the paste");
});

test("a prompt past tmux's command limit still reaches the composer", async () => {
  // The bug, from the end a dispatch experiences it. `injectPrompt` is what hands a task's
  // intent to its freshly launched agent, and for a prompt of any size it used to hand the
  // whole thing to `tmux set-buffer -b <buf> -- <text>`. tmux caps total command length far
  // below the OS's argv ceiling - measured against 3.6b, 16,000 bytes accepted, 20,000
  // refused with `command too long`, exit 1 - so a task whose intent was a phase document
  // provisioned its worktree, launched its agent, and then died at delivery with an empty
  // composer and no way forward but Focus or Cancel.
  //
  // Driven through the REAL adapters on a recording subprocess, so what is asserted is the
  // argv the daemon would actually have spawned. Both backends are checked because both had
  // the defect, differing only in where the ceiling sits.
  const prompt = `## Phase 1\n\n${"Implement the thing. ".repeat(3000)}`;
  assert.ok(prompt.length > 20_000, "the payload must be past the limit this is about");

  for (const [name, session] of [
    ["tmux", tmuxSession()],
    ["wezterm", weztermSession()],
  ] as const) {
    const spawned: { argv: string[]; input?: string }[] = [];
    const deps: InjectDeps & PaneDeps = {
      pane: (s) =>
        bindSession(s, async (bin, args, opts) => {
          spawned.push({ argv: [bin, ...args], input: opts?.input });
          return stubRun({ stdout: "", stderr: "", code: 0 });
        }),
      capture: async () => "",
      sleep: async () => {},
    };

    const r = await injectPrompt(session, prompt, deps);
    assert.equal(r.ok, true, `${name}: the prompt must deliver`);
    assert.equal(r.pasted, true, `${name}: and land in the composer`);

    // The whole point: the payload travelled, and it travelled on stdin.
    assert.ok(
      spawned.some((c) => c.input === prompt),
      `${name}: the prompt was never piped to anything`,
    );
    for (const call of spawned) {
      for (const arg of call.argv) {
        assert.ok(
          !arg.includes("Implement the thing."),
          `${name}: the prompt was passed as an argument, which is what tmux refuses`,
        );
      }
    }
  }
});

test("a backend with no mode concept is never probed for one", async () => {
  // A probe that always answers "not in a mode" and a backend that has no such state are
  // the same behaviour and different claims - and the first costs a subprocess per write.
  const { deps, argv } = recorded();
  const r = await injectPrompt(weztermSession(), "a\nb", deps);

  assert.equal(r.ok, true);
  assert.ok(
    argv.every((a) => !a.includes("display-message")),
    `wezterm was asked about a mode it has no concept of: ${argv.join(" | ")}`,
  );
});

test("a paste that DIED rather than answering is not offered back for a retry", async () => {
  // `TerminalResult.outcomeUnknown`, deciding something. A `paste-buffer` that was killed
  // may have reached the pane first, and a caller told `pasted: false` re-delivers - which
  // expands the collapsed placeholder and appends a second copy of the prompt. Erring
  // toward "it may have landed" costs a re-send by hand; erring the other way corrupts a
  // prompt that was already delivered.
  const killed = (bin: string, args: string[]): RunResult =>
    args.includes("paste-buffer")
      ? { stdout: "", stderr: "", code: null, outcomeUnknown: true, overflowed: false }
      : stubRun({ stdout: "", stderr: "", code: 0 });
  const deps: InjectDeps = {
    pane: (session) => bindSession(session, async (bin, args) => killed(bin, args)),
    capture: async () => null,
    sleep: async () => {},
  };

  const r = await injectPrompt(tmuxSession(), "a\nb", deps);
  assert.equal(r.ok, false, "we did not see it land, so this is not a success");
  assert.equal(r.pasted, true, "and it must not be re-pasted on top of");
  assert.equal(r.submitVerified, false);
});

test("a paste that REPORTED failure stays retryable", async () => {
  // The other side of that line, and the reason the flag exists rather than a blanket
  // "assume it landed": tmux resolves the buffer and the pane before writing, so a
  // non-zero exit means the text never reached the composer and re-delivery is safe.
  const deps: InjectDeps = {
    pane: (session) =>
      bindSession(session, async (_bin, args) =>
        stubRun({ stdout: "", stderr: "no such pane", code: args.includes("paste-buffer") ? 1 : 0 }),
      ),
    capture: async () => null,
    sleep: async () => {},
  };

  const r = await injectPrompt(tmuxSession(), "a\nb", deps);
  assert.equal(r.ok, false);
  assert.equal(r.pasted, false);
});

// ---- reading a pane we cannot see ----

test("a pane nobody can read is no evidence, and never a blank screen", async () => {
  // Three different situations answer null here - no pane, a backend that cannot
  // screen-scrape, a read that failed - and every caller treats null as "no news":
  // `annotatePaneState` rides the last dialog forward, `awaitPasteSubmitted` refuses to
  // read it as a cleared composer. An empty string would tell all of them the opposite,
  // in the affirmative.
  assert.equal(await capturePaneText({ terminals: [] }), null);
});
