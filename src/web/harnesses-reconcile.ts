import type { HarnessesConfig, HarnessesConfigPatch } from "@shared/protocol.ts";

// The two decisions `useHarnesses` makes about the harnesses config, extracted so they can
// be tested without rendering a hook: how a patch merges over what the panel is showing,
// and whether a read that has just landed is still allowed to be applied.
//
// Both exist because the panel is optimistic. It shows an edit before the daemon has
// confirmed it, so it needs the daemon's merge rule to show the right thing, and it needs an
// ordering rule to stop a read that predates the edit from putting the old value back.

/**
 * Merge a patch over the config the panel is showing, the way the daemon merges it.
 *
 * Mirrors `setHarnessesConfig`: the per-agent maps merge rather than being replaced, so
 * changing the Claude row cannot blank the Codex one the operator never touched. Scalar
 * keys (`autoModeOnDispatch`) take the shallow spread.
 *
 * Kept as one function rather than spelled out at the call site because it is a COPY of a
 * server rule - if the daemon's merge changes, this is the single place that has to follow.
 */
export function mergeHarnessesPatch(
  before: HarnessesConfig,
  patch: HarnessesConfigPatch,
): HarnessesConfig {
  // No `?? {}` on the inner spreads: spreading `undefined` adds nothing, so an omitted key
  // already means "leave that map alone" - which is the behaviour this needs.
  return {
    ...before,
    ...patch,
    defaultModel: { ...before.defaultModel, ...patch.defaultModel },
    defaultEffort: { ...before.defaultEffort, ...patch.defaultEffort },
    sessionRuntime: { ...before.sessionRuntime, ...patch.sessionRuntime },
  };
}

/**
 * Whether a config read that left while the panel was at edit `seqAtRequest` may still be
 * applied, given the panel has since reached `seqNow`.
 *
 * This is the fix for a panel that appeared to ignore a saved change. `useHarnesses` polls
 * every few seconds AND re-reads after each write, and every response used to be written
 * into state unconditionally. A poll that left BEFORE an edit carries the pre-edit config,
 * so when it landed after that edit it put the old value back - the dropdown snapped to
 * what the operator had just changed away from and stayed there until the next tick, while
 * the daemon held the new value the whole time.
 *
 * An edit counter is enough because reads are only ever discarded, never reordered: any
 * edit at all invalidates an older read, since the read cannot contain it. It deliberately
 * does NOT compare bodies - two edits can produce the same config, and "the value happens
 * to match" is not the same fact as "this read is current".
 */
export function readIsCurrent(seqAtRequest: number, seqNow: number): boolean {
  return seqAtRequest === seqNow;
}
