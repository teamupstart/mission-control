# Ghostty as a `TerminalEmulator`

Phase 5 of `docs/plans/pluggable-integrations/plan.md` - the acceptance test for the
emulator axis, not a feature. Written before implementing, the way
`codex-instrumentation.md` scoped Codex.

Everything below was measured against **Ghostty 1.3.1** (stable, macOS, arm64) on
2026-07-21, driving the live app. Nothing here is read off release notes.

## The headline: the plan's premise is wrong

`plan.md` says, in three places, that Ghostty "has no scripting CLI at all, so it can be
launched into but never enumerated or captured", and `terminal/types.ts:305-308` repeats
it. The CLI half is true. The conclusion drawn from it is false.

**Ghostty 1.3.1 ships an AppleScript dictionary.** `Contents/Resources/Ghostty.sdef`,
`NSAppleScriptEnabled = true`, `OSAScriptingDefinition = Ghostty.sdef`. It enumerates
windows, tabs and surfaces; it focuses at *surface* granularity; it spawns with a command,
a cwd and an environment; and it types. Only **capture** and **retitle** are genuinely
absent.

This is the Codex `tui` mistake in the same shape, and the plan documents that lesson
itself: a capability was declared absent, a comment asserted why, the guard guaranteed
nobody ever pointed it at a real capture, and the claim was false. The rule the plan drew
from it - *"a capability is null only after you point it at a real capture"* - is what this
spike is.

## What Ghostty actually exposes

### The CLI: nothing usable on macOS

```
$ /Applications/Ghostty.app/Contents/MacOS/ghostty +version
  app runtime : .none
$ ghostty +new-window
+new-window is not supported on this platform.
```

`--help` says it outright: *"On macOS, launching the terminal emulator from the CLI is not
supported and only actions are supported. Use `open -na Ghostty.app` instead."* The binary
in the bundle is not the GUI - it is a helper that runs `+actions` (`+list-fonts`,
`+show-config`, ...). None of them address a running window. `ghostty` is not on `PATH`;
only the bundle path exists.

So `BinSpec` still resolves a binary, and that binary answers **nothing** about the running
app. That alone is worth stating: `binPresent` is the right installed?-check, and the
resolved binary is *not* how this backend is driven.

### AppleScript: the real surface

Verbatim from the dictionary, trimmed to what matters:

| Class | Properties |
|---|---|
| `application` | `name`, `frontmost`, `front window`, `version`; elements `window`, `terminal` |
| `window` | `id` (text), `name`, `selected tab`; elements `tab`, `terminal` |
| `tab` | `id`, `name`, `index`, `selected`, `focused terminal`; elements `terminal` |
| `terminal` | `id`, `name`, `working directory` - **and nothing else** |

Commands: `perform action`, `new window`, `new tab`, `new surface configuration`, `split`,
`focus`, `close`, `activate window`, `select tab`, `close tab`, `close window`,
`input text`, `send key`, `send mouse button/position/scroll`.

`surface configuration` is a record with `font size`, `initial working directory`,
`command`, `initial input`, `wait after command`, `environment variables`.

### Measured, live

| Capability | Result |
|---|---|
| enumerate | **works** - `terminal id` is a UUID (`9F022DDA-3FD6-42AB-8388-D35E74B22ADA`), window id `tab-group-bd3a13ac0`, tab id `tab-bd55d7600` |
| write | **works, confirmed to the shell** - `input text "…" to s` then `send key "enter" to s` produced a file on disk written by the shell in that surface |
| focus | **works at surface granularity** - `activate (first window whose id is …)` and `focus (first terminal …)` both succeed |
| spawn | **works** - `new window with configuration cfg` honours `command` and `initial working directory` |
| capture | **absent.** `get properties of terminal` returns exactly `id, name, class, working directory`. No command returns screen text |
| retitle | **absent.** `name` is `access="r"` on every class |

Two grammar quirks that will bite an implementer: the sdef defines **non-standard verbs**
(`close window`, `activate window`, `select tab`) so the Standard Suite's `close` fails
with `-1708`; and `make new window` fails with `-2710` because the dictionary's own
`new window` command is what constructs one. `send key` takes key **names**, not escape
sequences - `send key "\r"` is `Unknown key name (-1700)`, `send key "enter"` works. That
is tmux's convention, not wezterm's, which is exactly why `Key` exists.

## The blocker, and it is not a missing capability

**No class exposes a tty or a pid.** `get properties of terminal` is the whole of it:
`id`, `name`, `working directory`.

`EmulatorPane.tty` is documented in `terminal/types.ts:156` as *"The join key to everything
else"*, and `discovery/correlate.ts:panesByTty` indexes enumerated panes by tty and drops
those without one. So Ghostty can fill **every** field of `EmulatorPane` except the one
that makes a pane findable.

The other side of the join does exist. A Ghostty-hosted tty is identifiable from the
process table by walking ancestry to the Ghostty pid - measured:

```
95874  ppid=51027(ghostty)  ttys026   /usr/bin/login -flp … exec -l /bin/zsh
```

So we can learn **"ttys026 is hosted by Ghostty"** and **"there is a surface
9F022DDA-…"** and we cannot learn that they are the same thing.

Routes ruled out, each tested rather than assumed:

- **Injected env var.** `surface configuration` accepts `environment variables`, so we can
  stamp a spawned surface. Unreadable: `ps -E` is SIP-restricted on this machine and
  returns no environment even for a process the user owns. `findSessionByEnv` reads env
  from a *hook payload* the agent reports about itself, not from the process table, so it
  is not a terminal-axis answer.
- **cwd join.** Both sides nominally have one. A surface spawned with a raw `command`
  reports an **empty** `working directory` (OSC 7 is emitted by shell integration, which a
  bare command bypasses) - so the join fails for precisely the surfaces we create. For
  human-opened surfaces it is a heuristic that is ambiguous whenever two tabs share a
  directory, which in this product is the common case (one worktree, an agent tab and a
  shell tab).
- **Ordering.** Enumeration order versus process start order. Nothing guarantees it.

## What this says about the interface

The interface can currently express two absences:

- `list: null` - "I cannot enumerate."
- `SpawnResult.target: null` with `ok: true` - "a tab opened and I cannot address it."

It cannot express the one that is true here: **"I enumerate real, addressable surfaces that
carry no tty, so you cannot tell which of them your process is in."** Declaring `list: null`
would record a false *reason* for a true *outcome*, which is the exact failure mode this
plan keeps naming - `HARNESSES.codex.transcript.messages` is `null` rather than `[]`
because an empty answer and an unavailable one are different claims, and this is that
distinction one layer down.

Note also that `EmulatorFocus.granularity: "app"` was added to the interface *for Ghostty*
(`types.ts:275-277`), on the assumption it could only be brought forward wholesale. Ghostty
focuses a specific surface. The interface guessed low.

## Open decision

See the PR / the question raised with the operator: whether to declare `list: null` and
ship an inert adapter, or to treat the missing join key as the interface defect it is and
give correlation a second key. Nothing is implemented until that is answered.
