// What the fake shaper's helper processes carry in their argv, shared with the tests that clean
// them up. Kept apart from fake-shaper.mjs, which runs as soon as it is imported.

/** Names a process as a fake-shaper helper; its pid file follows it in the argv. */
export const HELPER_MARKER = "shaping-fixture-helper";
