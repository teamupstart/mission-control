/**
 * A stand-in for the one `Element` the context-menu resolver is handed.
 *
 * This suite has no DOM - `renderToStaticMarkup` produces strings and `AGENTS.md` rules out
 * jsdom - and `src/web/lib/context-actions.ts` is a registry of `closest()` calls. So the
 * registry would be untestable without something to hand it, and it is the half most worth
 * testing: which target claims a hit, in what order, and which rows collapse.
 *
 * IT DELIBERATELY IMPLEMENTS NO SELECTOR MATCHING. `closest(selector)` is answered from a
 * table the test writes, so a case states what the browser would have said rather than
 * re-deriving it from a hand-rolled CSS engine that could be wrong in the same direction as
 * the code under test. What that still pins is everything the registry actually decides: the
 * tier-1 order, which target wins when several could claim one hit, what each target reads off
 * its element, and the dedupe. It also pins the selector STRINGS - a target that changes its
 * selector stops being answered and its test goes red.
 *
 * What it cannot pin is whether those selectors match the app's real markup. That is the
 * browser's job, and `e2e/specs/context-menu.spec.ts` is where it is checked, against the
 * built dashboard.
 */

export interface ElementStubSpec {
  /** Upper-case, as the DOM reports it. */
  tagName?: string;
  attributes?: Record<string, string>;
  text?: string;
  /** Field state. Only read when the element is a `textarea` or an `input`. */
  value?: string;
  selectionStart?: number | null;
  selectionEnd?: number | null;
  readOnly?: boolean;
  disabled?: boolean;
}

export class ElementStub {
  readonly tagName: string;
  readonly textContent: string | null;
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  readOnly: boolean;
  disabled: boolean;
  private readonly attributes: Record<string, string>;
  private readonly ancestors = new Map<string, ElementStub>();

  constructor(spec: ElementStubSpec = {}) {
    this.tagName = spec.tagName ?? "DIV";
    this.textContent = spec.text ?? null;
    this.attributes = spec.attributes ?? {};
    this.value = spec.value ?? "";
    this.selectionStart = spec.selectionStart ?? null;
    this.selectionEnd = spec.selectionEnd ?? null;
    this.readOnly = spec.readOnly ?? false;
    this.disabled = spec.disabled ?? false;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  closest(selectors: string): ElementStub | null {
    return this.ancestors.get(selectors) ?? null;
  }

  /** `closest(selector)` finds THIS element - the hit is on the target itself. */
  claims(...selectors: string[]): this {
    for (const selector of selectors) this.ancestors.set(selector, this);
    return this;
  }

  /** `closest(selector)` finds `ancestor` - the hit is on something inside the target. */
  inside(selector: string, ancestor: ElementStub): this {
    this.ancestors.set(selector, ancestor);
    return this;
  }
}

export function elementStub(spec: ElementStubSpec = {}): ElementStub {
  return new ElementStub(spec);
}

/**
 * Hand a stub to code typed against the real DOM.
 *
 * The one cast, in one place, rather than at every call. `context-actions.ts` keeps real DOM
 * types because it is browser code and narrowing them to an invented interface would make the
 * production signature answer to the test rather than the other way round.
 */
export function asElement(stub: ElementStub): Element {
  return stub as unknown as Element;
}
