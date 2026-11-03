import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// What is at stake: a skin repaints the dashboard by overriding custom properties, so every
// colour the chrome paints has to resolve through one. A literal left in a rule body is a
// patch the skin cannot reach - under a light skin it shows as a dark smudge - and nothing
// else in the repository would notice it arrive.
//
// The leading `:root` block is where tokens are declared, literals and all; everything after
// it may only name colours through `var(--...)`, `color-mix()` of those, `transparent` and
// `currentColor`. The few literals that are not chrome are listed below, each with the
// reason a skin must leave it alone, and an entry that no longer matches anything fails too,
// so the list cannot outlive what it excuses.

const STYLES = fileURLToPath(new URL("../src/web/styles.css", import.meta.url));

interface Allowed {
  selector: string;
  property: string;
  literal: string;
  reason: string;
}

const ALLOWED: readonly Allowed[] = [
  {
    selector: ".managed-plan-reader iframe",
    property: "background",
    literal: "white",
    reason: "the canvas behind operator HTML, which is authored against a browser's white default",
  },
  {
    selector: ".html-preview",
    property: "background",
    literal: "white",
    reason: "the canvas behind operator HTML, which is authored against a browser's white default",
  },
  {
    selector: ".artifact-preview",
    property: "background",
    literal: "#fff",
    reason: "the canvas behind operator HTML, which is authored against a browser's white default",
  },
  {
    selector: ".conversation-header-preview .detail-tabs",
    property: "mask-image",
    literal: "#000",
    reason: "a mask reads only alpha; its colour never reaches the screen",
  },
  {
    selector: ".rm-occurrence-list",
    property: "mask-image",
    literal: "#000",
    reason: "a mask reads only alpha; its colour never reaches the screen",
  },
];

// Every CSS named colour. `transparent` and `currentColor` are deliberately absent: neither
// fixes a hue a skin would need to change.
const NAMED = new Set(
  (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue " +
    "blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk " +
    "crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki " +
    "darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen " +
    "darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue " +
    "dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite " +
    "gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki " +
    "lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan " +
    "lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen " +
    "lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen " +
    "magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen " +
    "mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream " +
    "mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid " +
    "palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum " +
    "powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown " +
    "seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen " +
    "steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen " +
    // CSS system colours, current and deprecated: the browser supplies the hue, so a skin
    // cannot reach it any more than it can reach a literal.
    "accentcolor accentcolortext activetext buttonborder buttonface buttontext canvas canvastext " +
    "field fieldtext graytext highlight highlighttext linktext mark marktext selecteditem " +
    "selecteditemtext visitedtext activeborder activecaption appworkspace background " +
    "buttonhighlight buttonshadow captiontext inactiveborder inactivecaption " +
    "inactivecaptiontext infobackground infotext menu menutext scrollbar threeddarkshadow " +
    "threedface threedhighlight threedlightshadow threedshadow window windowframe windowtext"
  ).split(" "),
);
// Browser-supplied colours spelled with a vendor prefix.
const VENDOR_COLOUR = /(?<![\w-])-(?:webkit|moz)-(?:link|activelink|focus-ring-color|hyperlinktext|activehyperlinktext|visitedhyperlinktext)(?![\w-])/gi;

// Properties whose values are names, not paint: an animation called `pulse`, a grid area
// called `tan`, a font called `Menlo`. A colour word in one of these is not a colour.
// Only properties that cannot take an image belong here: `content` and the `list-style`
// shorthand both accept `linear-gradient(red, blue)`, so their unquoted words are read.
const NOT_PAINT =
  /^(?:animation(?:-name)?|font(?:-family)?|grid(?:-template)?(?:-areas)?|grid-area|grid-(?:row|column)(?:-start|-end)?|counter-(?:reset|increment|set)|list-style-type|transition(?:-property)?|will-change|view-transition-name|container(?:-name)?|anchor-name|position-anchor|quotes)$/;

const HEX = /#[0-9a-fA-F]{3,8}\b/g;
// Case-insensitive, as CSS function names are: `RGB(255, 0, 0)` is `rgb(255, 0, 0)`.
const COLOUR_FN = /(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi;
// A `url()` in any of its three spellings: double-quoted, single-quoted or bare.
const URL_REF = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]*))\s*\)/gi;
const WORD = /(?<![\w#%-])[a-z]+(?![\w-])/gi;

/** Every hex, colour function and named colour a piece of text spells out. */
function colourWords(text: string): string[] {
  const named = (text.match(WORD) ?? []).filter((word) => NAMED.has(word.toLowerCase()));
  return [...(text.match(HEX) ?? []), ...(text.match(COLOUR_FN) ?? []), ...named, ...(text.match(VENDOR_COLOUR) ?? [])];
}

/**
 * The value as CSS reads it. `\72 ed` is `red` and `\23 fff` is `#fff`: an escape is a
 * spelling, not a different word, so every check below runs on the decoded text.
 */
function decodeCssEscapes(text: string): string {
  return text.replace(/\\(?:([0-9a-fA-F]{1,6})(?:\r\n|[ \t\r\n\f])?|([^\r\n\f0-9a-fA-F]))/g, (_, hex: string | undefined, char: string | undefined) => {
    if (char !== undefined) return char;
    const code = Number.parseInt(hex!, 16);
    return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? "\ufffd" : String.fromCodePoint(code);
  });
}

/**
 * The colours a data URI paints with, wherever it stands: inside `url()`, or as a bare
 * string where `image-set()` and `cross-fade()` accept one. A plain `url()` and other quoted
 * text are otherwise skipped, so a file called `white.svg`, a fragment like `icons.svg#fff`
 * or a label is not read as a colour - which would let an inline image paint a hue no token
 * reaches. So every data URI is opened instead:
 * markup (SVG, any text type) is decoded, percent-escaped or base64 alike, and searched for
 * hex, colour functions and named colours. A raster payload bakes its colours into pixels
 * no token can reach, so the URI itself is reported; one that is genuinely not chrome
 * belongs on the allowlist with its reason.
 */
/**
 * SVG text as the XML parser hands it to the renderer: `&#x72;ed` and `&#114;ed` are `red`.
 * One pass, as XML does, so `&amp;#x72;` stays the literal text `&#x72;`.
 */
function decodeXmlReferences(text: string): string {
  const NAMED_REFS: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return text.replace(/&(?:#x([0-9a-fA-F]+)|#([0-9]+)|(amp|lt|gt|quot|apos));/gi, (match, hex?: string, dec?: string, name?: string) => {
    if (name) return NAMED_REFS[name.toLowerCase()]!;
    const code = Number.parseInt(hex ?? dec!, hex ? 16 : 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : match;
  });
}

// A data URI nested inside an image's markup, such as `<image href="data:...;base64,...">`.
const NESTED_DATA_URI = /data:[^,"'\s<>()]*,[^"'\s<>()]*/gi;

function dataUriColours(target: string, depth = 0): string[] {
  const uri = /^data:([^,]*),([\s\S]*)$/i.exec(target.trim());
  if (!uri) return [];
  const params = (uri[1] ?? "").split(";").map((part) => part.trim().toLowerCase());
  const mime = params[0] || "text/plain";
  const base64 = params.includes("base64");
  let payload = uri[2] ?? "";
  try {
    payload = decodeURIComponent(payload);
  } catch {
    // A malformed escape: still unmask `#`, the one escape a colour needs.
    payload = payload.replace(/%23/gi, "#");
  }
  const markup = mime === "image/svg+xml" || mime.startsWith("text/") || mime.endsWith("+xml");
  if (!markup) return [`data:${mime}${base64 ? ";base64" : ""}`];
  if (base64) payload = Buffer.from(payload.replace(/\s+/g, ""), "base64").toString("utf8");
  // Read the markup the way the renderer will: XML character references resolved, then CSS
  // escapes, which an SVG's own `<style>` or `style=""` accepts like any stylesheet.
  const text = decodeCssEscapes(decodeXmlReferences(payload));
  const found = colourWords(text);
  // An image can embed another; open those too, a few levels deep.
  if (depth < 4) for (const nested of text.match(NESTED_DATA_URI) ?? []) found.push(...dataUriColours(nested, depth + 1));
  return found;
}

interface Declaration {
  line: number;
  selector: string;
  property: string;
  value: string;
}

interface Parsed {
  root: string;
  declarations: Declaration[];
}

/** Blank out comments, keeping every newline so reported line numbers stay true. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

/**
 * Split the stylesheet into the leading `:root` block and every declaration after it, each
 * with the innermost selector it sits under. `@media` and `@supports` wrappers are walked
 * through, so a rule inside one reports its own selector rather than the at-rule's.
 */
function parse(source: string): Parsed {
  const css = stripComments(source);
  const open = css.search(/\S/);
  assert.ok(css.startsWith(":root", open), "styles.css must open with its `:root` token block");
  const rootOpen = css.indexOf("{", open);
  const rootClose = css.indexOf("\n}", rootOpen);
  assert.ok(rootClose > rootOpen, "the leading `:root` block never closes");
  const root = css.slice(rootOpen + 1, rootClose);

  const declarations: Declaration[] = [];
  const stack: string[] = [];
  let start = rootClose + 2;
  let line = css.slice(0, start).split("\n").length;
  let buffer = "";
  let bufferLine = line;
  // A `;` or brace inside a string or a `url(...)` is part of the value - a data URI such as
  // `data:image/svg+xml;utf8,...` carries one - so neither ends a declaration there.
  let quote: string | null = null;
  let depth = 0;
  for (let i = start; i < css.length; i++) {
    const ch = css[i]!;
    if (quote !== null || depth > 0 || ch === '"' || ch === "'" || ch === "(" ) {
      if (quote !== null) {
        if (ch === "\\") {
          buffer += ch + (css[i + 1] ?? "");
          if (css[i + 1] === "\n") line += 1;
          i += 1;
          continue;
        }
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      buffer += ch;
      if (ch === "\n") line += 1;
      continue;
    }
    if (ch === "{") {
      stack.push(buffer.trim().replace(/\s+/g, " "));
      buffer = "";
      bufferLine = line;
    } else if (ch === "}" || ch === ";") {
      const text = buffer.trim();
      const colon = text.indexOf(":");
      const selector = stack[stack.length - 1] ?? "";
      // At-rule blocks hold declarations too - `@property`'s `initial-value`, `@font-face`,
      // `@page` - and those paint like any other; a rule nested in `@media` reports its own.
      if (colon > 0 && stack.length > 0) {
        declarations.push({
          line: bufferLine + (buffer.slice(0, buffer.search(/\S|$/)).split("\n").length - 1),
          selector,
          property: text.slice(0, colon).trim().toLowerCase(),
          value: text.slice(colon + 1).trim(),
        });
      }
      buffer = "";
      bufferLine = line;
      if (ch === "}") stack.pop();
    } else {
      buffer += ch;
    }
    if (ch === "\n") line += 1;
  }
  // An unclosed string or parenthesis would swallow every rule after it and turn the guard
  // into a silent pass, so the walk must end exactly where it began.
  assert.equal(quote, null, "styles.css ends inside an unclosed string");
  assert.equal(depth, 0, "styles.css ends inside an unclosed parenthesis");
  assert.deepEqual(stack, [], "styles.css ends inside an unclosed block");
  return { root, declarations };
}

/** Every colour literal a declaration value names. Strings and urls are searched too. */
function literals(declaration: Declaration): string[] {
  const value = decodeCssEscapes(declaration.value);
  // Pull every image source out first: each url() target, and each quoted string that is a
  // data URI. What remains holds no image, only text and plain values.
  const sources: string[] = [];
  const bare = value
    .replace(URL_REF, (_match, a?: string, b?: string, c?: string) => {
      sources.push(a ?? b ?? c ?? "");
      return " ";
    })
    .replace(/"([^"]*)"|'([^']*)'/g, (match, a?: string, b?: string) => {
      const text = (a ?? b ?? "").trim();
      if (!/^data:/i.test(text)) return match;
      sources.push(text);
      return " ";
    });
  // Hex and colour functions anywhere; colour names only where the property paints and only
  // outside quoted text, so a quoted label is not a colour.
  const found = [...(bare.match(HEX) ?? []), ...(bare.match(COLOUR_FN) ?? []), ...sources.flatMap(dataUriColours)];
  if (!NOT_PAINT.test(declaration.property)) {
    const unquoted = bare.replace(/"[^"]*"|'[^']*'/g, " ");
    for (const word of unquoted.match(WORD) ?? []) if (NAMED.has(word.toLowerCase())) found.push(word);
    found.push(...(unquoted.match(VENDOR_COLOUR) ?? []));
  }
  return found;
}

function offenders(source: string): { declaration: Declaration; literal: string }[] {
  const out: { declaration: Declaration; literal: string }[] = [];
  for (const declaration of parse(source).declarations) {
    for (const literal of literals(declaration)) out.push({ declaration, literal });
  }
  return out;
}

function isAllowed(hit: { declaration: Declaration; literal: string }): Allowed | undefined {
  return ALLOWED.find(
    (entry) =>
      entry.selector === hit.declaration.selector &&
      entry.property === hit.declaration.property &&
      entry.literal.toLowerCase() === hit.literal.toLowerCase(),
  );
}

const describe = (hit: { declaration: Declaration; literal: string }): string =>
  `  line ${hit.declaration.line}: ${hit.declaration.selector} { ${hit.declaration.property}: ` +
  `${hit.declaration.value.slice(0, 120)} } - "${hit.literal}"`;

test("every colour after :root resolves through a token", () => {
  const hits = offenders(readFileSync(STYLES, "utf8")).filter((hit) => !isAllowed(hit));
  assert.deepEqual(
    hits.map(describe),
    [],
    "styles.css paints a raw colour outside `:root`. Use an existing token, a color-mix() of " +
      "tokens, or declare a role token on `:root` whose value is this literal:\n" +
      hits.map(describe).join("\n"),
  );
});

test("every allowlisted literal is still in the stylesheet, so the list cannot go stale", () => {
  const hits = offenders(readFileSync(STYLES, "utf8"));
  for (const entry of ALLOWED) {
    assert.ok(entry.reason.length > 0, `${entry.selector} is allowlisted without a reason`);
    assert.ok(
      hits.some((hit) => isAllowed(hit) === entry),
      `allowlist entry ${entry.selector} { ${entry.property}: ${entry.literal} } matches nothing; remove it`,
    );
  }
});

test("only :root fixes the colour scheme, so a light skin reaches native controls", () => {
  const { root, declarations } = parse(readFileSync(STYLES, "utf8"));
  assert.match(root, /color-scheme:\s*dark\s*;/, "the default skin is dark and says so on :root");
  const fixed = declarations.filter((d) => d.property === "color-scheme" && d.value !== "inherit");
  assert.deepEqual(
    fixed.map((d) => `line ${d.line}: ${d.selector} { color-scheme: ${d.value} }`),
    [],
    "a hard-coded color-scheme below :root keeps native controls dark under a light skin",
  );
});

// The guard is only worth having if it fires. These run the same scanner over small
// stylesheets, so a regression in the parser cannot quietly turn it into a pass.
const SHEET = (body: string): string => `:root {\n  --fg: #e7ebf1;\n  --shadow: 0 1px 2px rgba(0, 0, 0, 0.4);\n}\n\n${body}\n`;

test("the scanner reports each kind of literal it guards against", () => {
  const cases: [string, string | string[]][] = [
    [".a { color: #fff; }", "#fff"],
    [".a { border-color: #a878ffcc; }", "#a878ffcc"],
    [".a { box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4); }", "rgba("],
    [".a { background: rgb(0 0 0 / 44%); }", "rgb("],
    [".a { color: hsl(10 50% 50%); }", "hsl("],
    [".a { color: oklch(70% 0.1 200); }", "oklch("],
    [".a { background: color-mix(in oklab, var(--fg) 50%, black); }", "black"],
    [`.a { background-image: url("data:image/svg+xml,%3Csvg stroke='%23939eae'/%3E"); }`, "#939eae"],
    [`.a { background-image: url("data:image/svg+xml,%3Csvg fill='red'/%3E"); }`, "red"],
    [`.a { mask-image: url('data:image/svg+xml;utf8,<svg><path stroke="white"/></svg>'); }`, "white"],
    [".a { content: url(data:image/svg+xml,%3Csvg%20fill%3D%22black%22%2F%3E); }", "black"],
    [`.a { background-image: url("data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnPjxwYXRoIGZpbGw9J3JlZCcgZD0nTTAgMGg0djR6Jy8+PC9zdmc+"); }`, "red"],
    [`.a { mask-image: url(data:image/svg+xml;charset=utf-8;base64,PHN2Zz48cmVjdCBmaWxsPSIjYzgzNTJjIi8+PC9zdmc+); }`, "#c8352c"],
    [`.a { background: url('data:image/svg+xml;base64,PHN2Zz48cmVjdCBzdHlsZT0iZmlsbDogcmdiKDIwMCA1MyA0NCkiLz48L3N2Zz4='); }`, "rgb("],
    [`.a { background: url("data:image/svg+xml,%3Csvg fill='rgb%28200 53 44%29'/%3E"); }`, "rgb("],
    [`.a { background-image: url("data:image/png;base64,iVBORw0KGgo="); }`, "data:image/png;base64"],
    ["@media (max-width: 700px) {\n  .a { color: white; }\n}", "white"],
    // A declaration directly inside an at-rule block is scanned like any other.
    ["@property --accent {\n  syntax: \"<color>\";\n  inherits: true;\n  initial-value: red;\n}", "red"],
    ["@font-face {\n  font-family: Probe;\n  src: url(\"data:image/svg+xml,%3Csvg fill='%23c8352c'/%3E\");\n}", "#c8352c"],
    [".a { --local: #123456; }", "#123456"],
    // `content` and `list-style` take images, and an image can be painted in named colours.
    [".btn::before { content: linear-gradient(red, blue); }", ["red", "blue"]],
    [".a::after { content: radial-gradient(white, transparent) \"label\"; }", "white"],
    [".a { list-style: inside linear-gradient(black, transparent); }", "black"],
    // A data URI does not need url(): image-set() and cross-fade() take it as a bare string.
    [`.a { background-image: image-set("data:image/svg+xml,%3Csvg fill='red'/%3E" 1x); }`, "red"],
    [`.a { background-image: -webkit-image-set('data:image/svg+xml,%3Csvg fill=%22%23c8352c%22/%3E' 2x); }`, "#c8352c"],
    // System colours: the browser picks the hue, so no token reaches it.
    [".a { color: CanvasText; }", "CanvasText"],
    [".a { background: Canvas; }", "Canvas"],
    [".a { border-color: ButtonBorder; outline-color: -webkit-focus-ring-color; }", ["ButtonBorder", "-webkit-focus-ring-color"]],
    // CSS escapes spell the same word.
    [".a { color: \\72 ed; }", "red"],
    [".a { color: \\23 c8352c; }", "#c8352c"],
    [".a { background: \\72 gb(200 53 44); }", "rgb("],
    [".a { background-color: \\000057hite; }", "White"],
    // Colour functions are case-insensitive.
    [".a { color: RGB(255, 0, 0); }", "RGB("],
    [".a { background: Hsl(0 100% 50%); border-color: OKLCH(60% 0.2 30); }", ["Hsl(", "OKLCH("]],
    // Inside an image, XML character references and CSS escapes are resolved before painting.
    [`.a { background-image: url("data:image/svg+xml,%3Csvg fill='&#x72;ed'/%3E"); }`, "red"],
    [`.a { background-image: url("data:image/svg+xml,%3Csvg fill='&#114;ed'/%3E"); }`, "red"],
    [`.a { background-image: url("data:image/svg+xml,%3Csvg fill='&#x23;c8352c'/%3E"); }`, "#c8352c"],
    [`.a { background-image: url("data:image/svg+xml,%3Csvg%3E%3Cstyle%3Epath%7Bfill:%5C72 ed%7D%3C/style%3E%3C/svg%3E"); }`, "red"],
    // An image nested inside an image is opened as well.
    [`.a { background-image: url("data:image/svg+xml,%3Csvg%3E%3Cimage href='data:image/svg+xml;base64,PHN2Zz48cmVjdCBmaWxsPSd0b21hdG8nLz48L3N2Zz4='/%3E%3C/svg%3E"); }`, "tomato"],
  ];
  for (const [body, literal] of cases) {
    const hits = offenders(SHEET(body));
    const expected = Array.isArray(literal) ? literal : [literal];
    assert.deepEqual(hits.map((hit) => hit.literal), expected, `missed ${expected.join(", ")} in ${body}`);
  }
});

test("the scanner leaves tokens, mixes of tokens, non-paint names and the :root block alone", () => {
  const clean = [
    ".a { color: var(--fg); background: color-mix(in oklab, var(--fg) 12%, transparent); }",
    ".a { border-color: currentColor; outline-color: transparent; }",
    ".a { animation: tan 1s; grid-area: red; font-family: Menlo, monospace; }",
    `.a::before { content: "white"; }`,
    `.a::before { content: counter(item) ". " attr(data-label); }`,
    ".a { list-style-type: square; counter-reset: item; }",
    "@media (max-width: 700px) {\n  .a { color: var(--fg); }\n}\n@keyframes pulse {\n  from { opacity: 0; }\n  to { opacity: 1; }\n}",
    "@property --accent {\n  syntax: \"<color>\";\n  inherits: true;\n  initial-value: transparent;\n}",
    `.a { background-image: image-set("icons/red.png" 1x, "icons/white.png" 2x); }`,
    ".a { transition: background 0.14s ease, color 0.14s ease; will-change: background; }",
    `.a::before { content: "\\72 ed"; }`,
    `.a { background-image: url("data:image/svg+xml,%3Csvg fill='none'%3E%3Ctext%3E&amp;#x72;ed%3C/text%3E%3C/svg%3E"); }`,
    `.a { background-image: url(white.svg), url("icons/red.png"); }`,
    `.a { background-image: url("data:image/svg+xml,%3Csvg fill='none' stroke='currentColor' stroke-linecap='round'/%3E"); }`,
    `.a { background-image: url("data:image/svg+xml;base64,PHN2Zz48cGF0aCBmaWxsPSdub25lJyBzdHJva2U9J2N1cnJlbnRDb2xvcicvPjwvc3ZnPg=="); }`,
    `.a { background-image: url(icons.svg#fff), url("sprite.svg#red"); }`,
    `a[href^="#top"] { color: var(--fg); }`,
  ];
  for (const body of clean) assert.deepEqual(offenders(SHEET(body)), [], body);
});

test("a semicolon inside a data URI does not end the declaration or hide what follows", () => {
  const hits = offenders(SHEET(`.a {\n  background: url("data:image/svg+xml;utf8,<svg fill='red'/>");\n  color: #123456;\n}`));
  assert.deepEqual(hits.map((hit) => [hit.declaration.property, hit.literal, hit.declaration.line]), [
    ["background", "red", 7],
    ["color", "#123456", 8],
  ]);
});

test("an unclosed string cannot swallow the rest of the stylesheet into a pass", () => {
  assert.throws(() => offenders(SHEET(`.a { content: "open; }\n.b { color: #fff; }`)), /unclosed string/);
});

test("a reported literal names its selector and its real line", () => {
  const [hit] = offenders(SHEET(".first { color: var(--fg); }\n\n.second {\n  padding: 0;\n  color: #e5534b;\n}"));
  assert.ok(hit, "the literal was not reported");
  assert.equal(hit.declaration.selector, ".second");
  assert.equal(hit.declaration.line, 10);
});
