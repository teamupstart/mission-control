// The terminal backend vocabulary: which multiplexers and emulators exist, as ids only.
//
// In `shared`, and holding nothing but ids, for the same purity reason
// `HARNESS_CAPABILITIES` is split from `HARNESSES`: `NameSource` is a `Session` field the
// dashboard renders, so "which backend named this session" is a question the BROWSER asks -
// and the browser cannot import an adapter whose `list` spawns a subprocess. The mechanism
// stays server-side in `src/server/terminal/`, which imports these ids and is enforced
// against them by `Record<MultiplexerId, Multiplexer>` / `Record<EmulatorId, TerminalEmulator>`.
//
// So: an id is added HERE and nowhere else, and it then fails to typecheck in the two
// registries until a complete adapter exists.

/**
 * Multiplexers we can drive - named persistent sessions holding panes that outlive any
 * window. (tmux, zellij, screen, cmux)
 *
 * A tuple rather than a bare union because the ORDER is load-bearing, not incidental:
 * discovery correlates backends in this order and the FIRST one holding a pane on a
 * session's tty is the one that names it (`nameSource`). With one multiplexer that is
 * unobservable; with two, moving an entry renames every session hosted by both.
 */
export const MULTIPLEXER_IDS = ["tmux"] as const;

export type MultiplexerId = (typeof MULTIPLEXER_IDS)[number];

/**
 * Terminal emulators we can drive - windows and tabs, with nothing that survives them
 * closing. (wezterm, Ghostty, iTerm2, kitty)
 *
 * Ordered like `MULTIPLEXER_IDS`, and ranked BELOW every multiplexer for naming: a tmux
 * pane lives inside a wezterm pane, so the multiplexer is the inner, more specific answer
 * to "what is this session's terminal home?". That is today's tmux-beats-wezterm precedence
 * stated once as a rule rather than open-coded as a branch.
 */
export const EMULATOR_IDS = ["wezterm"] as const;

export type EmulatorId = (typeof EMULATOR_IDS)[number];

/**
 * Any terminal backend, either axis.
 *
 * This is what opens `NameSource` up: it was the closed union `"tmux" | "wezterm" |
 * "process"`, written out in `shared/types.ts` where nothing connected it to the registries,
 * so a third backend would name sessions with a string the type did not admit and the UI
 * did not recognise.
 */
export type TerminalBackendId = MultiplexerId | EmulatorId;
