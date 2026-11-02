import assert from "node:assert/strict";
import test from "node:test";
import { showStartupFailure } from "../src/web/lib/startup-failure.ts";

// Only the DOM operations the diagnostic needs. No browser renderer or HTML parser required.
class ElementStub {
  textContent = "";
  attributes = new Map<string, string>();
  children: ElementStub[] = [];
  ownerDocument = { createElement: () => new ElementStub() };
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  append(...children: ElementStub[]) { this.children.push(...children); }
  replaceChildren(...children: ElementStub[]) { this.children = children; }
}

for (const phase of ["load", "render"] as const) {
  test(`${phase} failure replaces stale UI with an accessible, bounded diagnostic`, () => {
    const root = new ElementStub();
    root.append(new ElementStub(), new ElementStub());
    showStartupFailure(root as unknown as HTMLElement, phase);
    assert.equal(root.children.length, 1);
    const panel = root.children[0]!;
    assert.equal(panel.attributes.get("role"), "alert");
    assert.equal(panel.children[0]!.textContent, "Mission Control could not start");
    assert.match(panel.children[1]!.textContent, phase === "load" ? /load or initialize/ : /rendering error/);
    assert.match(panel.children[2]!.textContent, /Console and Network/);
    assert.match(panel.children[2]!.textContent, /http:\/\/localhost:<local-port>\//);
    showStartupFailure(root as unknown as HTMLElement, phase);
    assert.equal(root.children.length, 1, "repeated errors do not accumulate panels");
  });
}
