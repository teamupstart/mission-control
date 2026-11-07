import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frontmatterBlock, parseFrontmatter, parseSkill, readCatalog } from "../src/server/skills/catalog.ts";
import { artifactKind, conversationArtifacts } from "../src/web/lib/conversationArtifacts.ts";
import { listSessionFiles } from "../src/server/session-files.ts";

const skillDescription = (id: string): string =>
  readCatalog().skills.find((skill) => skill.id === id)?.description ?? "";

// The catalog reader. Its frontmatter parser is deliberately narrow - the files are
// authored in this repo and reviewed with it - so what matters is that anything it
// can't read is REPORTED rather than guessed at.

function skillMd(body: string): string {
  return `---\n${body}\n---\n\n# Heading\n\nsome prose\n`;
}

const GOOD = skillMd(
  `name: html-plans
description: Renders a plan as a page.
metadata:
  mission:
    category: planning
    enforcement: triggered`,
);

test("parses a well-formed skill", () => {
  const r = parseSkill("html-plans", GOOD);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.skill, {
    id: "html-plans",
    name: "html-plans",
    description: "Renders a plan as a page.",
    category: "planning",
    enforcement: "triggered",
  });
});

test("the directory name and the frontmatter name are independent", () => {
  // This is the whole reason our directory prefix costs nothing legible: the harness owns
  // the directory namespace in ~/.claude/skills, and the user still sees /html-plans.
  const r = parseSkill("html-plans", GOOD);
  assert.equal(r.ok && r.skill.id, "html-plans");
  assert.equal(r.ok && r.skill.name, "html-plans");
});

test("a description with a colon in it survives", () => {
  const r = parseSkill("x", skillMd(
    `name: x
description: Use when: the user asks for a page.
metadata:
  mission:
    category: c
    enforcement: triggered`,
  ));
  assert.equal(r.ok && r.skill.description, "Use when: the user asks for a page.");
});

test("a quoted scalar is unquoted", () => {
  const r = parseSkill("x", skillMd(
    `name: "x"
description: 'quoted'
metadata:
  mission:
    category: c
    enforcement: always-on`,
  ));
  assert.equal(r.ok && r.skill.name, "x");
  assert.equal(r.ok && r.skill.description, "quoted");
  assert.equal(r.ok && r.skill.enforcement, "always-on");
});

test("a missing enforcement is an error, never a default", () => {
  // Defaulting would be the worst failure this file has: the rung is what tells the
  // operator a skill is only a suggestion, so inventing one for a skill we failed to
  // read is the panel stating a guarantee nobody made.
  const r = parseSkill("x", skillMd(
    `name: x
description: d
metadata:
  mission:
    category: c`,
  ));
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.problem : "", /enforcement/);
});

test("an unknown enforcement rung is refused", () => {
  const r = parseSkill("x", skillMd(
    `name: x
description: d
metadata:
  mission:
    category: c
    enforcement: mandatory`,
  ));
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.problem : "", /unknown enforcement 'mandatory'/);
});

test("a missing name is an error - it must not default to the prefixed directory", () => {
  // Claude defaults `name` to the DIRECTORY name when it's omitted, which is exactly
  // what the prefix would poison: the user would be told to type /mission-html-plans.
  const r = parseSkill("html-plans", skillMd(`description: d\nmetadata:\n  mission:\n    category: c\n    enforcement: triggered`));
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.problem : "", /no 'name'/);
});

test("a name the native skill loaders reject is an error", () => {
  for (const name of ["Pull Request", "-pull-request", "pull--request", "pull-request-", "a".repeat(65)]) {
    const r = parseSkill("pull-request", skillMd(
      `name: ${name}
description: d
metadata:
  mission:
    category: c
    enforcement: triggered`,
    ));
    assert.equal(r.ok, false, `${name} should be refused`);
    assert.match(!r.ok ? r.problem : "", /invalid 'name'/);
  }
});

test("a missing description is an error - it's what decides if the model ever reaches for it", () => {
  const r = parseSkill("x", skillMd(`name: x\nmetadata:\n  mission:\n    category: c\n    enforcement: triggered`));
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.problem : "", /no 'description'/);
});

test("disable-model-invocation is refused - it would load but never fire", () => {
  // It takes the skill out of the "N available" count and out of the model's reach
  // entirely, so its row's toggle would do nothing an operator could ever observe.
  const r = parseSkill("x", skillMd(
    `name: x
description: d
disable-model-invocation: true
metadata:
  mission:
    category: c
    enforcement: triggered`,
  ));
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.problem : "", /never fire/);
});

test("a multi-line YAML scalar is REPORTED, not read as the literal '>-'", () => {
  // `>-` and `|` are valid YAML that Claude itself reads fine; it's this deliberately
  // narrow reader that can't. Taking the marker as the value would ship a row whose
  // description is the string ">-" - nothing looks broken, and the skill is inert,
  // because the description is what decides whether the model ever reaches for it.
  for (const marker of [">-", ">", "|", "|-"]) {
    const r = parseSkill("x", skillMd(
      `name: x
description: ${marker}
  a long description
  wrapped over lines
metadata:
  mission:
    category: c
    enforcement: triggered`,
    ));
    assert.equal(r.ok, false, `${marker} should be refused`);
    assert.match(!r.ok ? r.problem : "", /multi-line YAML scalar/);
  }
});

test("a description that merely STARTS with a > is still a description", () => {
  const r = parseSkill("x", skillMd(
    `name: x
description: "> use this when rendering"
metadata:
  mission:
    category: c
    enforcement: triggered`,
  ));
  assert.equal(r.ok && r.skill.description, "> use this when rendering");
});

test("readCatalog reports an unreadable catalog as UNREADABLE, not as empty", () => {
  // The distinction the reconciler's whole safety rests on: an empty catalog means
  // "every skill was deleted, unlink them all", and a read failure must never say that.
  const prev = process.env.FLEET_SKILLS_DIR;
  process.env.FLEET_SKILLS_DIR = "/nonexistent/skills/dir";
  try {
    const c = readCatalog();
    assert.equal(c.readable, false);
    assert.deepEqual(c.skills, []);
    assert.equal(c.present.size, 0);
    assert.match(c.problems[0] ?? "", /couldn't read the skills catalog/);
  } finally {
    if (prev === undefined) delete process.env.FLEET_SKILLS_DIR;
    else process.env.FLEET_SKILLS_DIR = prev;
  }
});

test("the real catalog is readable, and every directory in it is present", () => {
  const c = readCatalog();
  assert.equal(c.readable, true);
  // `present` is what the reconciler keys on, so a parsed skill missing from it would
  // be unlinked from every session.
  for (const s of c.skills) assert.ok(c.present.has(s.id), `${s.id} should be present`);
});

test("a file with no frontmatter is an error", () => {
  const r = parseSkill("x", "# Just a heading\n");
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.problem : "", /no --- frontmatter/);
});

test("a --- in the BODY is a horizontal rule, not a fence", () => {
  // The opening fence has to be the file's first line, or a skill whose prose uses a
  // rule would parse its own paragraphs as frontmatter.
  assert.equal(frontmatterBlock("# Title\n\n---\n\nprose\n"), null);
});

test("frontmatter is read only from the top of the file", () => {
  const block = frontmatterBlock(GOOD);
  assert.match(block ?? "", /name: html-plans/);
  assert.doesNotMatch(block ?? "", /some prose/);
});

test("comments and blank lines are ignored", () => {
  const fm = parseFrontmatter("# a comment\n\nname: x\n\n# another\ndescription: d\n");
  assert.equal(fm.get("name"), "x");
  assert.equal(fm.get("description"), "d");
});

test("nesting is scoped by indent - a sibling key doesn't fall into the block above", () => {
  const fm = parseFrontmatter("metadata:\n  mission:\n    category: c\nname: x\n");
  assert.equal(fm.get("name"), "x", "name is top-level, not inside metadata.mission");
  const meta = fm.get("metadata");
  assert.equal(meta instanceof Map, true);
});

// ---- what actually ships ----

test("every skill in the repo's catalog parses", () => {
  // The catalog is baked into the repo precisely so it's reviewable with the app. A
  // SKILL.md that doesn't parse is a row that silently vanishes from the panel.
  const catalog = readCatalog();
  assert.deepEqual(catalog.problems, []);
  assert.ok(catalog.skills.length > 0, "the catalog should not be empty");
});

test("the shipped html-plans skill is a real, loadable Claude skill", () => {
  const skill = readCatalog().skills.find((s) => s.id === "html-plans");
  assert.ok(skill, "html-plans should be in the catalog");
  assert.equal(skill.name, "html-plans");
  assert.equal(skill.enforcement, "triggered");
  // The description is what Claude preloads and what decides whether it ever reaches
  // for the skill, so an empty or stub one would make the toggle meaningless.
  assert.ok(skill.description.length > 40);
  // And it has a body: a skill whose file is only frontmatter teaches nothing.
  const text = readFileSync(new URL("../skills/html-plans/SKILL.md", import.meta.url), "utf8");
  assert.ok(text.split("---")[2]!.trim().length > 200);
  assert.match(text, /implementation-follow-up/);
  assert.match(text, /Create phased implementation plan/);
  assert.match(text, /Invoke the `phased-plan` skill/);
});

test("the shipped html-report skill names the path contract the Files tab actually honors", () => {
  const skill = readCatalog().skills.find((s) => s.id === "html-report");
  assert.ok(skill, "html-report should be in the catalog");
  assert.equal(skill.name, "html-report");
  assert.equal(skill.enforcement, "triggered");
  // The description is the whole trigger for a model-invoked skill, so it has to carry
  // the words a human uses to ask for one of these.
  assert.ok(skill.description.length > 40);
  assert.match(skill.description, /investigat/i);
  assert.match(skill.description, /scout/i);

  const text = readFileSync(new URL("../skills/html-report/SKILL.md", import.meta.url), "utf8");
  assert.ok(text.split("---")[2]!.trim().length > 200);
  // Three claims the dashboard makes true and a rewrite must not quietly drop. The path
  // shape is what `matchCheckoutPaths` links and `pathDefaultsToPreview` opens rendered;
  // the no-JavaScript rule is the preview's CSP, which allows two hashed bridges and
  // nothing else; and an href inside the report resolves against the report's directory
  // (`workspaceAssetPath`), not the checkout root.
  assert.match(text, /docs\/reports\/<slug>\/report\.html/);
  assert.match(text, /\*\*No JavaScript\.\*\*/);
  assert.match(text, /\.\.\/\.\.\/\.\.\/src\/server\/registry\.ts/);
  // And it must not teach a link form the resolver refuses.
  assert.doesNotMatch(text, /Report: \/|Report: file:/);
});

test("the shipped mockups skill teaches exactly the presentation the conversation previews", () => {
  const skill = readCatalog().skills.find((s) => s.id === "mockups");
  assert.ok(skill, "mockups should be in the catalog");
  assert.equal(skill.name, "mockups");
  assert.equal(skill.category, "design");
  assert.equal(skill.enforcement, "triggered");
  // The description is the whole trigger, so it carries each spelling people type.
  for (const phrase of [/mock-ups/, /mockups/, /mock ups/, /wireframes/]) {
    assert.match(skill.description, phrase);
  }

  const text = readFileSync(new URL("../skills/mockups/SKILL.md", import.meta.url), "utf8");
  assert.match(text, /docs\/mockups\/<slug>\//);
  assert.match(text, /git check-ignore -q/);
  assert.match(text, /\*\*No JavaScript\.\*\*/);
  assert.doesNotMatch(text, /Mockup: \/|Mockup: file:|Mockup: ~/);

  // The example block is what an agent copies, so it must be what `conversationArtifacts`
  // actually previews - not a shape that merely looks right in the skill.
  const example = text.match(/```\n(Mockup: [^\n]+\n)+```/)?.[0];
  assert.ok(example, "the skill shows its presentation lines in a fenced example");
  const lines = example.split("\n").filter((line) => line.startsWith("Mockup: "));
  const presented = lines.map((line) => line.slice("Mockup: ".length));
  assert.ok(presented.some((path) => artifactKind(path) === "html"), "an HTML example");
  assert.ok(presented.some((path) => artifactKind(path) === "image"), "an image example");
  const listing = new Set(presented);
  assert.deepEqual(
    conversationArtifacts(`Both are ready.\n${lines.join("\n")}`, listing).map(({ path }) => path),
    presented,
  );
  const [page] = presented as [string];
  const linked = text.match(/`\[Two-column layout\]\(([^)]+)\)`/)?.[1];
  assert.equal(linked, page, "the Markdown-link example names the same file");
  assert.deepEqual(
    conversationArtifacts(`- [Two-column layout](${page})`, listing).map(({ path }) => path),
    [page],
    "a Markdown link qualifies inside a list, as the skill says",
  );
  // And each form the skill says disqualifies a line really does.
  for (const line of [`Option 2: ${page}`, `- Mockup: ${page}`, `1. ${page}`, `Mockup: \`${page}\``, `Mockup: **${page}**`]) {
    assert.deepEqual(conversationArtifacts(line, listing), [], line);
  }
  assert.deepEqual(
    conversationArtifacts(`Variant B: ${page}`, listing).map(({ path }) => path),
    [page],
  );
});

test("the mockups skill's own setup command keeps mock-ups out of git and in the Files list", async () => {
  // The skill's promise is that a mock-up is never committed unless a plan needs it. Run the
  // command exactly as the skill states it, so the promise cannot drift from what git does.
  const text = readFileSync(new URL("../skills/mockups/SKILL.md", import.meta.url), "utf8");
  const setup = text.match(/```sh\n\s*(mkdir -p docs\/mockups[^\n]+)\n\s*```/)?.[1];
  assert.ok(setup, "the skill states its setup command in a fenced sh block");
  assert.match(text, /\*\*Never commit a mock-up, unless it is necessary to a plan\.\*\*/);
  assert.match(text, /beside the plan's `plan\.md` in `docs\/plans\/<name>\/`/);
  assert.match(skillDescription("mockups"), /never committed unless a plan needs it/);

  const dir = mkdtempSync(join(tmpdir(), "mission-mockups-skill-"));
  try {
    execFileSync("git", ["-C", dir, "init", "-q"]);
    execFileSync("sh", ["-c", setup], { cwd: dir });
    // Idempotent, and never overwrites a marker that is already there.
    writeFileSync(join(dir, "docs/mockups/.gitignore"), "*\n# kept\n");
    execFileSync("sh", ["-c", setup], { cwd: dir });
    assert.equal(readFileSync(join(dir, "docs/mockups/.gitignore"), "utf8"), "*\n# kept\n");

    mkdirSync(join(dir, "docs/mockups/settings-panel"), { recursive: true });
    writeFileSync(join(dir, "docs/mockups/settings-panel/two-column.html"), "<h1>Two columns</h1>\n");
    assert.equal(execFileSync("git", ["-C", dir, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" }), "");
    execFileSync("git", ["-C", dir, "add", "-A"]);
    assert.equal(execFileSync("git", ["-C", dir, "diff", "--cached", "--name-only"], { encoding: "utf8" }), "");
    assert.deepEqual(await listSessionFiles(dir), [{ path: "docs/mockups/settings-panel/two-column.html" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the mockups skill's fallback ignores a mock-up wherever git can, and says what to do where it cannot", async () => {
  // An untracked mock-up that git does NOT ignore is exactly what `git add -A` and a workflow
  // review snapshot sweep into a commit, so "leave it untracked" is no fallback. The skill's
  // own fallback must leave every writable mock-up path ignored, and send the agent to another
  // name for the one case git cannot ignore: a path the repository already tracks.
  const text = readFileSync(new URL("../skills/mockups/SKILL.md", import.meta.url), "utf8");
  const blocks = [...text.matchAll(/```sh\n\s*([^\n]+)\n\s*```/g)].map((match) => match[1]!);
  const setup = blocks.find((block) => block.startsWith("mkdir -p docs/mockups"));
  const fallback = blocks.find((block) => block.includes("--git-path info/exclude"));
  const handover = blocks.find((block) => block.startsWith("for p in docs/mockups/"));
  assert.ok(setup && fallback && handover, "the skill states its setup, fallback and hand-over commands in fenced sh blocks");
  assert.match(text, /\*\*Verify before you hand over\.\*\*/);
  // The hand-over check covers docs/mockups/ only. A mock-up a plan needs is deliberately
  // not ignored, so the skill must exempt it and say what to confirm instead, or the two
  // instructions cannot both be followed.
  assert.match(text, /check every `docs\/mockups\/` path you are about to name/);
  assert.match(text, /The one path this check does not cover is a\s+mock-up a plan needs/);
  assert.match(text, /leave it out of the hand-over check: before you\s+present it, confirm instead that it sits in the plan's own directory and that the plan links\s+it\./);
  // The hand-over check names exactly the paths the presentation example then presents.
  const presented = [...text.matchAll(/^Mockup: (\S+)$/gm)].map((match) => match[1]!);
  assert.deepEqual(handover.match(/docs\/mockups\/\S+\.(?:html|png)/g), presented);
  const handoverOutput = (dir: string): string =>
    execFileSync("sh", ["-c", handover], { cwd: dir, encoding: "utf8" });
  assert.match(text, /If it still prints `not ignored`, the repository tracks that exact file\. Choose another\s+name/);
  // Scoped to docs/mockups/, with the one exception named beside it: an unqualified "never hand
  // over an unignored mock-up" contradicts presenting a plan's committed mock-up.
  assert.match(text, /Never write or hand over a mock-up under `docs\/mockups\/` at a\s+path git does not ignore\./);
  assert.match(text, /The one mock-up that is handed over from a path git does not\s+ignore is one a plan needs/);
  assert.doesNotMatch(text, /Never write or hand over a mock-up at a path/);
  assert.match(text, /## Always: write each mock-up into the checkout, and keep it out of git unless a plan needs it/);
  assert.doesNotMatch(text, /leave it untracked/i, "an untracked, unignored mock-up is not a safe state");

  const page = "docs/mockups/settings-panel/two-column.html";
  const git = (dir: string, ...args: string[]): string =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  const ignored = (dir: string): boolean => {
    try {
      execFileSync("git", ["-C", dir, "check-ignore", "-q", page]);
      return true;
    } catch {
      return false;
    }
  };
  const repository = (marker: string, trackPage: boolean): string => {
    const dir = mkdtempSync(join(tmpdir(), "mission-mockups-fallback-"));
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "t@test");
    git(dir, "config", "user.name", "t");
    mkdirSync(join(dir, "docs/mockups/settings-panel"), { recursive: true });
    writeFileSync(join(dir, "docs/mockups/.gitignore"), marker);
    if (trackPage) {
      writeFileSync(join(dir, page), "<h1>Tracked</h1>\n");
      git(dir, "add", "-f", page);
    }
    git(dir, "add", "docs/mockups/.gitignore");
    git(dir, "commit", "-qm", "repository rules");
    execFileSync("sh", ["-c", setup], { cwd: dir });
    return dir;
  };

  for (const [name, marker] of [
    ["a repository marker with no rule", "# notes\n"],
    ["a repository marker that re-includes HTML", "!*.html\n"],
  ] as const) {
    const dir = repository(marker, false);
    try {
      assert.equal(ignored(dir), false, `${name}: the self-ignore alone does not take`);
      writeFileSync(join(dir, page), "<h1>Two columns</h1>\n");
      assert.match(handoverOutput(dir), /not ignored: docs\/mockups\/settings-panel\/two-column\.html/, `${name}: hand-over refuses it`);
      execFileSync("sh", ["-c", fallback], { cwd: dir });
      execFileSync("sh", ["-c", fallback], { cwd: dir });
      assert.equal(ignored(dir), true, `${name}: the fallback ignores it`);
      assert.equal(handoverOutput(dir), "", `${name}: hand-over passes once it is ignored`);
      assert.equal(git(dir, "status", "--porcelain", "--untracked-files=all", "--", "docs/mockups"), "", name);
      git(dir, "add", "-A");
      assert.equal(git(dir, "diff", "--cached", "--name-only"), "", `${name}: git add -A stages nothing`);
      assert.ok(
        (await listSessionFiles(dir)).some(({ path }) => path === page),
        `${name}: Files still lists the mock-up`,
      );
      const exclude = readFileSync(join(dir, git(dir, "rev-parse", "--git-path", "info/exclude").trim()), "utf8");
      assert.equal(exclude.split("\n").filter((line) => line === "docs/mockups/").length, 1, "idempotent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const tracked = repository("# notes\n", true);
  try {
    execFileSync("sh", ["-c", fallback], { cwd: tracked });
    assert.equal(ignored(tracked), false, "a tracked path cannot be ignored, which is why the skill moves to another name");
    writeFileSync(join(tracked, page), "<h1>Overwritten</h1>\n");
    assert.match(handoverOutput(tracked), /not ignored: docs\/mockups\/settings-panel\/two-column\.html/);
    assert.match(handoverOutput(tracked), / M docs\/mockups\/settings-panel\/two-column\.html/, "git status shows the commit risk too");
  } finally {
    rmSync(tracked, { recursive: true, force: true });
  }
});

test("the shipped phased-plan skill audits compatibility and schedules direct task dependencies", () => {
  const skill = readCatalog().skills.find((s) => s.id === "phased-plan");
  assert.ok(skill, "phased-plan should be in the catalog");
  assert.equal(skill.name, "phased-plan");
  assert.equal(skill.category, "planning");
  assert.equal(skill.enforcement, "triggered");
  assert.match(skill.description, /existing.*plan/i);

  const text = readFileSync(new URL("../skills/phased-plan/SKILL.md", import.meta.url), "utf8");
  assert.match(text, /Re-read the source plan/);
  assert.match(text, /Edit any earlier phase/);
  assert.match(text, /create_task/);
  assert.match(text, /dependsOnTaskIds/);
  assert.match(text, /dependsOnCurrentSession` to `true` on every call/);
  assert.match(text, /Do not flatten\s+the graph into a serial chain/);
  assert.match(text, /repository` and `additionalRepositories/);
  assert.match(text, /B as `repository`/);
  assert.match(text, /context-only/);
  assert.match(text, /canonical repository set returned by `create_task`/);
  assert.match(text, /Report the unscheduled phase/);
  assert.match(text, /Never fall back to the source repository, drop an attachment/);
  assert.doesNotMatch(text, /You cannot schedule it here/);
  assert.doesNotMatch(text, /must be dispatched from the dashboard/);

  // Small work stays one-shot even when it crosses layers. Larger work is split only when the
  // effort, complexity, and execution order make another merge unit safer for a mid-tier model.
  assert.match(text, /200 or fewer non-test implementation lines/);
  assert.match(text, /exactly one phase and\s+schedule exactly one one-shot implementation task/);
  assert.match(text, /An application-layer boundary is not by itself a phase boundary/);
  assert.match(text, /mid-tier model/);
  assert.match(text, /sizing estimate and phase-count rationale/);

  // The task text is the agent's prompt and is judged as the human's requirement, so the skill must
  // keep it at goal altitude and point at the phase file instead of pasting it in.
  assert.match(text, /Keep the task text at goal altitude/);
  assert.match(text, /proposed route, not a specification/);
  assert.doesNotMatch(text, /embed the complete phase Markdown/);
  assert.doesNotMatch(text, /Authoritative phase\s+instructions/);

  // Concision is only safe if the referenced files are published first. The skill has to close that
  // chain itself, not assume it.
  assert.match(text, /committed and pushed on this session's branch/);
  assert.match(text, /If you cannot commit and push the artifacts, do not create the tasks/);
  assert.match(text, /get_plan_publication_context/);
  assert.match(text, /owner: "workflow"/);
  assert.match(text, /report that planning is complete and end the turn/);
  assert.match(text, /Direct publication when no workflow is bound/);
  assert.match(text, /Do not treat an unknown binding as absent/);

  const mcp = readFileSync(new URL("../src/mcp/server.ts", import.meta.url), "utf8");
  const start = mcp.indexOf('"create_task"');
  const end = mcp.indexOf("// This is the replacement", start);
  assert.ok(start >= 0 && end > start, "create_task should be registered before request_input");
  const tool = mcp.slice(start, end);
  assert.match(tool, /dependsOnCurrentSession/);
  assert.match(tool, /repository:/);
  assert.match(tool, /additionalRepositories:/);
  assert.match(tool, /MAX_TASK_EXTRA_REPOS/);
  assert.match(tool, /explicitRepositories \? "\/mcp\/v2\/tasks" : "\/mcp\/tasks"/);
  assert.match(tool, /res\.status === 404/);
  assert.doesNotMatch(tool, /404[\s\S]*http\("\/mcp\/tasks"/, "selectors never retry legacy");
  assert.match(tool, /McpTaskConfigurationSchema\.shape/, "task overrides share the dashboard validators");
});

// The published task's own `intent` is verified end to end in `phased-plan-task-intent.test.ts`,
// which pushes the skill's worked example through the create_task route and checks the stored value.

test("the shipped pull-request skill is a real, triggered Mission Control skill", () => {
  const skill = readCatalog().skills.find((s) => s.id === "pull-request");
  assert.ok(skill, "pull-request should be in the catalog");
  assert.equal(skill.name, "pull-request");
  assert.equal(skill.category, "shipping");
  assert.equal(skill.enforcement, "triggered");
  assert.match(skill.description, /opening.*pull request/i);

  const text = readFileSync(new URL("../skills/pull-request/SKILL.md", import.meta.url), "utf8");

  // The description is split by audience, and each section is a literal heading rather than a
  // described convention, so the order is part of the contract: the approver's section first,
  // the implementation detail second. Asserted in sequence so dropping one is a failure even
  // though every heading below would still be found somewhere in the file.
  let at = -1;
  for (const heading of [
    "## For Humans",
    "### Evidence",
    "## For Agents",
  ]) {
    const found = text.indexOf(`\n${heading}\n`, at + 1);
    assert.ok(found > at, `the PR description contract needs '${heading}', in this order`);
    at = found;
  }

  // What each side of the split owes a reader. Human prose stays short and scannable. The agent
  // section links existing design sources instead of duplicating them, omits a test inventory,
  // and preserves deliberate failure-mode context.
  assert.match(text, /screenshots/i);
  assert.match(text, /durable/i);
  assert.match(text, /pull request description/i);
  assert.match(text, /pull request comment/i);
  assert.match(text, /never committed/i);
  assert.match(text, /gitignored/i);
  assert.match(text, /2\.100\.0/);
  for (const command of ["gh pr create", "gh pr edit", "gh pr comment"]) {
    assert.match(text, new RegExp(command));
  }
  assert.match(text, /--attach/);
  assert.match(text, /signed-in web interface/i);
  assert.match(text, /render.*attachments/is);
  assert.match(text, /secrets.*credentials.*personal data/is);
  assert.match(text, /cannot be safely redacted.*unavailable/is);
  assert.match(text, /Concision is a requirement/i);
  assert.match(text, /use bullets wherever possible/i);
  assert.match(text, /Remove filler/i);
  assert.match(text, /plan document exists.*link directly/is);
  assert.match(text, /link directly to any\s+technical documentation/i);
  assert.match(text, /Do not repeat design decisions or implementation detail/i);
  assert.match(text, /Do not list tests added or modified/i);
  assert.match(text, /Always list the failure modes and edge cases/i);
});
