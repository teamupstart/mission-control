import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import { renderTourContentModule, tourContentSources } from "../scripts/tour-content.ts";
import { TOUR_CONTENT_SOURCES } from "../src/web/tour/content.generated.ts";
import {
  parseTourContent,
  tourContent,
  TourContentError,
} from "../src/web/tour/content.ts";
import { TOUR_DEFINITIONS } from "../src/web/tour/definitions.ts";
import { TOUR_ENTRIES } from "../src/web/tour/entries.ts";
import { CONDUCTOR_INTEGRATION_ENABLED } from "../src/shared/conductor-integration.ts";

const root = resolve(import.meta.dirname, "..");
const toursDir = join(root, "tours");
const generatedPath = join(root, "src", "web", "tour", "content.generated.ts");

test("the generated module is exactly what the authored tour Markdown regenerates", () => {
  assert.equal(
    readFileSync(generatedPath, "utf8"),
    renderTourContentModule(tourContentSources(toursDir)),
    "run `npm run tours` and commit the result",
  );
  assert.deepEqual(
    TOUR_CONTENT_SOURCES.map((source) => source.slug),
    ["library", "residents", "see-work", "setup", "workflows"],
  );
  assert.deepEqual(
    readdirSync(toursDir).filter((entry) => entry.endsWith(".md")).sort(),
    ["README.md", "library.md", "residents.md", "see-work.md", "setup.md", "workflows.md"],
  );
  for (const source of TOUR_CONTENT_SOURCES) {
    assert.equal(source.markdown, readFileSync(join(toursDir, `${source.slug}.md`), "utf8"));
  }
});

test("Markdown owns every tour and stage title, description, and definition list", () => {
  for (const entry of TOUR_ENTRIES) {
    const content = tourContent(entry.id);
    const definition = TOUR_DEFINITIONS[entry.id];
    assert.equal(entry.title, content.title);
    assert.equal(definition.title, content.title);
    assert.deepEqual(
      definition.steps.map((step) => ({
        id: step.id,
        title: step.title,
        description: step.description,
        details: step.details,
      })),
      definition.steps.map((step) => ({
        id: step.id,
        title: content.stages[step.id]!.title,
        description: content.stages[step.id]!.description,
        details: content.stages[step.id]!.details,
      })),
    );
    assert.deepEqual(Object.keys(content.stages), definition.steps.map((step) => step.id));
  }
});

test("the Markdown shape supports wrapped prose and a human-readable definition list", () => {
  const content = parseTourContent("example", [
    "# Example tour",
    "",
    "## A useful stage",
    "<!-- stage: useful -->",
    "",
    "A sentence that can wrap",
    "across source lines.",
    "",
    "- **First:** One definition.",
    "- **Second:** Another definition.",
    "",
  ].join("\n"));
  assert.deepEqual(content, {
    title: "Example tour",
    stages: {
      useful: {
        title: "A useful stage",
        description: "A sentence that can wrap across source lines.",
        details: [
          { label: "First", description: "One definition." },
          { label: "Second", description: "Another definition." },
        ],
      },
    },
  });
});

test("an entry that requires an integration is shown only while that integration is offered", () => {
  const markdown = [
    "# Example tour",
    "",
    "## Kinds",
    "<!-- stage: kinds -->",
    "",
    "Pick one.",
    "",
    "- **Ship:** Deliver a change.",
    "- **Pipeline:** Start an engine workflow <!-- requires: ai-conductor -->",
    "",
  ].join("\n");
  assert.deepEqual(parseTourContent("example", markdown, { "ai-conductor": false }).stages.kinds!.details, [
    { label: "Ship", description: "Deliver a change." },
  ]);
  // Offered: the entry returns with its copy intact and the marker stripped.
  assert.deepEqual(parseTourContent("example", markdown, { "ai-conductor": true }).stages.kinds!.details, [
    { label: "Ship", description: "Deliver a change." },
    { label: "Pipeline", description: "Start an engine workflow" },
  ]);
  // A requirement no build defines is an authoring mistake, not a silently hidden entry.
  assert.throws(
    () => parseTourContent("broken", markdown.replace("ai-conductor", "no-such-thing"), { "ai-conductor": true }),
    /requires unknown integration no-such-thing/,
  );
  // Including a name every object inherits: it is not a requirement this build defines.
  for (const inherited of ["constructor", "to-string"]) {
    assert.throws(
      () => parseTourContent("broken", markdown.replace("ai-conductor", inherited), { "ai-conductor": true }),
      new RegExp(`requires unknown integration ${inherited}`),
    );
  }
});

test("the shipped tour follows the Conductor switch: the Pipeline kind is authored, shown only when on", () => {
  const source = TOUR_CONTENT_SOURCES.find((entry) => entry.slug === "see-work")!;
  assert.match(source.markdown, /- \*\*Pipeline:\*\* .*<!-- requires: ai-conductor -->/, "the copy stays authored");
  const labels = (stages: ReturnType<typeof tourContent>["stages"]) =>
    stages["dispatch-kind"]!.details!.map((detail) => detail.label);
  const hidden = ["Chat", "Scout", "Plan", "Ship"];
  const offered = [...hidden, "Pipeline"];
  assert.deepEqual(labels(parseTourContent("see-work", source.markdown, { "ai-conductor": false }).stages), hidden);
  assert.deepEqual(labels(parseTourContent("see-work", source.markdown, { "ai-conductor": true }).stages), offered);
  // The tour the dashboard ships follows the constant, so flipping it is the only edit needed.
  assert.deepEqual(labels(tourContent("see-work").stages), CONDUCTOR_INTEGRATION_ENABLED ? offered : hidden);
});

test("malformed authored copy fails before a tour can start", () => {
  for (const [markdown, message] of [
    ["## Stage\n<!-- stage: one -->\nCopy.\n", /no H1 title/],
    ["# Tour\n", /has no stages/],
    ["# Tour\n\nUnused introduction.\n\n## Stage\n<!-- stage: one -->\nCopy.\n", /between its title and first stage/],
    ["# Tour\n\n## Stage\nCopy.\n", /needs a stage comment/],
    ["# Tour\n\n## Stage\n<!-- stage: one -->\n", /has no description/],
    [
      "# Tour\n\n## Stage\n<!-- stage: one -->\nCopy.\n\n- **Chat** Description.\n",
      /malformed definition list entry/,
    ],
    [
      "# Tour\n\n## Stage\n<!-- stage: one -->\nCopy.\n\n- **Chat:**\n",
      /malformed definition list entry/,
    ],
    [
      "# Tour\n\n## One\n<!-- stage: same -->\nCopy.\n\n## Two\n<!-- stage: same -->\nCopy.\n",
      /repeats stage same/,
    ],
  ] as const) {
    assert.throws(() => parseTourContent("broken", markdown), message);
  }
  assert.throws(
    () => parseTourContent(
      "broken",
      "# Tour\n\n## Stage\n<!-- stage: one -->\nCopy.\n\n- **Term:** Detail.\nMore copy.\n",
    ),
    TourContentError,
  );
});
