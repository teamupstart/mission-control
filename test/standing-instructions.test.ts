import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Repository standing instructions, phase 1: the store, the matching rule, and the block
// that gets composed out of them.
//
// The single most important case in this file is the byte-identical one. The whole feature
// ships INERT - the stored default is empty and resolution returns nothing for every
// repository - so a checkout with no standing instructions has to produce exactly the prompt
// it produced before this existed. Everything else here is about the two ways this feature
// can lie: reporting that nothing applies when a block will in fact be sent, and reinstating
// a machine-wide default over a repository whose box the operator deliberately cleared.

const home = mkdtempSync(join(tmpdir(), "mission-standing-instructions-"));
process.env.HARNESS_HOME = home;

const {
  resolveStandingInstructions,
  STANDING_INSTRUCTIONS_MAX_LENGTH,
  STANDING_INSTRUCTIONS_MAX_REPOSITORIES,
} = await import("../src/shared/standing-instructions.ts");
const { StandingInstructionsConfigSchema, StandingInstructionsUpdateSchema } = await import(
  "../src/shared/protocol.ts"
);
const { standingInstructionsChannel } = await import("../src/shared/harness-capabilities.ts");
const {
  openDb,
  insertStandingInstructions,
  getStandingInstructions,
  pruneStandingInstructions,
} = await import("../src/server/db.ts");
const { standingInstructionsView, updateStandingInstructions } = await import(
  "../src/server/instructions/config.ts"
);
const {
  composeStandingInstructions,
  withStandingInstructions,
  STANDING_INSTRUCTIONS_HEADING,
  STANDING_INSTRUCTIONS_MULTI_HEADING,
} = await import("../src/server/instructions/compose.ts");
const { intentWithRepoManifest } = await import("../src/server/dispatcher.ts");
const { mkTask } = await import("./helpers/session-fixture.ts");

after(() => rmSync(home, { recursive: true, force: true }));

beforeEach(() => {
  const d = openDb();
  d.exec("DELETE FROM app_config");
  d.exec("DELETE FROM session_standing_instructions");
});

// ---- resolution ----

test("a repository with no standing instructions composes NOTHING, byte for byte", () => {
  // The decisive regression guard, at the level everything else is built on. An empty
  // document must not produce an empty heading, a separator, or a stray newline: each of
  // those is a byte in the prompt an agent reads that was not there yesterday.
  const empty = StandingInstructionsConfigSchema.parse({});
  const delivery = composeStandingInstructions(empty, [{ repoPath: "/ws/repo" }], "claude", "sdk");
  assert.deepEqual(delivery, { text: "", mechanism: "none", sources: [] });

  const intent = "fix the flexbox helper";
  assert.equal(withStandingInstructions(delivery.text, intent), intent);
  // And identity, not merely equality: nothing was rebuilt around the operator's words.
  assert.equal(withStandingInstructions("", intent), intent);

  // The same at the manifest seam, for a single-repo and a multi-repo task alike.
  const single = mkTask({ id: "t1", intent });
  assert.equal(intentWithRepoManifest(single, ""), intentWithRepoManifest(single));
  const multi = mkTask({
    id: "t2",
    intent,
    worktreePath: "/wt/primary",
    branch: "harness/x",
    extraRepos: [
      { repoRoot: "/ws/other", worktreePath: "/wt/other", branch: "harness/x", provider: null, worktreeLeaseId: null, baseSha: null },
    ],
  } as Parameters<typeof mkTask>[0]);
  assert.equal(intentWithRepoManifest(multi, ""), intentWithRepoManifest(multi));
});

test("the longest matching key wins, so a package rule beats its monorepo's", () => {
  const config = StandingInstructionsConfigSchema.parse({
    default: "machine default",
    repositories: {
      "/ws/mono": "monorepo rule",
      "/ws/mono/packages/api": "api rule",
    },
  });
  assert.deepEqual(resolveStandingInstructions(config, "/ws/mono/packages/api"), {
    text: "api rule",
    matchedKey: "/ws/mono/packages/api",
    source: "repository",
  });
  // A sibling package the operator said nothing about still gets the monorepo's rule.
  assert.equal(resolveStandingInstructions(config, "/ws/mono/packages/web").text, "monorepo rule");
  // And a file deeper inside the package still matches the package.
  assert.equal(
    resolveStandingInstructions(config, "/ws/mono/packages/api/src").matchedKey,
    "/ws/mono/packages/api",
  );
});

test("matching is on the path BOUNDARY, so /repo-backup never inherits /repo's rule", () => {
  const config = StandingInstructionsConfigSchema.parse({
    default: "machine default",
    repositories: { "/ws/repo": "repo rule" },
  });
  assert.equal(resolveStandingInstructions(config, "/ws/repo").text, "repo rule");
  assert.equal(resolveStandingInstructions(config, "/ws/repo/src").text, "repo rule");
  // `startsWith` alone says these match, and they are different projects.
  assert.deepEqual(resolveStandingInstructions(config, "/ws/repo-backup"), {
    text: "machine default",
    matchedKey: null,
    source: "default",
  });
  assert.equal(resolveStandingInstructions(config, "/ws/repository").source, "default");
  // A trailing slash is the same path, on either side of the comparison.
  assert.equal(resolveStandingInstructions(config, "/ws/repo/").matchedKey, "/ws/repo");
});

test("an empty override BEATS the default; an absent key inherits it", () => {
  // The distinction the whole store rests on. Collapse the two and clearing a repository's
  // box quietly reinstates the machine-wide text the operator had just decided not to send
  // there - which is the same trap `foreman/instructions.ts` documents for its stored-empty
  // case.
  const config = StandingInstructionsConfigSchema.parse({
    default: "machine default",
    repositories: { "/ws/quiet": "" },
  });
  assert.deepEqual(resolveStandingInstructions(config, "/ws/quiet"), {
    text: "",
    matchedKey: "/ws/quiet",
    source: "repository",
  });
  assert.deepEqual(resolveStandingInstructions(config, "/ws/other"), {
    text: "machine default",
    matchedKey: null,
    source: "default",
  });
  // With no default either, nothing applies anywhere and the source says so.
  const bare = StandingInstructionsConfigSchema.parse({});
  assert.deepEqual(resolveStandingInstructions(bare, "/ws/other"), {
    text: "",
    matchedKey: null,
    source: "none",
  });
  // A checkout that could not be canonicalized falls through to the default rather than
  // matching on a raw string that could belong to anyone.
  assert.equal(resolveStandingInstructions(config, null).source, "default");
});

test("the character cap and the repository cap are enforced by the schema", () => {
  const tooLong = "x".repeat(STANDING_INSTRUCTIONS_MAX_LENGTH + 1);
  assert.equal(StandingInstructionsConfigSchema.safeParse({ default: tooLong }).success, false);
  assert.equal(
    StandingInstructionsConfigSchema.safeParse({ repositories: { "/ws/a": tooLong } }).success,
    false,
  );
  assert.equal(
    StandingInstructionsConfigSchema.safeParse({ default: "x".repeat(STANDING_INSTRUCTIONS_MAX_LENGTH) })
      .success,
    true,
  );
  const many: Record<string, string> = {};
  for (let i = 0; i <= STANDING_INSTRUCTIONS_MAX_REPOSITORIES; i++) many[`/ws/r${i}`] = "x";
  assert.equal(StandingInstructionsConfigSchema.safeParse({ repositories: many }).success, false);
});

// ---- the store ----

test("the ETag changes with the document, and a stale writer performs no write", () => {
  const first = standingInstructionsView();
  assert.deepEqual({ default: first.default, repositories: first.repositories }, {
    default: "",
    repositories: {},
  });

  const written = updateStandingInstructions({
    expectedEtag: first.etag,
    default: "never force-push",
  });
  assert.equal(written.ok, true);
  assert.ok(written.ok && written.view.etag !== first.etag, "the token follows the document");

  // A second window that read the OLD view gets the current document and writes nothing.
  const stale = updateStandingInstructions({ expectedEtag: first.etag, default: "clobbered" });
  assert.equal(stale.ok, false);
  assert.equal(
    !stale.ok && "conflict" in stale && stale.conflict.default,
    "never force-push",
    "the conflict carries the CURRENT view",
  );
  assert.equal(standingInstructionsView().default, "never force-push", "and nothing was written");
});

test("a patch touches one key: a string sets, null removes, and empty is a real value", () => {
  const start = standingInstructionsView();
  const one = updateStandingInstructions({
    expectedEtag: start.etag,
    repositories: { "/ws/a": "rule a", "/ws/b": "rule b" },
  });
  assert.ok(one.ok);

  // Saving one repository does not disturb its neighbour - which is what stops a panel's
  // unsaved draft for /ws/b being persisted by a save aimed at /ws/a.
  const two = updateStandingInstructions({
    expectedEtag: one.view.etag,
    repositories: { "/ws/a": "" },
  });
  assert.ok(two.ok);
  assert.deepEqual(two.view.repositories, { "/ws/a": "", "/ws/b": "rule b" });
  // Empty round-trips as PRESENT, because it means "send nothing here".
  assert.equal("/ws/a" in standingInstructionsView().repositories, true);

  // Removal is spelled `null`, and it is the only thing that makes a key absent again.
  const three = updateStandingInstructions({
    expectedEtag: two.view.etag,
    repositories: { "/ws/a": null },
  });
  assert.ok(three.ok);
  assert.deepEqual(three.view.repositories, { "/ws/b": "rule b" });
  assert.equal("/ws/a" in three.view.repositories, false);
});

test("an update must change something, and the wire spells removal as null", () => {
  assert.equal(StandingInstructionsUpdateSchema.safeParse({ expectedEtag: "x" }).success, false);
  assert.equal(
    StandingInstructionsUpdateSchema.safeParse({ expectedEtag: "x", default: "" }).success,
    true,
  );
  assert.equal(
    StandingInstructionsUpdateSchema.safeParse({
      expectedEtag: "x",
      repositories: { "/ws/a": null },
    }).success,
    true,
  );
});

// ---- pruning ----

test("a snapshot with NO live session left is pruned, which is when it most needs to be", () => {
  // The failure this closes: after the registry has swept, an empty live-key set is a FACT -
  // every session has exited - and the neighbouring prune helpers read an empty set as
  // "liveness unknown" and delete nothing. Copying that here would make these rows unprunable
  // in exactly the state that produces the most of them, and each one is up to 8,000
  // characters of durable text.
  const row = (noteKey: string, text: string, createdAt: number) => ({
    noteKey,
    text,
    mechanism: "prompt-prefix" as const,
    sources: [],
    createdAt,
  });
  insertStandingInstructions(row("gone-1", "x", 1_000));
  insertStandingInstructions(row("gone-2", "y", 9_000));

  // Nothing is live, and the row that has not aged out yet is still not touched: liveness is
  // one guard and age is another, and only the second applies here.
  assert.equal(pruneStandingInstructions([], 5_000), 1);
  assert.equal(getStandingInstructions("gone-1"), undefined);
  assert.equal(getStandingInstructions("gone-2")?.text, "y");

  // A row whose key still belongs to a session is never touched, however old it is.
  insertStandingInstructions(row("gone-1", "x", 1_000));
  assert.equal(pruneStandingInstructions(["gone-1"], 5_000), 0);
  assert.equal(getStandingInstructions("gone-1")?.text, "x");
  assert.equal(pruneStandingInstructions([], 100_000), 2, "and both go once neither is live");
});

// ---- composition ----

test("one repository renders one headed block; several render one labelled part each", () => {
  const config = StandingInstructionsConfigSchema.parse({
    repositories: { "/ws/a": "never run E2E locally", "/ws/b": "always prove the bug first" },
  });

  const single = composeStandingInstructions(config, [{ repoPath: "/ws/a" }], "pi", "terminal");
  assert.equal(single.text, `${STANDING_INSTRUCTIONS_HEADING}\n\nnever run E2E locally`);
  assert.deepEqual(single.sources, [{ repoPath: "/ws/a", matchedKey: "/ws/a" }]);

  // Manifest order, and one part per CONTRIBUTING repository - the middle one has no rules
  // and contributes nothing at all, not an empty label.
  const many = composeStandingInstructions(
    config,
    [{ repoPath: "/ws/b" }, { repoPath: "/ws/none" }, { repoPath: "/ws/a" }],
    "pi",
    "terminal",
  );
  assert.match(many.text, /### \/ws\/b[\s\S]*### \/ws\/a/);
  assert.equal(many.text.includes("/ws/none"), false);
  assert.deepEqual(many.sources, [
    { repoPath: "/ws/b", matchedKey: "/ws/b" },
    { repoPath: "/ws/a", matchedKey: "/ws/a" },
  ]);
});

test("checkouts that resolve to the SAME text render one block, not one per checkout", () => {
  // The machine-wide default is the ordinary case: a three-repo dispatch where no repository
  // has an override resolves all three to the same words. One labelled part per checkout
  // would put that rule in front of the agent three times, which is the failure exactly-once
  // delivery exists to prevent - a prohibition repeated invites being read as emphasis about
  // something the operator said once.
  const config = StandingInstructionsConfigSchema.parse({ default: "never force-push" });
  const all = composeStandingInstructions(
    config,
    [{ repoPath: "/ws/a" }, { repoPath: "/ws/b" }, { repoPath: "/ws/c" }],
    "pi",
    "terminal",
  );
  assert.equal(all.text, `${STANDING_INSTRUCTIONS_MULTI_HEADING}\n\nnever force-push`);
  assert.equal(all.text.split("never force-push").length - 1, 1, "the rule appears ONCE");
  assert.equal(all.text.includes("###"), false, "and no label implies a distinction");
  // Provenance is still per checkout, so a marker can say which key each one inherited.
  assert.deepEqual(all.sources, [
    { repoPath: "/ws/a", matchedKey: null },
    { repoPath: "/ws/b", matchedKey: null },
    { repoPath: "/ws/c", matchedKey: null },
  ]);

  // Two different keys carrying identical words collapse too: the agent reads words, not
  // keys, so a distinction it cannot see is not one worth drawing.
  const sameWords = StandingInstructionsConfigSchema.parse({
    repositories: { "/ws/a": "never force-push", "/ws/b": "never force-push" },
  });
  const collapsed = composeStandingInstructions(
    sameWords,
    [{ repoPath: "/ws/a" }, { repoPath: "/ws/b" }],
    "pi",
    "terminal",
  );
  assert.equal(collapsed.text, `${STANDING_INSTRUCTIONS_MULTI_HEADING}\n\nnever force-push`);

  // And a group that is only PART of the set keeps its label, naming every checkout it
  // governs - grouping must not erase which prohibition belongs to which tree.
  const mixed = StandingInstructionsConfigSchema.parse({
    default: "never force-push",
    repositories: { "/ws/c": "this repo is read-only" },
  });
  const parts = composeStandingInstructions(
    mixed,
    [{ repoPath: "/ws/a" }, { repoPath: "/ws/b" }, { repoPath: "/ws/c" }],
    "pi",
    "terminal",
  );
  assert.equal(
    parts.text,
    `${STANDING_INSTRUCTIONS_MULTI_HEADING}\n\n` +
      `### /ws/a, /ws/b\n\nnever force-push\n\n` +
      `### /ws/c\n\nthis repo is read-only`,
  );
});

test("a two-repo launch where only the SECOND repository has rules still sends them", () => {
  // The lie this closes: a preview that looked only at the repository the operator picked
  // would say nothing will be sent, while the launch sends the secondary's block. A marker
  // saying "nothing" is the reason an operator stops looking.
  const config = StandingInstructionsConfigSchema.parse({
    repositories: { "/ws/secondary": "this repo is read-only" },
  });
  const delivery = composeStandingInstructions(
    config,
    [{ repoPath: "/ws/primary" }, { repoPath: "/ws/secondary" }],
    "claude",
    "terminal",
  );
  assert.match(delivery.text, /this repo is read-only/);
  assert.deepEqual(delivery.sources, [
    { repoPath: "/ws/secondary", matchedKey: "/ws/secondary" },
  ]);
});

test("the block sits BELOW the repo manifest and ABOVE the intent - all three positions", () => {
  // Asserted as the three-way order rather than as "above the intent", because "above the
  // intent" alone is also satisfied by placing it above the manifest - which inverts the
  // reason the two are next to each other, since the manifest names the checkouts these
  // rules are about.
  const task = mkTask({
    id: "order",
    intent: "THE-OPERATOR-REQUEST",
    worktreePath: "/wt/primary",
    branch: "harness/x",
    extraRepos: [
      { repoRoot: "/ws/other", worktreePath: "/wt/other", branch: "harness/x", provider: null, worktreeLeaseId: null, baseSha: null },
    ],
  } as Parameters<typeof mkTask>[0]);
  const composed = intentWithRepoManifest(task, "THE-STANDING-BLOCK");
  const manifest = composed.indexOf("## Repositories for this task");
  const block = composed.indexOf("THE-STANDING-BLOCK");
  const intent = composed.indexOf("THE-OPERATOR-REQUEST");
  assert.ok(manifest >= 0 && block >= 0 && intent >= 0, composed);
  assert.ok(manifest < block, "the manifest names the checkouts the rules are about");
  assert.ok(block < intent, "and the rules come before the request they govern");
});

// ---- the mechanism, read once, from the harness registry ----

test("every shipped harness · runtime pair declares exactly one delivery channel", () => {
  // Never derived from an agent name at a call site: two readings of "does this pair have a
  // channel" are how a pair ends up double-delivered or silently undelivered.
  assert.equal(standingInstructionsChannel("claude", "terminal"), "claude-append-system-prompt");
  assert.equal(standingInstructionsChannel("claude", "sdk"), "claude-sdk-system-prompt-append");
  assert.equal(standingInstructionsChannel("codex", "sdk"), "codex-developer-instructions");
  // The two pairs with no out-of-band channel. The composer turns this null into
  // `prompt-prefix`, which is the OTHER half of the contract rather than a degradation.
  assert.equal(standingInstructionsChannel("codex", "terminal"), null);
  assert.equal(standingInstructionsChannel("pi", "terminal"), null);

  const config = StandingInstructionsConfigSchema.parse({ default: "a rule" });
  const pairs: [Parameters<typeof standingInstructionsChannel>[0], "terminal" | "sdk", string][] = [
    ["claude", "terminal", "claude-append-system-prompt"],
    ["claude", "sdk", "claude-sdk-system-prompt-append"],
    ["codex", "sdk", "codex-developer-instructions"],
    ["codex", "terminal", "prompt-prefix"],
    ["pi", "terminal", "prompt-prefix"],
  ];
  for (const [agent, runtime, mechanism] of pairs) {
    const delivery = composeStandingInstructions(config, [{ repoPath: "/ws/x" }], agent, runtime);
    assert.equal(delivery.mechanism, mechanism, `${agent} · ${runtime}`);
    assert.match(delivery.text, /a rule/);
  }
});
