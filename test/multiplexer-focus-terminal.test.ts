import { test } from "node:test";
import assert from "node:assert/strict";

// No `HARNESS_HOME` preamble. This file writes real `app_config` rows through
// `terminals-config.ts`, and the worker's own disposable state dir - seeded by the
// `test/setup-state.mjs` preload the documented command carries - is exactly the home those
// rows belong in. Setting one here would freeze a second path against the one already
// resolved and be refused.
import { focus } from "../src/server/actions.ts";
import {
  configuredTerminalDeps,
  configuredTerminalTargetDeps,
  focusEmulatorFor,
  getTerminalsConfig,
  resolveFocusEmulator,
  setTerminalsConfig,
} from "../src/server/terminals-config.ts";
import {
  automaticFocusEmulator,
  defaultTerminalDeps,
  emulatorAttemptOrder,
} from "../src/server/terminal/registry.ts";
import { defaultTerminalTargetDeps } from "../src/server/terminal/targets.ts";
import {
  EMULATOR_IDS,
  MULTIPLEXER_IDS,
  resolveEmulatorBackend,
  type EmulatorId,
  type MultiplexerId,
} from "../src/shared/terminal.ts";
import {
  TerminalsConfigPatchSchema,
  TerminalsConfigSchema,
} from "../src/shared/protocol.ts";
import {
  SETTINGS_BACKUP_DOMAINS,
  SETTINGS_BACKUP_DOMAIN_IDS,
} from "../src/shared/settings-backup-domains.ts";
import { APP_CONFIG_ENTRIES } from "../src/shared/app-config-entries.ts";
import {
  launchTerminal,
  terminalTargetViews,
  type TerminalTargetDeps,
} from "../src/server/terminal/targets.ts";
import type { BinSpec, MuxSessions, TabSpec } from "../src/server/terminal/types.ts";
import {
  EMU_BIN,
  FAIL,
  MUX_BIN,
  OK,
  fakeEmulator,
  fakeMultiplexer,
  fakeTerminals,
} from "./helpers/terminal-fakes.ts";
import { mkMuxHandle, mkSession } from "./helpers/session-fixture.ts";

const PANE = mkMuxHandle({ session: "work", windowName: "0", paneId: "%3" });
const onMux = { terminals: [PANE] };

/** A backend nothing on this machine provides, named by identity like `MUX_BIN`. */
const ABSENT_BIN: BinSpec = { env: null, candidates: ["absent-mux"], dropEnv: [] };

/** The named-session half a focus fallback needs. */
function sessions(over: Partial<MuxSessions> = {}): MuxSessions {
  return {
    spawnDetached: async () => OK,
    attachArgv: (name) => ["fake-mux", "attach", "-t", name],
    rename: async () => OK,
    kill: async () => OK,
    names: { validate: () => null, sanitize: (t) => t },
    ...over,
  };
}

/** A multiplexer whose sessions are detached and which hosts no client of its own. */
function detachedMux(id: MultiplexerId = "tmux", label = "tmux") {
  return fakeMultiplexer({ id, label, sessions: sessions(), clients: async () => [], select: async () => OK });
}

/** An emulator that records every tab it was asked to open. */
function spawningEmu(id: EmulatorId, label: string, result = { ...OK, target: null }) {
  const opened: TabSpec[] = [];
  const backend = fakeEmulator({
    id,
    label,
    spawn: {
      tab: async (spec) => {
        opened.push(spec);
        return result;
      },
    },
  });
  return { opened, backend };
}

test("the emulator-only resolver admits terminal apps and refuses the other axis", () => {
  assert.deepEqual(resolveEmulatorBackend(null), { backend: null, unknown: null });
  assert.deepEqual(resolveEmulatorBackend(undefined), { backend: null, unknown: null });
  assert.deepEqual(resolveEmulatorBackend("ghostty"), { backend: "ghostty", unknown: null });
  for (const id of MULTIPLEXER_IDS) {
    assert.deepEqual(
      resolveEmulatorBackend(id),
      { backend: null, unknown: id },
      `${id} is not an answer to "what terminal app opens this session"`,
    );
  }
  assert.deepEqual(resolveEmulatorBackend("kitty"), { backend: null, unknown: "kitty" });
});

test("the stored preference defaults to Automatic for every multiplexer, exhaustively", () => {
  const parsed = TerminalsConfigSchema.parse({});
  assert.deepEqual(
    Object.keys(parsed.multiplexerTerminal).sort(),
    [...MULTIPLEXER_IDS].sort(),
    "a multiplexer with no key here would be a backend with no preference and no control",
  );
  assert.ok(Object.values(parsed.multiplexerTerminal).every((value) => value === null));
});

test("a stored id this build does not offer PARSES, and then resolves to Automatic", () => {
  const parsed = TerminalsConfigSchema.parse({ multiplexerTerminal: { tmux: "kitty" } });
  assert.equal(parsed.multiplexerTerminal.tmux, "kitty");
  assert.deepEqual(resolveEmulatorBackend(parsed.multiplexerTerminal.tmux), {
    backend: null,
    unknown: "kitty",
  });
  assert.equal(
    TerminalsConfigPatchSchema.safeParse({ multiplexerTerminal: { tmux: "kitty" } }).success,
    false,
  );
  // Including via the other axis, which is the value most likely to be sent by mistake.
  assert.equal(
    TerminalsConfigPatchSchema.safeParse({ multiplexerTerminal: { tmux: "cmux" } }).success,
    false,
  );
  assert.equal(
    TerminalsConfigPatchSchema.safeParse({ multiplexerTerminal: { tmux: "ghostty" } }).success,
    true,
  );
});

test("an empty patch is refused rather than written as a no-op, at both levels", () => {
  assert.equal(TerminalsConfigPatchSchema.safeParse({}).success, false);
  // An outer key count reads this as one key, so only an inner refusal catches it.
  assert.equal(
    TerminalsConfigPatchSchema.safeParse({ multiplexerTerminal: {} }).success,
    false,
  );
  // Neither refusal may swallow a real one-key edit, including one that clears to Automatic.
  assert.equal(
    TerminalsConfigPatchSchema.safeParse({ multiplexerTerminal: { tmux: null } }).success,
    true,
  );
});

test("a patch for one multiplexer leaves its siblings exactly as they were", () => {
  setTerminalsConfig({ multiplexerTerminal: { tmux: "ghostty", herdr: "iterm" } });
  const after = setTerminalsConfig({ multiplexerTerminal: { tmux: "wezterm" } });

  assert.equal(after.multiplexerTerminal.tmux, "wezterm");
  assert.equal(after.multiplexerTerminal.herdr, "iterm");
  assert.deepEqual(getTerminalsConfig(), after);

  assert.deepEqual(resolveFocusEmulator("tmux"), { backend: "wezterm", unknown: null });
  assert.deepEqual(resolveFocusEmulator("cmux"), { backend: null, unknown: null });

  const cleared = setTerminalsConfig({ multiplexerTerminal: { tmux: null } });
  assert.equal(cleared.multiplexerTerminal.tmux, null);
  assert.equal(cleared.multiplexerTerminal.herdr, "iterm");
});

/** The domain list as it stood before this change, pinned the way the `app_config` keys are. */
const DOMAINS_BEFORE = [
  "ui",
  "harnesses",
  "worktrees",
  "skills",
  "cost",
  "foreman",
  "foreman-instructions",
  "workflow-policy",
  "task-sources",
  "models",
  "standing-instructions",
  "inspector",
  "shipping",
  "pipelines",
  "repo-index",
  "away",
  "personas",
  "session-actions",
  "workflow-commands",
  "workflow-definitions",
  "workflow-versions",
] as const;

test("the terminals backup domain is appended, and every id that existed stays where it was", () => {
  assert.deepEqual(
    SETTINGS_BACKUP_DOMAIN_IDS.filter((id) => id !== "terminals"),
    [...DOMAINS_BEFORE],
    "removing the new id must reproduce the previous list exactly, in order",
  );
  // The append point the one precedent used (`repo-index`): end of the settings group, which
  // keeps the surfaces contiguous.
  const settings = SETTINGS_BACKUP_DOMAINS.filter((domain) => domain.surface === "settings");
  assert.equal(settings.at(-1)?.id, "terminals");
  assert.equal(SETTINGS_BACKUP_DOMAIN_IDS.filter((id) => id === "terminals").length, 1);
  assert.equal(APP_CONFIG_ENTRIES.terminals.backupDomain, "terminals");
  assert.deepEqual(APP_CONFIG_ENTRIES.terminals.classification, {
    kind: "fields",
    fields: { multiplexerTerminal: "setting" },
  });
});

test("the stored preference is bound to the mechanism by the DAEMON, not by the registry", () => {
  setTerminalsConfig({ multiplexerTerminal: { tmux: "ghostty" } });

  assert.equal(configuredTerminalDeps.focusEmulator("tmux"), "ghostty");
  assert.equal(configuredTerminalTargetDeps.focusEmulator("tmux"), "ghostty");

  // Identity, because an object that stopped binding the reader answers null and is
  // indistinguishable from an operator who set no preference.
  assert.equal(configuredTerminalDeps.focusEmulator, focusEmulatorFor);
  assert.equal(configuredTerminalTargetDeps.focusEmulator, focusEmulatorFor);

  // Called before the identity checks below, because `assert/strict`'s `equal` is an
  // assertion signature: it narrows the property to the nullary arrow and the call after it
  // stops typechecking.
  assert.equal(defaultTerminalDeps.focusEmulator("tmux"), null);
  assert.equal(defaultTerminalTargetDeps.focusEmulator("tmux"), null);
  assert.equal(defaultTerminalDeps.focusEmulator, automaticFocusEmulator);
  assert.equal(defaultTerminalTargetDeps.focusEmulator, automaticFocusEmulator);
});

function targetDeps(over: Partial<TerminalTargetDeps> = {}): TerminalTargetDeps {
  return {
    multiplexers: {},
    emulators: {},
    installed: () => true,
    launchId: () => "abc123",
    focusEmulator: () => null,
    ...over,
  };
}

test("needsTerminalApp is read off the adapter's attachArgv on every multiplexer row", () => {
  const views = terminalTargetViews(targetDeps({
    multiplexers: {
      // Detached sessions, installed: needs one.
      tmux: detachedMux(),
      // Detached sessions and NOT installed: still needs one, so its row keeps a control.
      herdr: fakeMultiplexer({ id: "herdr", label: "Herdr", bin: ABSENT_BIN, sessions: sessions() }),
      // Draws its own window: needs none. Derived from `attachArgv: null`, never from "cmux".
      cmux: fakeMultiplexer({ id: "cmux", label: "cmux", sessions: sessions({ attachArgv: null }) }),
    },
    emulators: { wezterm: spawningEmu("wezterm", "WezTerm").backend },
    installed: (spec: BinSpec) => spec !== ABSENT_BIN,
  }));

  const by = (id: string) => views.find((view) => view.id === id);
  assert.equal(by("tmux")?.needsTerminalApp, true);
  assert.equal(by("herdr")?.needsTerminalApp, true);
  assert.ok(by("herdr")?.unavailable, "the Herdr row is still a gap, and still carries the field");
  assert.equal(by("cmux")?.needsTerminalApp, false);
  const attachOnly = terminalTargetViews(targetDeps({
    multiplexers: { tmux: fakeMultiplexer({ sessions: null }) },
  }));
  assert.equal(attachOnly.find((view) => view.id === "tmux")?.needsTerminalApp, false);
  assert.equal(by("wezterm")?.needsTerminalApp, undefined);
});

test("one order serves both walks: the choice first, then the registry, never twice", () => {
  const preference: Record<string, EmulatorId | null> = { tmux: "iterm", herdr: null };
  const deps = { focusEmulator: (id: MultiplexerId) => preference[id] ?? null };

  assert.deepEqual(emulatorAttemptOrder("tmux", deps), ["iterm", "wezterm", "ghostty"]);
  assert.deepEqual(emulatorAttemptOrder("herdr", deps), [...EMULATOR_IDS]);
  // No multiplexer in hand at all - the shape focus's own `Multiplexer | null` can present.
  assert.deepEqual(emulatorAttemptOrder(null, deps), [...EMULATOR_IDS]);

  // Every order is a PERMUTATION of the registry: nothing dropped, nothing repeated. A
  // `[preferred, ...EMULATOR_IDS]` that forgot to filter would spawn into the chosen terminal
  // twice when it failed, which is the case `EMULATOR_IDS[0]` makes reachable.
  for (const id of EMULATOR_IDS) {
    const order = emulatorAttemptOrder("tmux", { focusEmulator: () => id });
    assert.equal(order[0], id);
    assert.deepEqual([...order].sort(), [...EMULATOR_IDS].sort());
  }
});

test("the raiser named in the blurb is this multiplexer's chosen terminal", () => {
  const deps = targetDeps({
    multiplexers: { tmux: detachedMux(), herdr: detachedMux("herdr", "Herdr") },
    emulators: {
      wezterm: spawningEmu("wezterm", "WezTerm").backend,
      ghostty: spawningEmu("ghostty", "Ghostty").backend,
      iterm: spawningEmu("iterm", "iTerm2").backend,
    },
    // Two multiplexers, two different answers.
    focusEmulator: (id) => (id === "tmux" ? "ghostty" : "iterm"),
  });
  const views = terminalTargetViews(deps);

  assert.equal(views.find((view) => view.id === "tmux")?.blurb, "New session, raised in Ghostty.");
  assert.equal(views.find((view) => view.id === "herdr")?.blurb, "New session, raised in iTerm2.");
});

test("Automatic, an absent choice and an unusable one all fall back to registry order", () => {
  const base = {
    multiplexers: { tmux: detachedMux() },
    emulators: {
      wezterm: spawningEmu("wezterm", "WezTerm").backend,
      ghostty: spawningEmu("ghostty", "Ghostty").backend,
      // Registered and unable to open a window from outside - not a candidate either way.
      iterm: fakeEmulator({ id: "iterm", label: "iTerm2", spawn: null }),
    },
  };
  const blurb = (deps: TerminalTargetDeps): string | undefined =>
    terminalTargetViews(deps).find((view) => view.id === "tmux")?.blurb;

  assert.equal(blurb(targetDeps(base)), "New session, raised in WezTerm.");
  // Chosen and not installed, with nothing else installed either: the row refuses rather
  // than naming a terminal, which is the sentence it has always refused with.
  const bare = terminalTargetViews(targetDeps({
    ...base,
    focusEmulator: () => "ghostty",
    installed: (spec: BinSpec) => spec !== EMU_BIN,
  })).find((view) => view.id === "tmux");
  assert.equal(bare?.blurb, "");
  assert.equal(
    bare?.unavailable,
    "tmux sessions open detached - install a terminal that can show one",
  );
  assert.equal(blurb(targetDeps({ ...base, focusEmulator: () => "iterm" })), "New session, raised in WezTerm.");
});

test("an explicit launch tries every candidate before it tears the session down", async () => {
  // `raiser` answers "which one CAN open a window"; this walk needs "which one DID". A
  // chosen terminal that is installed and refuses must not take the detached session with
  // it while another installed terminal could have shown it.
  const killed: string[] = [];
  const wezterm = spawningEmu("wezterm", "WezTerm");
  const ghostty = spawningEmu("ghostty", "Ghostty", { ...FAIL("no window server"), target: null });
  const deps = targetDeps({
    multiplexers: {
      tmux: fakeMultiplexer({
        sessions: sessions({ kill: async (name: string) => { killed.push(name); return OK; } }),
      }),
    },
    emulators: { wezterm: wezterm.backend, ghostty: ghostty.backend },
    focusEmulator: () => "ghostty",
  });

  const launched = await launchTerminal("tmux", { name: "api", cwd: "/w/api", argv: ["zsh"] }, deps);

  assert.equal(launched.ok, true);
  assert.equal(ghostty.opened.length, 1, "the choice is attempted first");
  assert.equal(wezterm.opened.length, 1, "then the registry order resumes");
  assert.deepEqual(killed, [], "and the session it created is still standing");
});

test("an explicit launch cleans up only once every candidate has definitively refused", async () => {
  const killed: string[] = [];
  const wezterm = spawningEmu("wezterm", "WezTerm", { ...FAIL("no window server"), target: null });
  const ghostty = spawningEmu("ghostty", "Ghostty", { ...FAIL("refused"), target: null });
  const deps = targetDeps({
    multiplexers: {
      tmux: fakeMultiplexer({
        sessions: sessions({ kill: async (name: string) => { killed.push(name); return OK; } }),
      }),
    },
    emulators: { wezterm: wezterm.backend, ghostty: ghostty.backend },
  });

  const launched = await launchTerminal("tmux", { name: "api", cwd: "/w/api", argv: ["zsh"] }, deps);

  assert.equal(launched.ok, false);
  assert.equal(launched.status, 502);
  assert.equal(wezterm.opened.length, 1);
  assert.equal(ghostty.opened.length, 1);
  assert.equal(killed.length, 1, "the session that can never be seen is torn down");
});

test("focus opens the terminal this multiplexer was set to, not the registry's first", async () => {
  const wezterm = spawningEmu("wezterm", "WezTerm");
  const ghostty = spawningEmu("ghostty", "Ghostty");
  const deps = {
    ...fakeTerminals(detachedMux(), wezterm.backend, undefined, ghostty.backend),
    focusEmulator: () => "ghostty" as const,
  };

  assert.deepEqual(await focus(mkSession(onMux), deps), { ok: true });
  assert.deepEqual(wezterm.opened, [], "the registry's first emulator is not even tried");
  assert.deepEqual(ghostty.opened.map((spec) => spec.argv), [["fake-mux", "attach", "-t", "work"]]);
});

test("each multiplexer's own preference is read, at focus time, for the session in hand", async () => {
  const wezterm = spawningEmu("wezterm", "WezTerm");
  const ghostty = spawningEmu("ghostty", "Ghostty");
  const iterm = spawningEmu("iterm", "iTerm2");
  const asked: MultiplexerId[] = [];
  const preference: Record<string, EmulatorId> = { tmux: "ghostty", herdr: "iterm" };
  const deps = {
    ...fakeTerminals(detachedMux(), wezterm.backend, undefined, ghostty.backend, iterm.backend),
    focusEmulator: (id: MultiplexerId) => {
      asked.push(id);
      return preference[id] ?? null;
    },
  };
  deps.multiplexers.herdr = detachedMux("herdr", "Herdr");

  await focus(mkSession({ terminals: [mkMuxHandle({ session: "work" })] }), deps);
  await focus(
    mkSession({ terminals: [mkMuxHandle({ backend: "herdr", session: "work" })] }),
    deps,
  );

  assert.deepEqual(asked, ["tmux", "herdr"], "asked per focus, never captured at dispatch");
  assert.equal(ghostty.opened.length, 1);
  assert.equal(iterm.opened.length, 1);
  assert.deepEqual(wezterm.opened, []);

  // The same deps object, mutated between focuses.
  preference.tmux = "wezterm";
  await focus(mkSession(onMux), deps);
  assert.equal(wezterm.opened.length, 1);
});

test("a terminal whose binary is absent is never spawned, and step 5's refusal stands", async () => {
  const wezterm = spawningEmu("wezterm", "WezTerm");
  const ghostty = spawningEmu("ghostty", "Ghostty");
  const iterm = spawningEmu("iterm", "iTerm2");
  const deps = {
    ...fakeTerminals(detachedMux(), wezterm.backend, undefined, ghostty.backend, iterm.backend),
    // Only the multiplexer's own binary resolves, so no terminal app is present.
    installed: (spec: BinSpec) => spec === MUX_BIN,
  };

  const result = await focus(mkSession(onMux), deps);

  assert.deepEqual(wezterm.opened, []);
  assert.deepEqual(ghostty.opened, []);
  assert.deepEqual(iterm.opened, []);
  assert.equal(result.ok, false);
  // Byte-identical to the sentence this walk has always ended on.
  assert.equal(result.error, "no terminal tab hosts this tmux session and none could be opened");
});

test("a preferred terminal that is present and fails anyway falls through to the next", async () => {
  const wezterm = spawningEmu("wezterm", "WezTerm");
  const ghostty = spawningEmu("ghostty", "Ghostty", { ...FAIL("no window server"), target: null });
  const iterm = spawningEmu("iterm", "iTerm2");
  const deps = {
    ...fakeTerminals(detachedMux(), wezterm.backend, undefined, ghostty.backend, iterm.backend),
    focusEmulator: () => "ghostty" as const,
  };

  assert.deepEqual(await focus(mkSession(onMux), deps), { ok: true });
  assert.equal(ghostty.opened.length, 1, "the choice is attempted first");
  assert.equal(wezterm.opened.length, 1, "then the registry order resumes from its start");
  assert.deepEqual(iterm.opened, []);
});

test("the chosen terminal is never attempted twice", async () => {
  // `wezterm` is both the preference and the registry's first entry. A naive
  // `[preferred, ...EMULATOR_IDS]` would spawn into it, fail, and spawn into it again.
  const wezterm = spawningEmu("wezterm", "WezTerm", { ...FAIL("nope"), target: null });
  const ghostty = spawningEmu("ghostty", "Ghostty");
  const deps = {
    ...fakeTerminals(detachedMux(), wezterm.backend, undefined, ghostty.backend),
    focusEmulator: () => "wezterm" as const,
  };

  assert.deepEqual(await focus(mkSession(onMux), deps), { ok: true });
  assert.equal(wezterm.opened.length, 1);
  assert.equal(ghostty.opened.length, 1);
  assert.equal(EMULATOR_IDS[0], "wezterm", "which is what made this case reachable");
});
