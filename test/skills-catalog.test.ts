import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { frontmatterBlock, parseFrontmatter, parseSkill, readCatalog } from "../src/server/skills/catalog.ts";

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

  const mcp = readFileSync(new URL("../src/mcp/server.ts", import.meta.url), "utf8");
  const start = mcp.indexOf('"create_task"');
  const end = mcp.indexOf("// This is the replacement", start);
  assert.ok(start >= 0 && end > start, "create_task should be registered before request_input");
  const tool = mcp.slice(start, end);
  assert.match(tool, /dependsOnCurrentSession/);
  assert.match(tool, /http\("\/mcp\/tasks"/);
  assert.doesNotMatch(tool, /\n\s*agent:/, "omission preserves the dispatch default agent");
  assert.doesNotMatch(tool, /\n\s*effort:/, "omission preserves the harness default effort");
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
  assert.match(text, /PR's goal/i);
  assert.match(text, /design decisions/i);
  assert.match(text, /proof of work/i);
  assert.match(text, /screenshots/i);
});
