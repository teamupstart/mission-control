import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WORKFLOW_LIMITS, normalizePersonaName } from "../src/shared/workflow.ts";
import { readPersonaImport } from "../src/web/workflows/PersonaLibrary.tsx";
import { deriveImportedPersonaName } from "../src/web/workflows/personaApi.ts";

// What is at stake: the README advertises these four files as one-click imports, but the
// import contract lives in browser code and nothing else holds it against a file on disk. A
// seed that loses its H1, grows past the guidance cap, or collides on the durable name
// spelling still looks fine in the repository and only misbehaves the first time an operator
// clicks Import .md - importing under a filename, being refused, or landing as mojibake. The
// em dash check is the house rule, applied where it is most visible: these texts are shipped
// to operators verbatim and become the guidance every Persona review is prompted with.

const SEEDS = [
  { file: "intent-conformance-judge.md", name: "Intent Conformance Judge" },
  { file: "code-risk-reviewer.md", name: "Code Risk Reviewer" },
  { file: "test-evidence-auditor.md", name: "Test Evidence Auditor" },
  { file: "documentation-steward.md", name: "Documentation Steward" },
] as const;

// Escaped, not literal: the house rule bans the character from this repository's own text.
const EM_DASH = String.fromCharCode(0x2014);

function seedText(file: string): string {
  const bytes = readFileSync(fileURLToPath(new URL(`../docs/personas/${file}`, import.meta.url)));
  // Fatal decoding is the actual UTF-8 assertion. readFileSync("utf8") substitutes U+FFFD for
  // invalid bytes, so a corrupt seed would import as mojibake instead of failing here.
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

for (const seed of SEEDS) {
  test(`seed persona ${seed.file} imports as ${seed.name}`, async () => {
    const text = seedText(seed.file);
    assert.ok(text.trim().length > 0, "seed persona is empty");

    const imported = await readPersonaImport({
      size: Buffer.byteLength(text, "utf8"),
      text: async () => text,
    });
    assert.equal(imported, text, "import stores the whole file body unchanged");

    const name = deriveImportedPersonaName(seed.file, imported);
    assert.equal(name, seed.name, "the H1 is the imported Persona name");
    assert.ok(name.length > 0 && name.length <= WORKFLOW_LIMITS.personaName, "name fits the limit");
  });
}

test("seed personas claim four distinct durable names", () => {
  const normalized = SEEDS.map((seed) =>
    normalizePersonaName(deriveImportedPersonaName(seed.file, seedText(seed.file)))
  );
  // Two seeds normalizing alike would reserve one name, so importing the set would stop
  // partway through with a conflict rather than give the operator all four roles.
  assert.equal(new Set(normalized).size, SEEDS.length);
});

test("seed personas carry no em dash", () => {
  for (const seed of SEEDS) {
    assert.ok(!seedText(seed.file).includes(EM_DASH), `${seed.file} contains an em dash`);
  }
});
