import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { ARCHIVE_TEXT_LIMITS } from "@shared/archives.ts";

/**
 * Static-HTML validation and visible-text extraction for an archived report page.
 *
 * Parsed with `parse5`, a standards-compliant HTML5 parser that builds a tree and does
 * NOTHING else: it runs no script, fetches no resource, has no DOM, no layout, and no
 * network. That is the whole reason it is here rather than Electron, a headless browser, or
 * a regex. A regex over HTML would be a security boundary built on a lie - the parser is the
 * only thing that agrees with what a browser will actually see - and a browser would
 * execute the very page this is trying to prove inert.
 *
 * Two jobs, deliberately in one module because they must agree about the tree:
 *
 * - `validateStaticReportHtml` decides whether a report may be archived and indexed at all.
 *   Version 1 allows static markup, inline CSS, inline SVG, fragment links, bounded `data:`
 *   images, relative links that stay inside the report directory, and an `http(s)` target on
 *   an `<a href>`. Everything that can execute, or that fetches on its own, is refused.
 * - `extractVisibleText` produces the bounded text that makes a report searchable, after
 *   removing non-content and hidden nodes. It never follows a link.
 *
 * Both are applied to Mission Control's own captures AND to bundles somebody copied in.
 * A foreign report is untrusted input that a human will be shown; there is no "we wrote it"
 * fast path.
 */

type Element = DefaultTreeAdapterTypes.Element;
type Node = DefaultTreeAdapterTypes.Node;
type ChildNode = DefaultTreeAdapterTypes.ChildNode;

/** Elements that can execute, navigate, or embed another browsing context. */
const FORBIDDEN_ELEMENTS = new Set([
  "script",
  "iframe",
  "frame",
  "frameset",
  "embed",
  "object",
  "applet",
  "portal",
  "form",
  // `<base>` silently re-roots every relative URL in the document, which would make the
  // containment proof below meaningless - the same href could resolve anywhere.
  "base",
  // SMIL. `<set attributeName="href" to="javascript:…">` rewrites an attribute after the
  // document has been checked, which is precisely the "content that only appears after
  // runtime execution" version 1 refuses - the checked tree stops describing the live one.
  // A static report has no use for animation, so this is a ban rather than an analysis.
  "set",
  "animate",
  "animatemotion",
  "animatetransform",
  "discard",
]);

/**
 * Attributes whose value is a URL, in any element. `xlink:href` arrives prefixed.
 *
 * `imagesrcset` is here for the reason it is easy to miss: a `<link rel=preload as=image>`
 * can carry ONLY that attribute and no `src` or `href`, so an element with no
 * recognised URL attribute still made a network request. A real headless browser fetched
 * exactly that shape past an earlier version of this list.
 */
const URL_ATTRIBUTES = new Set([
  "href",
  "src",
  "srcset",
  "imagesrcset",
  "action",
  "formaction",
  "data",
  "poster",
  "background",
  "cite",
  "longdesc",
  "manifest",
  "ping",
  "xlink:href",
]);

/**
 * Anything that only exists to run code, build content at runtime, or move the ground every
 * other check in this file stands on.
 *
 * `xml:base` is the second kind, and it is here for exactly the reason `<base>` is a
 * forbidden ELEMENT: it re-roots relative URL resolution for its subtree, so the containment
 * proof below stops describing what a browser will actually fetch. `urlProblem` reads the
 * literal attribute string and answers "this is a contained relative reference"; with
 * `<svg xml:base="https://evil.example/"><image xlink:href="chart.png"/></svg>` that answer
 * is true about the string and false about the request. Browsers still implement XML Base for
 * inline SVG, and the archived report is opened from `file://` with nothing re-checking it,
 * so a validator that let this through would be making a promise it cannot keep.
 *
 * Only `xml:base`, not the whole `xml:` prefix: `xml:space="preserve"` is ordinary in inline
 * SVG text and `xml:lang` is an accessibility affordance. Neither changes what a reference
 * resolves against, and refusing them would reject honest reports for nothing.
 */
const FORBIDDEN_ATTRIBUTES = new Set(["srcdoc", "xml:base"]);

/** Not content: their text is code, styling, or a fallback for a runtime this never has. */
const NON_CONTENT_ELEMENTS = new Set(["script", "style", "noscript", "template", "iframe"]);

/** SVG bookkeeping - real text inside an inline diagram (`text`, `title`, `desc`) is kept. */
const SVG_METADATA_ELEMENTS = new Set(["metadata", "defs", "symbol", "clippath", "mask"]);

/** A scheme, per RFC 3986, is what turns a reference into somewhere else entirely. */
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** Bounded inline images: big enough for a chart, small enough not to be a payload. */
const MAX_DATA_URL_CHARS = 4 * 1024 * 1024;

/**
 * `scriptingEnabled: false`, which is the difference between validating a report and only
 * appearing to.
 *
 * With scripting ON - parse5's default, and a JS-enabled browser's behaviour - the contents
 * of `<noscript>` are RAW TEXT, so `<noscript><img src="https://evil/a.png"></noscript>`
 * arrives as a text node and the walk below sees no element and no URL attribute at all. A
 * browser with JavaScript disabled parses the same bytes as markup and issues the request.
 * Parsing with scripting off is what makes the tree this validates the WIDER of the two
 * readings, so anything either browser would act on is checked.
 */
const PARSER_OPTIONS = { scriptingEnabled: false } as const;

export interface ArchiveHtmlProblem {
  /** A short machine-readable reason, for tests and for a stable index diagnostic. */
  code: string;
  /** One sentence a human can act on. Never contains page content. */
  message: string;
}

export type ArchiveHtmlValidation =
  | { ok: true }
  | { ok: false; problems: ArchiveHtmlProblem[] };

/** How many distinct problems one refusal reports before it stops counting. */
const MAX_REPORTED_PROBLEMS = 20;

/**
 * Whether `html` is a self-contained, non-executing version 1 archive report.
 *
 * `relativeTargets` is the set of report-directory paths that a relative link is allowed to
 * name, relative to `report/report.html` itself - i.e. the report's companion files. A link
 * to a companion that is not in the bundle is refused rather than left dangling: the
 * archive is supposed to be readable with no checkout, and a link to a file that was never
 * captured is a promise the bundle cannot keep.
 *
 * Passing `null` skips only the membership half of the check; containment is still enforced,
 * because that is the part that stops a link escaping the bundle.
 */
export function validateStaticReportHtml(
  html: string,
  relativeTargets: ReadonlySet<string> | null = null,
): ArchiveHtmlValidation {
  const problems: ArchiveHtmlProblem[] = [];
  const seen = new Set<string>();
  const add = (code: string, message: string): void => {
    const dedupe = `${code}:${message}`;
    if (seen.has(dedupe) || problems.length >= MAX_REPORTED_PROBLEMS) return;
    seen.add(dedupe);
    problems.push({ code, message });
  };

  let document: DefaultTreeAdapterTypes.Document;
  try {
    document = parse(html, PARSER_OPTIONS);
  } catch {
    return { ok: false, problems: [{ code: "unparseable", message: "the report is not HTML" }] };
  }

  walk(document, (node) => {
    if (!isElement(node)) return true;
    const tag = node.tagName.toLowerCase();
    if (FORBIDDEN_ELEMENTS.has(tag)) {
      add("forbidden_element", `<${tag}> is not allowed in an archived report`);
      return true;
    }
    for (const attr of node.attrs) {
      const name = attributeName(attr);
      if (name.startsWith("on")) {
        add("event_handler", `the ${name} event handler is not allowed in an archived report`);
        continue;
      }
      if (FORBIDDEN_ATTRIBUTES.has(name)) {
        add("forbidden_attribute", `the ${name} attribute is not allowed in an archived report`);
        continue;
      }
      if (name === "http-equiv" && attr.value.trim().toLowerCase() === "refresh") {
        add("meta_refresh", "a meta refresh is not allowed in an archived report");
        continue;
      }
      if (name === "style") {
        for (const problem of cssProblems(attr.value, relativeTargets)) add(problem.code, problem.message);
        continue;
      }
      if (!URL_ATTRIBUTES.has(name)) continue;
      for (const value of splitUrlAttribute(name, attr.value)) {
        const problem = urlProblem(value, {
          linkTarget: LINK_TARGET_ATTRIBUTES.has(name),
          clickable: isClickableDestination(tag, name),
          relativeTargets,
        });
        if (problem) add(problem.code, problem.message);
      }
    }
    if (tag === "style") {
      for (const problem of cssProblems(textOf(node), relativeTargets)) add(problem.code, problem.message);
    }
    return true;
  });

  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

/**
 * The visible text of a report, normalized and bounded, for the search index.
 *
 * Bounded at `ARCHIVE_TEXT_LIMITS.reportText` because the index is a local convenience and a
 * 32 MiB report must not become 32 MiB of rows. Truncation is honest: the manifest summary
 * is indexed separately, so a list result stays useful even when a huge report's tail was
 * not indexed.
 */
export function extractVisibleText(html: string, cap: number = ARCHIVE_TEXT_LIMITS.reportText): string {
  let document: DefaultTreeAdapterTypes.Document;
  try {
    document = parse(html, PARSER_OPTIONS);
  } catch {
    return "";
  }
  const parts: string[] = [];
  let length = 0;
  walk(document, (node) => {
    if (isText(node)) {
      if (length >= cap) return false;
      const text = node.value;
      if (text.trim() === "") return true;
      parts.push(text);
      length += text.length;
      return true;
    }
    if (!isElement(node)) return true;
    const tag = node.tagName.toLowerCase();
    if (NON_CONTENT_ELEMENTS.has(tag) || SVG_METADATA_ELEMENTS.has(tag)) return false;
    if (isHidden(node)) return false;
    return true;
  });
  return normalizeWhitespace(parts.join(" ")).slice(0, cap);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function isElement(node: Node): node is Element {
  return "tagName" in node;
}

function isText(node: Node): node is DefaultTreeAdapterTypes.TextNode {
  return node.nodeName === "#text";
}

/** parse5 keeps a foreign-content prefix separately; `xlink:href` must read as one name. */
function attributeName(attr: { name: string; prefix?: string }): string {
  const name = attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name;
  return name.toLowerCase();
}

/**
 * Depth-first walk. Returning false from `visit` prunes the subtree, which is what makes
 * "a `<style>`'s text is not content" a single rule rather than a check at every text node.
 *
 * `<template>` content is walked for VALIDATION (a template holding a `<script>` is still a
 * script in the file) but pruned for extraction, which is why extraction lists it as
 * non-content rather than relying on the walk to skip it.
 */
function walk(root: Node, visit: (node: Node) => boolean): void {
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node !== root && !visit(node)) continue;
    const children = childrenOf(node);
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]!);
  }
}

function childrenOf(node: Node): ChildNode[] {
  if ("content" in node && node.content) return node.content.childNodes;
  if ("childNodes" in node && node.childNodes) return node.childNodes;
  return [];
}

function textOf(node: Node): string {
  const parts: string[] = [];
  for (const child of childrenOf(node)) {
    if (isText(child)) parts.push(child.value);
  }
  return parts.join("");
}

const HIDDEN_STYLE_RE = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:;|$)/i;

function isHidden(node: Element): boolean {
  for (const attr of node.attrs) {
    const name = attributeName(attr);
    if (name === "hidden") return true;
    if (name === "aria-hidden" && attr.value.trim().toLowerCase() === "true") return true;
    if (name === "style" && HIDDEN_STYLE_RE.test(attr.value)) return true;
  }
  return false;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** A `srcset` descriptor rather than a URL: `2x`, `640w`, `1.5x`. */
const SRCSET_DESCRIPTOR_RE = /^[0-9.]+[xwh]$/i;

/**
 * `srcset`, `imagesrcset`, and `ping` carry several URLs in one attribute.
 *
 * Split on WHITESPACE, not on commas, which is what the HTML srcset grammar actually says
 * and the only split that survives a `data:` URL - every base64 payload contains commas, so
 * a comma split tore one inline image into a fake scheme and a fake relative link, and
 * refused the whole report for using the ordinary responsive-image syntax.
 *
 * Each token is then either a descriptor or a URL; a trailing comma ends a candidate and is
 * stripped. Treating an unrecognised token as a URL is the safe direction - it can only
 * cause an extra check, never a skipped one.
 */
function splitUrlAttribute(name: string, raw: string): string[] {
  if (name === "srcset" || name === "imagesrcset") {
    return raw
      .split(/\s+/)
      .map((token) => token.replace(/,+$/, ""))
      .filter((token) => token !== "" && !SRCSET_DESCRIPTOR_RE.test(token));
  }
  if (name === "ping") return raw.split(/\s+/).filter((value) => value !== "");
  return [raw];
}

/**
 * Attributes whose value is a link TARGET rather than a resource to load.
 *
 * Used for one thing only: refusing a `data:` URL in a slot where a browser would treat it
 * as somewhere to GO. That rule predates the external-link allowance and is unchanged by it -
 * a `data:` link target opens attacker-authored markup with the archive's own opener, whatever
 * element carries it.
 */
const LINK_TARGET_ATTRIBUTES = new Set(["href", "action", "formaction", "ping"]);

/**
 * Whether this element+attribute pair is a destination a person must CLICK to reach.
 *
 * The pair, never the attribute alone, and that is the whole correctness argument. `href` is
 * not one kind of thing: on `<a>` it is where a click goes, and on `<link>`, SVG `<use>` and
 * SVG `<image>` it is a resource the browser fetches the moment the page opens. Keying the
 * allowance to the attribute name would therefore have let `<link rel=stylesheet
 * href="https://…">` and `<use href="https://…/x.svg#a">` through - a page that phones home on
 * open, which is precisely what this validator exists to prevent. An earlier revision of this
 * change did exactly that; `test/archive-bundle.test.ts` pins each of those elements.
 *
 * `<a href>` and NOTHING else, which is narrower than "every clickable destination" on
 * purpose. `<area href>` is a genuine one - an image-map region is an anchor with a shape -
 * and it is refused anyway, because the approved allowance names anchors and an archived
 * report that needs an external image map does not exist. `action` and `formaction` are out
 * for a second reason as well: `<form>` is a forbidden element, so neither can ever be
 * submitted, and a slot no click can reach is not a destination at all.
 *
 * The rule to apply when this list is next questioned: an element joins it only when a person
 * clicking is the ONLY way its URL is ever requested, and only when a real report needs it.
 */
function isClickableDestination(tag: string, attributeName: string): boolean {
  return attributeName === "href" && tag === "a";
}

interface UrlContext {
  /** A link target: refuses `data:`, exactly as it always has. */
  linkTarget: boolean;
  /** `<a href>` or `<area href>`: the one place an external `http(s)` reference is allowed. */
  clickable: boolean;
  relativeTargets: ReadonlySet<string> | null;
}

/**
 * Whether one URL is allowed in an archived report, and why not when it is not.
 *
 * The allowed set is small on purpose: a fragment, a bounded `data:` image in a fetching
 * slot, a relative reference that stays inside the report directory, and an `http(s)` target
 * on an `<a href>` - a destination a person can CLICK. Everything else - any other scheme, a
 * protocol-relative `//host`, a path that climbs out - is refused.
 *
 * The line the external-link allowance is drawn on is the one this file was already
 * defending: what this machine requests on somebody else's behalf when a human OPENS an
 * archive they were sent. An `<img src>` fetches on open, tells a server the page was read,
 * and does it before anyone has decided anything - so every scheme stays refused there, and
 * in every other fetching slot: a `ping` beacon, which is sent on a click without being where
 * the click goes, and every `href` that is not an anchor's - whether it is a RESOURCE
 * (`<link rel=stylesheet>`, SVG `<use>`, SVG `<image>`) or merely another way to navigate
 * (`<area>`). An `<a href="https://...">` requests
 * nothing until a person acts, and then takes them somewhere their own browser shows them.
 * Real pages cite their sources; refusing that made an archived report link to documentation
 * it could only describe.
 *
 * `data:` is unchanged in every slot. A `data:` link target is a navigation primitive rather
 * than a reference - it opens attacker-authored markup with the archive's own opener - and
 * an inline image is still bounded and still limited to image and font payloads.
 */
function urlProblem(raw: string, context: UrlContext): ArchiveHtmlProblem | null {
  const value = raw.trim();
  if (value === "") return null;
  if (value.startsWith("#")) return null;
  if (value.startsWith("//")) {
    return { code: "protocol_relative_url", message: "a protocol-relative URL would fetch from the network" };
  }
  const scheme = SCHEME_RE.exec(value)?.[0]?.slice(0, -1).toLowerCase();
  if (scheme) {
    if (context.clickable && (scheme === "http" || scheme === "https")) return null;
    if (scheme !== "data") {
      return { code: "external_url", message: `the ${scheme}: scheme is not allowed in an archived report` };
    }
    if (context.linkTarget) {
      return { code: "data_navigation", message: "a data: URL cannot be a link target in an archived report" };
    }
    if (value.length > MAX_DATA_URL_CHARS) {
      return { code: "data_url_too_large", message: "an inline data: resource exceeds its size limit" };
    }
    if (!/^data:(?:image\/|font\/)/i.test(value)) {
      return { code: "data_url_kind", message: "only inline image and font data: resources are allowed" };
    }
    return null;
  }
  const resolved = resolveInsideReport(value);
  if (!resolved) {
    return { code: "escaping_link", message: "a relative link leaves the report directory" };
  }
  if (context.relativeTargets && !context.relativeTargets.has(resolved)) {
    return {
      code: "missing_companion",
      message: "a relative link names a file that is not in the report directory",
    };
  }
  return null;
}

/**
 * Resolve a relative reference against `report/report.html`, returning its path within the
 * report directory or null when it escapes.
 *
 * Hand-resolved rather than via `new URL(value, base)` because a base URL forces a scheme,
 * and every scheme brings its own normalization quirks (backslashes, percent-decoding,
 * authority parsing) that a containment check must not inherit. The rules here are exactly
 * the ones `validateArchivePath` enforces on the manifest side, so a link and a stored
 * path cannot disagree about what "inside" means.
 */
function resolveInsideReport(raw: string): string | null {
  const withoutFragment = raw.split("#")[0] ?? "";
  const withoutQuery = withoutFragment.split("?")[0] ?? "";
  if (withoutQuery === "") return null;
  if (withoutQuery.startsWith("/") || withoutQuery.includes("\\")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutQuery);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const out: string[] = [];
  for (const segment of decoded.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.length === 0 ? null : out.join("/");
}

/**
 * Every reference a stylesheet could fetch, found by scanning rather than by pattern.
 *
 * A regex was the first attempt and it was wrong in a way that failed OPEN. `url\(\s*(['"]?)
 * ([^'")]*)\1\s*\)` cannot match a quoted URL containing a `)`: the character class stops at
 * the paren, the backreference then fails, and the match is abandoned - so
 * `url("http://host/a)b.png")` produced no finding at all and a real browser fetched it.
 * `image-set("http://…")` contains no `url(` token to match in the first place.
 *
 * So this walks the text instead, tracking string state, and reports two things:
 *
 * 1. every `url()` value and every `@import` target, resolved through the same `urlProblem`
 *    an attribute goes through - so a relative stylesheet reference has to name a captured
 *    companion, exactly like a relative `<img src>`;
 * 2. every STRING LITERAL that begins with a scheme or `//`, wherever it appears. That is
 *    the net for the next `image-set()` - a CSS function this build has never heard of that
 *    takes a URL as a string. The cost is that `content: "https://example.com"` as display
 *    text is refused; the report can write that URL in its own markup instead.
 *
 * Comments are skipped so a commented-out `url()` is not reported, and so a `/* *\/` cannot
 * hide one either.
 */
function cssProblems(css: string, relativeTargets: ReadonlySet<string> | null): ArchiveHtmlProblem[] {
  const problems: ArchiveHtmlProblem[] = [];
  const check = (value: string): void => {
    // Every reference a stylesheet carries is fetched when the page opens, however it is
    // spelled, so CSS is entirely a fetching slot and the navigational allowance never
    // reaches it.
    const problem = urlProblem(value, { linkTarget: false, clickable: false, relativeTargets });
    if (problem) problems.push(problem);
  };

  let i = 0;
  while (i < css.length) {
    const char = css[i]!;
    if (char === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end < 0 ? css.length : end + 2;
      continue;
    }
    if (char === '"' || char === "'") {
      const literal = readCssString(css, i, char);
      // Only scheme-bearing literals: an ordinary `font-family: "Inter"` or a `content: "→"`
      // is not a reference, and refusing every string would refuse every stylesheet.
      if (SCHEME_RE.test(literal.value) || literal.value.startsWith("//")) check(literal.value);
      i = literal.end;
      continue;
    }
    if (startsWithAt(css, i, "url(")) {
      const value = readCssFunctionArgument(css, i + 4);
      check(value.value);
      i = value.end;
      continue;
    }
    if (startsWithAt(css, i, "@import")) {
      const rest = css.slice(i + 7);
      const target = /^\s*(?:url\(\s*)?(['"]?)([^'")\s;]*)\1/.exec(rest);
      if (target?.[2]) check(target[2]);
      i += 7;
      continue;
    }
    i += 1;
  }
  return problems;
}

function startsWithAt(text: string, index: number, token: string): boolean {
  return text.slice(index, index + token.length).toLowerCase() === token;
}

/** Read a CSS string literal starting at its opening quote, honouring backslash escapes. */
function readCssString(css: string, start: number, quote: string): { value: string; end: number } {
  let out = "";
  let i = start + 1;
  while (i < css.length) {
    const char = css[i]!;
    if (char === "\\") {
      out += css[i + 1] ?? "";
      i += 2;
      continue;
    }
    if (char === quote) return { value: out, end: i + 1 };
    out += char;
    i += 1;
  }
  return { value: out, end: css.length };
}

/** Read one `url(...)` argument, quoted or bare, from just after the opening paren. */
function readCssFunctionArgument(css: string, start: number): { value: string; end: number } {
  let i = start;
  while (i < css.length && /\s/.test(css[i]!)) i += 1;
  const char = css[i];
  if (char === '"' || char === "'") {
    const literal = readCssString(css, i, char);
    const close = css.indexOf(")", literal.end);
    return { value: literal.value, end: close < 0 ? css.length : close + 1 };
  }
  const close = css.indexOf(")", i);
  const end = close < 0 ? css.length : close;
  return { value: css.slice(i, end).trim(), end: end + 1 };
}
