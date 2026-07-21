import { test } from "node:test";
import assert from "node:assert/strict";

import { stubRun, type RunResult } from "../src/server/util/exec.ts";
import { binEnv } from "../src/server/terminal/bin.ts";
import {
  CMUX_BIN,
  cmuxMultiplexer,
  parseCwds,
  parseTree,
  windowRefs,
} from "../src/server/terminal/cmux.ts";
import { bindPane, MULTIPLEXERS } from "../src/server/terminal/registry.ts";
import { ALL_KEYS } from "../src/server/terminal/types.ts";
import { correlate } from "../src/server/discovery/correlate.ts";
import { muxHandle, paneToken } from "../src/shared/pane.ts";
import {
  CMUX_TREE,
  CMUX_WORKSPACES_WINDOW_1,
  CMUX_WORKSPACES_WINDOW_2,
} from "./fixtures/cmux-panes.ts";

// What is at stake: cmux is the phase 5 acceptance test for `Multiplexer`, so this file is
// half an adapter test and half a test of the interface's claim to be about CAPABILITIES
// rather than about tmux's CLI.
//
// The cases that matter are the ones where cmux does NOT behave like tmux, because those are
// the ones a shared implementation would have got wrong:
//
//   - a session's NAME is not its ADDRESS here, and using one for the other either titles
//     every card with a UUID or makes `kill` ambiguous between two workspaces called `~`.
//   - literal text cannot go through `cmux send`, which rewrites `\n` into Enter. A reply
//     containing `printf("\n")` submits itself halfway through.
//   - cmux mis-attributes ttys in a multi-surface workspace, and the tty is the only join
//     between a process and a pane. Passing one on binds a card to the wrong pane.
//
// Driven against a fake exec and verbatim captures, for the reason `terminal-adapters.test.ts`
// gives: the interesting property of an adapter is the argv it emits, and shelling out to a
// real cmux asserts that only on the machines that happen to have one - which for a macOS-only
// GUI app is no CI runner at all.

interface Call {
  bin: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

function recorder(results: RunResult[] = []) {
  const calls: Call[] = [];
  let n = 0;
  const exec = async (
    bin: string,
    args: string[],
    opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv },
  ): Promise<RunResult> => {
    calls.push({ bin, args, env: opts?.env });
    return results[n++] ?? stubRun({ stdout: "", stderr: "", code: 0 });
  };
  return { calls, exec };
}

const TARGET = {
  session: "D0D87E8D-6410-4155-8305-81A4F1306A67",
  windowIndex: 0,
  paneId: "7B318DE7-CC2F-4606-89C0-7AFF10F2904E",
};

/** The params of the `cmux rpc <method> <json>` call at `i`. */
function rpcParams(calls: Call[], i = 0): { method: string; params: Record<string, unknown> } {
  const args = calls[i]!.args;
  assert.equal(args[0], "rpc", "expected an rpc call");
  return { method: args[1]!, params: JSON.parse(args[2]!) as Record<string, unknown> };
}

test("cmux is registered and complete", () => {
  // The `Record<MultiplexerId, Multiplexer>` is what makes this true at compile time; the
  // assertion is that the id in `@shared/terminal.ts` reached an adapter and not a stub.
  const cmux = MULTIPLEXERS.cmux;
  assert.equal(cmux.id, "cmux");
  assert.equal(cmux.label, "cmux");
  assert.ok(cmux.sessions, "cmux has named workspaces, so it has a session lifecycle");
});

test("a session's name is not its address", () => {
  const panes = parseTree(CMUX_TREE, new Map());
  const probe = panes.find((p) => p.sessionName === "mc-probe");
  assert.ok(probe, "the captured tree holds a workspace titled mc-probe");

  // The two fields exist because these two values differ. `session` addresses - it is the
  // UUID every command below is aimed at - and `sessionName` is what a card is titled.
  // Before the split, `correlate` read the address and would have titled this card
  // "D0D87E8D-6410-...".
  assert.match(probe.session, /^[0-9A-F]{8}-[0-9A-F]{4}-/);
  assert.notEqual(probe.session, probe.sessionName);

  // And the reason the address cannot simply BE the title: cmux titles are the shell's, so
  // this capture holds two workspaces sharing one. `kill(sessionName)` would be a coin flip
  // between them; `kill(session)` cannot be.
  const titles = panes.map((p) => p.sessionName);
  const duplicated = titles.filter((t, i) => titles.indexOf(t) !== i);
  assert.ok(duplicated.length > 0, "the capture really does contain a duplicated title");
  assert.equal(new Set(panes.map((p) => p.paneId)).size, panes.length, "addresses are unique");
});

test("a tty is reported only where cmux attributes it correctly", () => {
  const panes = parseTree(CMUX_TREE, new Map());

  // The regression this exists for. In `mc-tty2` cmux reports `ttys032` for a process that
  // `ps` puts on `ttys031`, and null for the surface that owns `ttys032` - verified live,
  // from a clean state, before and after one `new-split`. Handing that on does not merely
  // lose a card, it binds a card to a pane the agent is not in, and the next prompt is typed
  // into someone else's shell.
  const broken = panes.filter((p) => p.sessionName === "mc-tty2");
  assert.equal(broken.length, 2, "both surfaces are still enumerated");
  for (const p of broken) assert.equal(p.tty, null, "neither surface offers a tty to join on");
  assert.ok(
    CMUX_TREE.includes("ttys032"),
    "the fixture really does carry the mis-attributed tty - this test is worthless without it",
  );

  // A workspace with one terminal surface has no second tty to be displaced by, and those
  // are reported normally. This is the common case and the one `spawnDetached` creates.
  const single = panes.filter((p) => p.tty);
  assert.ok(single.length >= 3, "single-surface workspaces still report their ttys");
  for (const p of single) assert.match(p.tty!, /^ttys\d+$/, "and already `/dev/`-stripped");
});

test("browser surfaces are not panes", () => {
  const panes = parseTree(CMUX_TREE, new Map());
  // A cmux workspace can hold a browser beside its terminals. It has a url where a terminal
  // has a tty, and nothing in this product can type into one.
  assert.ok(CMUX_TREE.includes('"browser"'), "the capture contains a browser surface");
  assert.ok(
    panes.every((p) => p.paneId),
    "every pane that survived is addressable",
  );
  const probeSurfaces = panes.filter((p) => p.sessionName === "mc-probe");
  assert.equal(probeSurfaces.length, 2, "the browser surface is dropped, the two terminals stay");
});

test("cwd is joined from the per-window sweep, which is why there is one per window", () => {
  // `tree --all` is the only command that spans windows and it carries no directory;
  // `workspace list` carries one and answers for a single window. With this capture's two
  // windows, either list alone leaves most workspaces without a cwd.
  const refs = windowRefs(CMUX_TREE);
  assert.deepEqual(refs.sort(), ["window:1", "window:2"]);

  const one = parseCwds(CMUX_WORKSPACES_WINDOW_1);
  const two = parseCwds(CMUX_WORKSPACES_WINDOW_2);
  const merged = new Map([...one, ...two]);
  assert.ok(one.size > 0 && two.size > 0);
  assert.ok(merged.size > one.size, "the second window really does add workspaces");

  const panes = parseTree(CMUX_TREE, merged);
  assert.ok(
    panes.some((p) => p.cwd?.startsWith("/")),
    "a plain path, never a URL",
  );
  // Every pane whose workspace was in either sweep gets that workspace's directory - a
  // per-workspace opening directory rather than tmux's live `pane_current_path`, which is
  // why `correlate` prefers the agent process's own cwd and takes this only as a fallback.
  const probe = panes.filter((p) => p.sessionName === "mc-probe");
  assert.equal(new Set(probe.map((p) => p.cwd)).size, 1, "one directory for the whole workspace");
});

test("literal text does not go through the CLI's escape scanner", async () => {
  const rec = recorder();
  // The defect this guards: `cmux send` replaces the two-character sequences \n, \r and \t
  // wherever they appear, \n and \r with a CR - which in an agent composer is Enter. There
  // is no escape (\\n does not collapse), so a reply carrying a Windows path loses
  // characters and one carrying printf("\n") submits itself halfway through.
  const body = 'printf("\\n") and C:\\temp\\new';
  await cmuxMultiplexer(rec.exec).write.text(TARGET, body);

  const { method, params } = rpcParams(rec.calls);
  assert.equal(method, "surface.send_text");
  assert.equal(params.text, body, "the text reaches the socket byte for byte");
  assert.equal(params.surface_id, TARGET.paneId);
  assert.ok(
    !rec.calls.some((c) => c.args[0] === "send"),
    "and never through the subcommand that would rewrite it",
  );
});

test("the socket is addressed by surface_id, the one param name that targets", async () => {
  // cmux does not reject an unrecognized param, it falls back to the caller's default
  // target: `{"surface": <id>}` reports success having typed into a different pane
  // entirely. Verified against 0.64.20 by checking which surface came back, not that the
  // call exited 0. Pinning the spelling is the only thing standing between a rename and a
  // prompt delivered somewhere nobody is looking.
  const rec = recorder();
  const cmux = cmuxMultiplexer(rec.exec);
  await cmux.write.text(TARGET, "x");
  await cmux.write.keys(TARGET, ["enter"]);
  await cmux.write.paste!(TARGET, "x");
  for (const [i] of rec.calls.entries()) {
    assert.equal(rpcParams(rec.calls, i).params.surface_id, TARGET.paneId);
  }
});

test("every key renders into cmux's own convention", async () => {
  for (const key of ALL_KEYS) {
    const rec = recorder();
    await cmuxMultiplexer(rec.exec).write.keys(TARGET, [key]);
    const { method, params } = rpcParams(rec.calls);
    assert.equal(method, "surface.send_key");
    // cmux's key names happen to agree with this interface's vocabulary, which is why the
    // `Record<Key, string>` is written out rather than passed through: the agreement is a
    // coincidence of two vocabularies and not a promise. tmux's own spelling of the odd one
    // out, `btab`, is an `Unknown key` error on this backend.
    assert.equal(typeof params.key, "string");
    assert.ok((params.key as string).length > 0, `${key} must render to something`);
  }
  const rec = recorder();
  await cmuxMultiplexer(rec.exec).write.keys(TARGET, ["shift-tab"]);
  assert.equal(rpcParams(rec.calls).params.key, "shift-tab");
});

test("keys are sent in order, and a refusal stops the rest", async () => {
  const rec = recorder([
    stubRun({ stdout: "", stderr: "", code: 0 }),
    stubRun({ stdout: "", stderr: "no such surface", code: 1 }),
  ]);
  const res = await cmuxMultiplexer(rec.exec).write.keys(TARGET, ["down", "down", "enter"]);
  assert.equal(res.ok, false);
  // The only reason to send two keys is that their order is the point - an arrow walk to a
  // menu row, then Enter. Sending the Enter after the walk failed presses whatever the menu
  // was already sitting on.
  assert.equal(rec.calls.length, 2, "the third key is not sent after the second is refused");
  assert.deepEqual(
    rec.calls.map((c) => rpcParams([c]).params.key),
    ["down", "down"],
  );
});

test("paste is bracketed, and does not submit", async () => {
  const rec = recorder();
  await cmuxMultiplexer(rec.exec).write.paste!(TARGET, "line one\nline two");
  const { method, params } = rpcParams(rec.calls);
  assert.equal(method, "surface.send_text");
  // cmux has no paste verb that leaves a composer unsubmitted: `terminal.paste` answers
  // {"submitted": true} and delivers a trailing CR. The markers are written here instead,
  // which is what makes a multi-line prompt arrive as one block rather than as two
  // submissions.
  assert.equal(params.text, "\x1b[200~line one\nline two\x1b[201~");
  assert.equal(rec.calls.length, 1, "one call, so there is no half-pasted state to recover");
});

test("the inherited default-target ids are dropped from every command", async () => {
  const rec = recorder();
  const cmux = cmuxMultiplexer(rec.exec);
  await cmux.list();
  await cmux.write.text(TARGET, "x");
  await cmux.capture!(TARGET);
  await cmux.select!(TARGET);

  assert.ok(rec.calls.length >= 4);
  for (const call of rec.calls) {
    // A daemon started from inside a cmux terminal inherits these, and they are not a socket
    // pin like TMUX - they are a default TARGET. An untargeted command lands in whichever
    // workspace the daemon happened to be launched in; verified, the same `cmux send` hit
    // workspace:1 bare and workspace:2 with the variable set.
    for (const key of CMUX_BIN.dropEnv) {
      assert.equal(call.env?.[key], undefined, `${key} must not reach ${call.args[0]}`);
    }
    // And the notices go to stdout in front of the JSON, so a warned-about command name is
    // otherwise a tick in which every card on the machine disappears.
    assert.equal(call.env?.CMUX_QUIET, "1");
  }
  assert.deepEqual(
    CMUX_BIN.dropEnv.filter((k) => k in binEnv(CMUX_BIN, { CMUX_WORKSPACE_ID: "x" })),
    [],
  );
});

test("enumeration spans every cmux window", async () => {
  const rec = recorder([
    stubRun({ stdout: CMUX_TREE, stderr: "", code: 0 }),
    stubRun({ stdout: CMUX_WORKSPACES_WINDOW_1, stderr: "", code: 0 }),
    stubRun({ stdout: CMUX_WORKSPACES_WINDOW_2, stderr: "", code: 0 }),
  ]);
  const panes = await cmuxMultiplexer(rec.exec).list();

  // `--all`, not the default. `cmux tree` without it answers for one window, and so does
  // `workspace list` - the RPC spelling of the same mistake (`all` where the method wants
  // `all_windows`) silently enumerated one window of two while writing this.
  assert.deepEqual(rec.calls[0]!.args, ["tree", "--all", "--json", "--id-format", "both"]);
  assert.equal(rec.calls.length, 3, "one tree, then one directory sweep per window");
  assert.ok(rec.calls[1]!.args.includes("--window"));
  assert.ok(panes.some((p) => p.sessionName === "~") && panes.some((p) => p.sessionName === "0"));
  assert.ok(panes.length > 4);
});

test("an absent or unreachable cmux enumerates to nothing rather than throwing", async () => {
  // The socket only exists while the app runs, and cmux ships refusing outside processes
  // (`socketControlMode: cmuxOnly`) - so "not running", "not permitted" and "not installed"
  // are all ordinary states for someone who simply does not use cmux, and discovery must
  // degrade silently through every one of them.
  const rec = recorder([stubRun({ stdout: "", stderr: "Socket not found", code: 1 })]);
  assert.deepEqual(await cmuxMultiplexer(rec.exec).list(), []);
  assert.equal(rec.calls.length, 1, "and does not go on to sweep directories it cannot have");

  // Garbage on stdout is the same answer, not a crash: this runs inside a `Promise.all` over
  // every backend, and one adapter throwing takes the whole sweep down.
  assert.deepEqual(parseTree("not json at all", new Map()), []);
  assert.deepEqual(windowRefs(""), []);
});

test("cmux declares the capabilities it lacks rather than stubbing them", () => {
  const cmux = MULTIPLEXERS.cmux;

  // `cmux copy-mode` answers "copy-mode is not supported yet in cmux CLI parity mode", so
  // there is no input mode a pane can sit in swallowing what this adapter writes. Null
  // CAPABILITY - the same claim wezterm's makes - and NOT the null ANSWER that means "asked,
  // and in no mode". `BoundPane.mode` is what keeps those apart.
  assert.equal(cmux.paneMode, null);

  // Nothing attaches to a cmux workspace over a tty: cmux draws it. So there is no client to
  // join against an emulator's tabs, and no argv that would attach one. `attachArgv` was
  // REQUIRED until this adapter - the interface had encoded "a multiplexer session is
  // invisible until something attaches to it", which is a fact about tmux.
  assert.equal(cmux.clients, null);
  assert.equal(cmux.sessions!.attachArgv, null);

  // And the ones it does have, which is what makes the nulls above declarations rather than
  // an adapter that was never finished.
  assert.ok(cmux.capture && cmux.select && cmux.write.paste);
  assert.ok(cmux.sessions!.names, "and it has rules about names, rather than no rule");
});

test("cmux name rules are cmux's, not tmux's", () => {
  const validate = MULTIPLEXERS.cmux.sessions!.names.validate;

  // Everything tmux must refuse is legal here, and that is the difference between the two
  // target grammars rather than laxness. `.` and `:` are separators in `session:window.pane`
  // and a leading `$` is tmux's session-ID sigil, so tmux has to refuse them or `-t`
  // resolves somewhere else entirely. A cmux workspace is addressed by UUID, so a title is
  // only ever a title. All verified accepted by a live cmux, and read back unchanged.
  for (const name of ["a.b", "a:b", "$0", "-wip", "workspace:1", "0", "with space", "emoji-✓"]) {
    assert.equal(validate(name), null, `cmux accepts ${name}`);
  }

  // The one thing it does refuse, and it refuses it itself: `rename-workspace requires a
  // title`.
  assert.ok(validate("")?.includes("blank"));
  assert.ok(validate("   ")?.includes("blank"));
});

test("spawnDetached runs the agent, unfocused, and does not split", async () => {
  const rec = recorder();
  await cmuxMultiplexer(rec.exec).sessions!.spawnDetached({
    name: "api-worktree",
    cwd: "/repo",
    argv: ["claude", "--model", "opus"],
    sidePane: true,
  });

  // The CLI, against the preference everywhere else in this file: `workspace.create`
  // silently ignores both `name` and `command` (the workspace comes back titled "Terminal"
  // with nothing running), and a socket method that drops params is worse than a flag that
  // errors.
  assert.deepEqual(rec.calls[0]!.args, [
    "new-workspace",
    "--name",
    "api-worktree",
    "--cwd",
    "/repo",
    "--command",
    "claude --model opus",
    "--focus",
    "false",
  ]);

  // `sidePane` is asked for and deliberately not delivered. cmux can split, but a second
  // terminal surface is exactly what triggers the tty mis-attribution above - so the
  // convenience pane would cost the session its card. The contract already says a backend
  // that cannot deliver it still reports the session it created as a success.
  assert.equal(rec.calls.length, 1, "no split is attempted");
});

test("rename and kill address the workspace, not its title", async () => {
  const rec = recorder();
  const sessions = cmuxMultiplexer(rec.exec).sessions!;
  await sessions.rename(TARGET.session, "renamed");
  await sessions.kill!(TARGET.session);

  assert.deepEqual(rec.calls[0]!.args, [
    "rename-workspace",
    "--workspace",
    TARGET.session,
    "renamed",
  ]);
  // Kill is the destructive one, and the whole reason `session` is a UUID: two cmux
  // workspaces sitting at `~` share a title, and closing "one of them" is not a thing this
  // may do.
  assert.deepEqual(rec.calls[1]!.args, ["close-workspace", "--workspace", TARGET.session]);
});

test("select walks in, and raises nothing", async () => {
  const rec = recorder();
  await cmuxMultiplexer(rec.exec).select!(TARGET);
  assert.deepEqual(rec.calls[0]!.args, ["select-workspace", "--workspace", TARGET.session]);
  assert.deepEqual(rec.calls[1]!.args, ["focus-panel", "--panel", TARGET.paneId]);
  // Deliberately not `focus-window`, and not activating the app. cmux CAN raise its own
  // window, which no multiplexer this interface was built for could, and expressing that
  // needs a capability the interface does not have. It arrives with the focus/spawn/kill
  // migration item rather than as a slot nobody has designed - see the plan.
  assert.ok(!rec.calls.some((c) => c.args[0] === "focus-window"));
});

test("a failed select does not go on to focus a surface inside it", async () => {
  const rec = recorder([stubRun({ stdout: "", stderr: "no such workspace", code: 1 })]);
  const res = await cmuxMultiplexer(rec.exec).select!(TARGET);
  assert.equal(res.ok, false);
  assert.equal(res.error, "no such workspace");
  assert.equal(rec.calls.length, 1);
});

test("a cmux pane correlates into a handle and binds like any other", async () => {
  // The end of the acceptance claim, and only true since the `Session` handle list landed:
  // an enumerated cmux pane is carried all the way to a driveable `BoundPane` without one
  // line of it naming a vendor. `handleOf` reads `backend` off the candidate, `innermostPane`
  // ranks by axis, and `bindPane` resolves the adapter from the registry.
  const pane = parseTree(CMUX_TREE, new Map()).find((p) => p.tty)!;
  const [session] = correlate({
    procs: [
      {
        pid: 900,
        ppid: 50,
        tty: pane.tty,
        startRaw: "",
        startMs: 1000,
        command: "claude",
        agent: "claude",
        agentNative: true,
      },
    ],
    terminals: [{ kind: "multiplexer", backend: "cmux", panes: [pane] }],
  });
  assert.equal(session?.nameSource, "cmux", "cmux named it, and `NameSource` admits the id");
  assert.equal(session?.name, pane.sessionName, "by its TITLE, not by the UUID it addresses");

  const handle = muxHandle(session!);
  assert.equal(handle?.backend, "cmux");
  assert.equal(handle?.session, pane.session, "and the handle keeps the address");

  const rec = recorder();
  const bound = bindPane(session!.terminals, rec.exec)!;
  assert.equal(bound.kind, "multiplexer");
  assert.equal(bound.token, paneToken(session!), "the write lock guards the pane writes land on");
  // The capability nulls survive the round trip, which is the point of carrying them: a
  // caller holding this cannot ask which vendor it got, only what it can do.
  assert.equal(bound.mode, null, "no copy-mode probe, because cmux has no such state");
  assert.ok(bound.write && bound.capture);
  await bound.write.text("hello");
  assert.equal(rpcParams(rec.calls).params.surface_id, pane.paneId);
});

test("a write that died rather than answering reports its outcome as unknown", async () => {
  // The reason `TerminalResult.outcomeUnknown` is required: a paste that was KILLED may be
  // sitting in the composer, and `injectPrompt` re-pastes only on positive evidence of
  // non-delivery. Reporting a timeout as a clean failure is how a prompt gets pasted twice.
  // Built by hand rather than through `stubRun`, which pins `outcomeUnknown: false` - the
  // very field under test.
  const rec = recorder([
    { stdout: "", stderr: "", code: 1, outcomeUnknown: true, overflowed: false },
  ]);
  const res = await cmuxMultiplexer(rec.exec).write.paste!(TARGET, "body");
  assert.equal(res.ok, false);
  assert.equal(res.outcomeUnknown, true);
  assert.equal(res.error, "cmux bracketed paste failed", "and a silent failure still says why");
});
