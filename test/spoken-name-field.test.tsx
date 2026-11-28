import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { SpokenNameField, spokenNameVerdict } from "../src/web/components/SpokenNameField.tsx";

// The spoken-name field's verdict is announced through a polite status region that stays mounted,
// so a screen reader hears a change of warnings while the operator types, without moving focus.

test("the verdict is the meter's: Distinctive, every warning's label, or nothing while blank", () => {
  assert.equal(spokenNameVerdict("Atlas Prime", []), "Distinctive");
  assert.equal(spokenNameVerdict("  Stevie ", [{ name: "Steve" }]), "Sounds like Steve");
  assert.equal(spokenNameVerdict("Stop", [{ name: "Stopp" }]), "Voice command, Sounds like Stopp, Everyday word, Very short");
  assert.equal(spokenNameVerdict("   ", [{ name: "Steve" }]), "");
});

test("the field carries its verdict in a polite status region, mounted even while blank", () => {
  const field = (value: string) => renderToStaticMarkup(
    <SpokenNameField label="Call sign" value={value} onChange={() => {}} roster={[{ name: "Steve" }]} placeholder="e.g. Atlas" />,
  );
  assert.match(field("Stevie"), /<span role="status" aria-live="polite" class="sr-only">Sounds like Steve<\/span>/);
  assert.match(field(""), /<span role="status" aria-live="polite" class="sr-only"><\/span>/);
});
