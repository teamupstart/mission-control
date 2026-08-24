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
    ["library", "see-work"],
  );
  assert.deepEqual(
    readdirSync(toursDir).filter((entry) => entry.endsWith(".md")).sort(),
    ["README.md", "library.md", "see-work.md"],
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

test("malformed authored copy fails before a tour can start", () => {
  for (const [markdown, message] of [
    ["## Stage\n<!-- stage: one -->\nCopy.\n", /no H1 title/],
    ["# Tour\n", /has no stages/],
    ["# Tour\n\nUnused introduction.\n\n## Stage\n<!-- stage: one -->\nCopy.\n", /between its title and first stage/],
    ["# Tour\n\n## Stage\nCopy.\n", /needs a stage comment/],
    ["# Tour\n\n## Stage\n<!-- stage: one -->\n", /has no description/],
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
