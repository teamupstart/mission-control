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
// can lie: reporting that nothing applies when a block will in fact be sent, and dropping
// the machine-wide default when a repository also has instructions.

const home = mkdtempSync(join(tmpdir(), "mission-standing-instructions-"));
process.env.HARNESS_HOME = home;

const {
  STANDING_INSTRUCTIONS_MECHANISMS,
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
    parts: [
      { source: "default", text: "machine default" },
      { source: "repository", text: "api rule" },
    ],
    matchedKey: "/ws/mono/packages/api",
    source: "repository",
  });
  // A sibling package the operator said nothing about still gets the monorepo's rule.
  assert.deepEqual(resolveStandingInstructions(config, "/ws/mono/packages/web").parts, [
    { source: "default", text: "machine default" },
    { source: "repository", text: "monorepo rule" },
  ]);
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
  for (const path of ["/ws/repo", "/ws/repo/src"]) {
    assert.deepEqual(resolveStandingInstructions(config, path).parts, [
      { source: "default", text: "machine default" },
      { source: "repository", text: "repo rule" },
    ]);
  }
  // `startsWith` alone says these match, and they are different projects.
  assert.deepEqual(resolveStandingInstructions(config, "/ws/repo-backup"), {
    parts: [{ source: "default", text: "machine default" }],
    matchedKey: null,
    source: "default",
  });
  assert.equal(resolveStandingInstructions(config, "/ws/repository").source, "default");
  // A trailing slash is the same path, on either side of the comparison.
  assert.equal(resolveStandingInstructions(config, "/ws/repo/").matchedKey, "/ws/repo");
});

test("empty and absent repository instructions both preserve the default", () => {
  const config = StandingInstructionsConfigSchema.parse({
    default: "machine default",
    repositories: { "/ws/quiet": "" },
  });
  assert.deepEqual(resolveStandingInstructions(config, "/ws/quiet"), {
    parts: [{ source: "default", text: "machine default" }],
    matchedKey: null,
    source: "default",
  });
  assert.deepEqual(resolveStandingInstructions(config, "/ws/other"), {
    parts: [{ source: "default", text: "machine default" }],
    matchedKey: null,
    source: "default",
  });
  // With no default either, nothing applies anywhere and the source says so.
  const bare = StandingInstructionsConfigSchema.parse({});
  assert.deepEqual(resolveStandingInstructions(bare, "/ws/other"), {
    parts: [],
    matchedKey: null,
    source: "none",
  });
  // A checkout that could not be canonicalized falls through to the default rather than
  // matching on a raw string that could belong to anyone.
  assert.equal(resolveStandingInstructions(config, null).source, "default");
  assert.deepEqual(resolveStandingInstructions({ default: "", repositories: { "/ws/quiet": "" } }, "/ws/quiet"), {
    parts: [], matchedKey: null, source: "none",
  });
});

test("an empty package entry selects no repository addition while retaining the default", () => {
  const config = { default: "machine rule", repositories: { "/ws/mono": "parent rule", "/ws/mono/api": "" } };
  assert.deepEqual(resolveStandingInstructions(config, "/ws/mono/api/src").parts, [
    { source: "default", text: "machine rule" },
  ]);
  delete (config.repositories as Record<string, string>)["/ws/mono/api"];
  assert.deepEqual(resolveStandingInstructions(config, "/ws/mono/api/src").parts, [
    { source: "default", text: "machine rule" },
    { source: "repository", text: "parent rule" },
  ]);
});

test("default and repository blocks keep their full per-block character allowance", () => {
  const config = StandingInstructionsConfigSchema.parse({
    default: "d".repeat(STANDING_INSTRUCTIONS_MAX_LENGTH),
    repositories: { "/ws/a": "r".repeat(STANDING_INSTRUCTIONS_MAX_LENGTH) },
  });
  const expected = `${config.default}\n\n${config.repositories["/ws/a"]}`;
  assert.deepEqual(resolveStandingInstructions(config, "/ws/a").parts, [
    { source: "default", text: config.default },
    { source: "repository", text: config.repositories["/ws/a"] },
  ]);
  assert.equal(composeStandingInstructions(config, [{ repoPath: "/ws/a" }], "claude", "sdk").text,
    `${STANDING_INSTRUCTIONS_HEADING}\n\n${expected}`);
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
  // Empty round-trips as PRESENT, selecting no repository addition.
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
  // in exactly the state that produces the most of them, and each one contains durable composed text.
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
  // has an addition resolves all three to the same words. One labelled part per checkout
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
      `never force-push\n\n` +
      `### /ws/c\n\nthis repo is read-only`,
  );
});

test("multi-repository launches send the default once before scoped, deduplicated additions", () => {
  const config = {
    default: "shared default",
    repositories: { "/ws/a": "rule A", "/ws/b": "rule B", "/ws/c": "rule A", "/ws/empty": "" },
  };
  const delivery = composeStandingInstructions(config,
    ["/ws/a", "/ws/b", "/ws/c", "/ws/empty", "/ws/absent"].map((repoPath) => ({ repoPath })),
    "codex", "terminal");
  assert.equal(delivery.text, `${STANDING_INSTRUCTIONS_MULTI_HEADING}\n\nshared default\n\n` +
    "### /ws/a, /ws/c\n\nrule A\n\n### /ws/b\n\nrule B");
  assert.deepEqual(delivery.sources, [
    { repoPath: "/ws/a", matchedKey: "/ws/a" },
    { repoPath: "/ws/b", matchedKey: "/ws/b" },
    { repoPath: "/ws/c", matchedKey: "/ws/c" },
    { repoPath: "/ws/empty", matchedKey: null },
    { repoPath: "/ws/absent", matchedKey: null },
  ]);
});

test("resolution preserves contribution boundaries and composition keeps their repository scopes", () => {
  const rule = "Keep this paragraph.\n\nKeep this one too.\n";
  const config = { default: rule, repositories: { "/ws/a": rule } };
  assert.deepEqual(resolveStandingInstructions(config, "/ws/a").parts, [
    { source: "default", text: rule },
    { source: "repository", text: rule },
  ]);
  assert.equal(
    composeStandingInstructions(config, [{ repoPath: "/ws/a" }], "claude", "sdk").text,
    `${STANDING_INSTRUCTIONS_HEADING}\n\n${rule}\n\n${rule}`,
  );
  assert.equal(
    composeStandingInstructions(config, [{ repoPath: "/ws/b" }, { repoPath: "/ws/a" }], "claude", "sdk").text,
    `${STANDING_INSTRUCTIONS_MULTI_HEADING}\n\n${rule}\n\n### /ws/a\n\n${rule}`,
  );
  assert.deepEqual(resolveStandingInstructions({ ...config, default: "" }, "/ws/a").parts, [
    { source: "repository", text: rule },
  ]);
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
  assert.equal(
    delivery.text,
    `${STANDING_INSTRUCTIONS_MULTI_HEADING}\n\n### /ws/secondary\n\nthis repo is read-only`,
  );
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
  // The pair with no out-of-band channel. The composer turns this null into
  // `prompt-prefix`, which is the OTHER half of the contract rather than a degradation.
  assert.equal(standingInstructionsChannel("codex", "terminal"), null);
  assert.equal(standingInstructionsChannel("pi", "terminal"), "pi-append-system-prompt");

  const config = StandingInstructionsConfigSchema.parse({ default: "a rule" });
  const pairs: [Parameters<typeof standingInstructionsChannel>[0], "terminal" | "sdk", string][] = [
    ["claude", "terminal", "claude-append-system-prompt"],
    ["claude", "sdk", "claude-sdk-system-prompt-append"],
    ["codex", "sdk", "codex-developer-instructions"],
    ["codex", "terminal", "prompt-prefix"],
    ["pi", "terminal", "pi-append-system-prompt"],
  ];
  for (const [agent, runtime, mechanism] of pairs) {
    const delivery = composeStandingInstructions(config, [{ repoPath: "/ws/x" }], agent, runtime);
    assert.equal(delivery.mechanism, mechanism, `${agent} · ${runtime}`);
    assert.match(delivery.text, /a rule/);
  }
});

test("standing-instruction mechanisms preserve every persisted index", () => {
  assert.deepEqual(STANDING_INSTRUCTIONS_MECHANISMS, [
    "none", "prompt-prefix", "claude-append-system-prompt",
    "claude-sdk-system-prompt-append", "codex-developer-instructions",
    "pi-append-system-prompt",
  ]);
  // Both Pi runtimes name the SAME mechanism, and that is the point rather than a
  // coincidence: `--append-system-prompt` is the CLI spelling of the resource-loader option
  // the managed driver passes directly, so one operator instruction is delivered one way
  // whichever runtime the harness toggle selects.
  assert.equal(standingInstructionsChannel("pi", "terminal"), "pi-append-system-prompt");
  assert.equal(standingInstructionsChannel("pi", "sdk"), "pi-append-system-prompt");
  // Codex terminal is now the live prover of the prompt-prefix fallback.
  assert.equal(standingInstructionsChannel("codex", "terminal"), null);
});
