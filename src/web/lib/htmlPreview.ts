import { workspaceAssetPath } from "./workspaceLinks.ts";

/**
 * The dashboard's ONE sandboxed HTML preview boundary.
 *
 * Two surfaces render untrusted HTML: the Files tab, showing a page out of a live checkout,
 * and Scouts, showing `report/report.html` out of an immutable archive. They share this
 * module rather than each carrying a copy, because the thing being shared is a security
 * policy - and a security policy that exists twice is a security policy that stops agreeing
 * with itself the first time only one copy is edited.
 *
 * The contract both surfaces get:
 *
 * - `default-src 'none'` with `connect-src 'none'`, so a previewed document reaches nothing.
 * - `script-src` naming exactly four SHA-256 hashes, so the ONLY JavaScript that can run is
 *   the four bridge scripts below. `allow-scripts` on the iframe is what lets those run; the
 *   document's own `<script>` is blocked by the hash allowlist, not by the sandbox.
 * - No `allow-same-origin`, ever. The pair `allow-scripts allow-same-origin` would let a
 *   previewed page reach into the dashboard origin and undo the whole boundary.
 * - Every non-fragment navigation is claimed by the parent (see `PREVIEW_LINK_SCRIPT`).
 *
 * A caller may not weaken any of this for its own documents. Scouts in particular must not
 * relax it to make an archived report render: an archive is untrusted input that may have
 * been copied in from another machine.
 *
 * Every bridge here is the SAME capability, four times: it reads the document it is already
 * inside and posts a message to the parent that sent it. None of them fetches, navigates,
 * writes, or reaches the dashboard origin, and none of them is granted a token. A bridge
 * that needed one would be a bridge that does not belong here.
 *
 * The find bridge adds one further rule of its own, for a reason particular to this module:
 * it does not INSERT anything into the previewed document. The comment bridge addresses a
 * block by element index, so a `mark` element wrapped around a match would shift those
 * indices and make a later comment anchor to a neighbour. See `PREVIEW_FIND_SCRIPT`.
 */

const PREVIEW_SCROLL_MESSAGE = "mission:file-preview-scroll";
const PREVIEW_TARGET_MESSAGE = "mission:file-preview-target";
const PREVIEW_KEYBOARD_MESSAGE = "mission:file-preview-keyboard";
const PREVIEW_SCROLL_SCRIPT = `let missionKeyboard=false;let missionTarget=null;function missionJump(path){if(!Array.isArray(path))return;let node=document.body;for(const step of path){if(!step||!Number.isInteger(step.index)||typeof step.tag!=="string")return;const child=node.children.item(step.index);if(!child||child.tagName.toLowerCase()!==step.tag)return;node=child}if(missionTarget)missionTarget.classList.remove("mission-comment-target");missionTarget=node;missionTarget.classList.add("mission-comment-target");missionTarget.scrollIntoView({block:"center",behavior:"smooth"})}addEventListener("message",event=>{if(event.source===parent){if(event.data?.type==="${PREVIEW_SCROLL_MESSAGE}"&&typeof event.data.top==="number"){scrollBy({top:event.data.top});return}if(event.data?.type==="${PREVIEW_TARGET_MESSAGE}"){missionJump(event.data.path);return}if(event.data?.type==="${PREVIEW_KEYBOARD_MESSAGE}")missionKeyboard=event.data.enabled===true}});document.addEventListener("keydown",event=>{if(!missionKeyboard)return;const plain=!event.altKey&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey;const typing=event.target instanceof Element&&Boolean(event.target.closest("input,textarea,select")||event.target instanceof HTMLElement&&event.target.isContentEditable);if(plain&&(event.key==="u"||event.key==="d")&&!typing){event.preventDefault();event.stopImmediatePropagation();scrollBy({top:(event.key==="d"?1:-1)*innerHeight});return}if(event.key==="Tab"){event.preventDefault();event.stopImmediatePropagation();if(event.shiftKey)parent.postMessage({type:"${PREVIEW_KEYBOARD_MESSAGE}",action:"exit"},"*");return}if(event.key==="Escape"){event.preventDefault();event.stopImmediatePropagation();parent.postMessage({type:"${PREVIEW_KEYBOARD_MESSAGE}",action:"exit"},"*")}},true)`;
const PREVIEW_SCROLL_SCRIPT_HASH = "0rx/acSQDoPQ3ODCtWXGEXkbl+oeGSA2rro56BhxnEk=";
/**
 * What counts as a block, decided by the layout the browser actually produced.
 *
 * This used to be a list of tag names, and a list is the wrong shape for the question. It
 * is never finished - `form`, `fieldset`, `address` and `dialog` were all missing from it,
 * and any list would keep missing whatever it had not thought of. Worse, it cannot see a
 * `span` the document styled `display:block`, which reads to a person as a block and is a
 * perfectly reasonable thing to point at. The preview renders arbitrary checkout HTML,
 * including hand-written documents and whatever a generator emitted, so "anything I
 * enumerated" and "anything that reads as a block on screen" are not the same set.
 *
 * `getComputedStyle().display` answers the real question. Anything that is not `inline`,
 * `contents` or `none` establishes a box a reader can see and aim at - which takes in
 * `block`, `flex`, `grid`, `list-item`, `table-cell`, `table-row`, every `inline-block`
 * variant, and every element a stylesheet made into one of those. `none` is excluded
 * because a block nobody can see is not a block anybody can hover.
 *
 * The walk stops at the innermost such ancestor, so a click inside a `td` anchors to the
 * cell and a click in a nested `p` anchors to that paragraph rather than the section
 * around it. `body` bounds it: the whole document is not a block to comment on.
 *
 * SVG is the one case decided by tag rather than by display, deliberately. An `svg` element
 * computes to `inline`, and its internals - `path`, `g`, `rect` - are not blocks in the CSS
 * sense at all, so display alone would either skip the diagram entirely or offer its
 * individual strokes as targets. A diagram is one thing a person points at, so anything
 * inside one resolves to the `svg` itself.
 */
/**
 * The third bridge: while the parent has comment mode ON, a click reports which BLOCK was
 * clicked, as a structural path through the tree the browser built.
 *
 * It is inert until enabled, and only the parent that owns the frame can enable it - the
 * same `event.source===parent` test the scroll bridge uses. Scouts never sends that
 * message, so an archived report behaves exactly as it did before this existed.
 *
 * **It gains no capability the other two lack.** It reads the document it is already
 * inside and posts to the parent that sent it. It fetches nothing, navigates nothing,
 * writes nothing, and carries no token; `allow-same-origin` remains absent.
 *
 * **What it reports is a PATH, never text.** The DOM text of `<p>Read <strong>this</strong></p>`
 * is `Read this`, which appears nowhere in the source, so a resolver that searched the
 * source for a block's words would refuse most real blocks while passing a demo. The path
 * indexes element children from `document.body` down, and the parent resolves it against a
 * parse5 tree of the same source - the one parser that performs HTML5 tree construction, so
 * an implicit `<tbody>` is in both trees or neither. The tag name rides along at every step
 * purely so a resolution that has drifted is REFUSED rather than silently landing on a
 * neighbour.
 *
 * From `document.body` rather than from the document root, and that is what keeps this
 * independent of everything injected above: the CSP meta and all three of these scripts land
 * in `<head>`, and so does a `<link>` this module rewrote into a `<style>`. None of that can
 * shift a body path by one.
 *
 * **It announces itself when it is ready, and that is what removes the arming race.** The
 * parent cannot know when a `srcdoc` document has finished running its scripts: a load event
 * can fire for the `about:blank` that precedes the real document, and an arm message posted
 * a moment early reaches a window with no listener and is simply lost - leaving comment mode
 * ON in the toolbar and OFF inside the frame, where a click does nothing and says nothing.
 * So the LAST thing this script does is tell the parent it exists, and the parent replies
 * with the current state. Ordering stops being a question anybody has to get right.
 *
 * The ping goes to Scouts too, which ignores it - it only ever acts on the link message.
 *
 * The click is swallowed whole while comment mode is on - `stopImmediatePropagation` before
 * the link bridge, which is registered after this one for exactly that reason. Clicking a
 * paragraph that happens to contain a link is a comment on the paragraph, not navigation.
 *
 * **It marks the hovered block itself rather than leaving that to a CSS rule.** The rule it
 * replaced restated the block definition a second time, in a selector, and the two had to
 * agree or the outline would sit on a different element from the one a click would take -
 * silently, since both halves still work. Now `missionBlock` is the only answer to "which
 * block is this", and the hover and the click ask it the same way. It also lets the
 * affordance follow a definition a selector cannot express at all: computed display.
 *
 * NO LITERAL `<` ANYWHERE IN THIS BODY. `test/html-preview.test.ts` extracts each script
 * with `/<script>([^<]+)<\/script>/g` to recompute its hash, so one comparison operator
 * would truncate this script's body and fail there - which is the loud version. The quiet
 * version is a bridge whose hash no longer matches and that therefore never runs at all.
 */
const PREVIEW_COMMENT_MESSAGE = "mission:file-preview-comment";
const PREVIEW_BLOCK_MESSAGE = "mission:file-preview-block";
const PREVIEW_READY_MESSAGE = "mission:file-preview-ready";
const PREVIEW_COMMENT_SCRIPT = `let missionCommenting=false;let missionMarked=null;function missionBlock(node){let el=node instanceof Element?node:null;while(el&&el!==document.body){if(el.tagName.toLowerCase()==="svg")return el;if(el.namespaceURI!=="http://www.w3.org/2000/svg"){const shown=getComputedStyle(el).display;if(shown!=="inline"&&shown!=="contents"&&shown!=="none")return el}el=el.parentElement}return null}function missionMark(el){if(missionMarked===el)return;if(missionMarked)missionMarked.classList.remove("mission-comment-block");missionMarked=el;if(el)el.classList.add("mission-comment-block")}addEventListener("message",event=>{if(event.source!==parent||event.data?.type!=="${PREVIEW_COMMENT_MESSAGE}")return;missionCommenting=event.data.enabled===true;document.documentElement.classList.toggle("mission-comment-mode",missionCommenting);if(!missionCommenting)missionMark(null)});document.addEventListener("mouseover",event=>{if(!missionCommenting)return;missionMark(missionBlock(event.composedPath()[0]))},true);document.addEventListener("mouseout",event=>{if(!event.relatedTarget)missionMark(null)},true);document.addEventListener("click",event=>{if(!missionCommenting)return;event.preventDefault();event.stopImmediatePropagation();const block=missionBlock(event.composedPath()[0]);if(!block||!document.body.contains(block))return;const path=[];let node=block;while(node!==document.body){const owner=node.parentElement;if(!owner)return;path.unshift({index:[...owner.children].indexOf(node),tag:node.tagName.toLowerCase()});node=owner}parent.postMessage({type:"${PREVIEW_BLOCK_MESSAGE}",path},"*")},true);parent.postMessage({type:"${PREVIEW_READY_MESSAGE}"},"*")`;
const PREVIEW_COMMENT_SCRIPT_HASH = "E9uJHE7aVw0AWiMsFk0PxXrh8C4oaVMrpGEYB7ux98Y=";

/**
 * The hover affordance, gated on the two classes only the bridge above ever sets.
 *
 * Inside the frame because that is the only place it can be: the parent cannot draw on a
 * document it has no origin for. `style-src 'unsafe-inline'` already permits it, so this
 * adds no policy, and with comment mode off both classes are absent and every rule here is
 * dead weight a previewed document never notices.
 *
 * There is no block selector here on purpose. The bridge decides which element is the block
 * and puts `mission-comment-block` on that one element, so exactly one box is ever outlined
 * and it is always the one a click would take. Expressing that in CSS would mean repeating
 * the definition and then keeping `:hover:not(:has(...))` in step with it - and computed
 * display, which is what the definition now rests on, cannot be written as a selector.
 */
const PREVIEW_COMMENT_STYLE = `html.mission-comment-mode,html.mission-comment-mode *{cursor:crosshair}html.mission-comment-mode .mission-comment-block{outline:2px solid #6ea8fe;outline-offset:2px;background:rgba(110,168,254,0.12)}.mission-comment-target{outline:2px solid #5dd6c0;outline-offset:3px;background:rgba(93,214,192,0.12)}`;

/**
 * Every anchor click leaves the document through the parent, or not at all.
 *
 * A srcdoc document resolves relative hrefs against the DASHBOARD's URL, so letting one
 * navigate turns `<a href="b.html">` into a request the daemon answers with the SPA
 * fallback - a second dashboard shell inside the sandbox, whose assets the opaque origin
 * then CORS-blocks into a white pane. The `navigate-to` CSP directive that was meant to
 * stop this never shipped in any browser. So navigation is claimed here instead: every
 * non-fragment click is cancelled and its href posted up, and the parent decides whether
 * it names a checkout file worth selecting. Fragment links are cancelled and scrolled by
 * the bridge so Chromium cannot replace the sandboxed srcdoc with an empty document; an
 * empty fragment preserves the browser's conventional scroll-to-top behavior explicitly.
 *
 * `composedPath` rather than `target.closest`, because a click inside an open shadow root
 * retargets to the host and a missed anchor here is not a dead link - it is the default
 * navigation going through, which is the white pane again.
 *
 * What the parent DOES with the href differs per surface and is not this module's business:
 * Files resolves it against the checkout, and Scouts resolves it only to a verified report
 * companion artifact, leaving every unclaimed link inert.
 */
const PREVIEW_LINK_MESSAGE = "mission:file-preview-link";
const PREVIEW_LINK_SCRIPT = `document.addEventListener("click",event=>{const origin=event.composedPath()[0];const anchor=origin instanceof Element?origin.closest("a[href]"):null;if(!anchor)return;const href=anchor.getAttribute("href");if(!href)return;event.preventDefault();if(href.startsWith("#")){const raw=href.slice(1);if(!raw){scrollTo({top:0});return}let id=raw;try{id=decodeURIComponent(raw)}catch{}(document.getElementById(id)||[...document.getElementsByName(id)].find(target=>target instanceof HTMLAnchorElement))?.scrollIntoView();return}parent.postMessage({type:"${PREVIEW_LINK_MESSAGE}",href},"*")},true)`;
const PREVIEW_LINK_SCRIPT_HASH = "0DQ6IkD0vFcUQsY+X6LP861dP2RW9HXIVdbSAi5MkBk=";

/**
 * The fourth bridge: find inside the preview, over the text a reader can actually see.
 *
 * The Files workspace can count and mark matches in a Markdown preview and in the Editor
 * because it owns their DOM. It owns nothing here, so before this bridge existed an HTML
 * match was located BY BLOCK: counted over the file's source, resolved to a structural path
 * by the daemon, and revealed with `PREVIEW_TARGET_MESSAGE`. That count includes text the
 * rendered page never shows - a link `href`, a `style` body, a `display:none` aside - which
 * breaks the one invariant this feature rests on: every counted match is one a person can
 * see and step to. This bridge takes the count back from the source and gives it to the
 * frame, which is the only context that knows what it painted.
 *
 * **It inserts nothing into the document, and that is not a preference.** The comment bridge
 * addresses a block by indexing element children from `document.body`, and the daemon
 * resolves that same path against a parse5 tree of the source. Wrapping matches in `mark`
 * elements would shift those indices, so a comment anchored after a highlight would resolve
 * to a neighbour - silently. Highlighting therefore goes through the CSS Custom Highlight
 * API: `Range` objects registered in `CSS.highlights` and painted by the `::highlight()`
 * rules in `PREVIEW_FIND_STYLE`. Not one node is created, moved or classed.
 *
 * **It gains no capability the other three lack.** It reads the document it is already
 * inside and posts to the parent that sent it. No fetch, no navigation, no storage, no
 * token, and `allow-same-origin` remains absent. The find message is gated on
 * `event.source===parent`, exactly as the scroll and comment bridges gate theirs.
 *
 * **It announces its OWN readiness, and never leans on the comment bridge's.**
 * `PREVIEW_READY_MESSAGE` is posted as the comment bridge's last act, and that guarantee is
 * about the script that sends it: the comment bridge is injected second, so a fourth script
 * announced by it would be announced before it had run. The parent's first find message
 * would reach a window with no find listener and be lost, and nothing would highlight until
 * the reader edited the query. So this script posts `PREVIEW_FIND_READY_MESSAGE` as its own
 * last statement and the parent replies with the current query, case flag and index - the
 * same arm-on-ready handshake `armFrame` already performs. One handshake covers find opened
 * before the document loaded, find already open when an HTML file is selected, and the
 * `srcDoc` reload that follows every edit.
 *
 * **Readiness carries CAPABILITY, because incapacity is not a result.** A frame without the
 * Custom Highlight API cannot mark anything, and answering a matching query with a count of
 * zero would leave the reader with no highlight, no block reveal and a number claiming there
 * is nothing to find. So `highlight` rides on the ready message, and the parent keeps the
 * block-reveal fallback and its "by block" note unless that flag is true.
 *
 * **Only text the frame can paint is counted**, through three gates in this order:
 *
 * 1. *By container.* `script`, `style`, `template`, `title` and `noscript` hold ordinary text
 *    nodes, and `inlinePreviewStyles` rewrites a checkout `link` into a `style` element
 *    WHEREVER that link sat - so CSS text can appear in the body, not only in the head. Their
 *    contents are never descended into. Comment nodes are not text nodes and are skipped by
 *    the node-type test.
 * 2. *By visibility, with the flags spelled out.* `Element.checkVisibility()` does NOT
 *    consider `visibility:hidden` or `opacity:0` by default - it answers `true` for both - so
 *    the bare call would pass exactly the text this bridge promises to exclude. Both the
 *    current and the original option spellings are passed, because unknown dictionary members
 *    are ignored and the two names shipped at different times. Where the method is absent the
 *    fallback reads the nearest element's OWN computed `visibility`, which is the right
 *    question rather than a convenience: `visibility` inherits, and a descendant may
 *    re-assert `visible` inside a hidden subtree, so an ancestor scan would wrongly drop text
 *    a reader can see.
 * 3. *By paintable geometry.* A candidate `Range` with no client rects generates no box, so
 *    it cannot be highlighted and must not be counted. This is NOT a paintedness test and is
 *    not trusted as one - `visibility:hidden` and `opacity:0` text is laid out and returns
 *    rects, which is precisely why gate 2 carries its own flags.
 *
 * **The match is made over RUNS, not node by node.** `foo<strong>bar</strong>` searched for
 * `foobar` finds nothing node by node while the reader sees one continuous word, so eligible
 * text nodes are joined into a run and matched as one string. A run breaks at every VISIBLE
 * separation: a `br` (a line break with no text node of its own, so `foo<br>bar` must not
 * match `foobar`), and any element that establishes its own box - asked as
 * `missionBlock(node)===node`, so this bridge and the comment bridge answer "is this one box
 * of text" with the same definition rather than each keeping a tag list. A node the gates
 * excluded for occupying NO space (`display:none`, a `script` body) does not break the run,
 * because that text is absent from what the reader sees and the visible characters either
 * side really are adjacent; a node excluded while still occupying space
 * (`visibility:hidden`) DOES break it, because it leaves a visible gap.
 *
 * Run breaks are therefore driven by a VISIBILITY TRANSITION (`lit!==shown`) as much as by a
 * box, which is what keeps those two rules consistent now that the walk descends into a hidden
 * subtree rather than stopping at it: entering one breaks the run, and a paragraph that
 * re-asserts `visible` inside it is broken away on both sides, because the gap surrounds it.
 *
 * `missionBlock` is called rather than copied, and the cross-script reference is safe in
 * either injection order: function declarations are hoisted per script at execution, and
 * this bridge only calls it from a message handler that runs long after all four scripts
 * have. Nothing here keys off another script's ready message.
 *
 * **One logical hit is one `Range`**, even when its ends lie in different text nodes - a
 * Range spans element boundaries natively and the API paints every fragment - and the
 * reported count is logical hits, never the number of ranges' client rects, both of which
 * are larger for a hit that wraps a line. That is the same rule the Markdown adapter
 * follows, for the same reason: a count that can disagree with the highlights is the defect
 * this bridge exists to remove.
 *
 * **It forwards the find chord**, because a keystroke inside a sandbox never reaches the
 * parent: the scroll bridge forwards only Tab and Escape. `preventDefault` runs before the
 * message is posted so the host browser's own find does not open over the dashboard. The
 * chord is a named message rather than an implied side effect - without a wire format the
 * keystroke stays lost.
 *
 * That forwarding is INERT until the parent has sent a find message, exactly as the keyboard
 * bridge is inert until armed, and for a sharper reason than symmetry: Scouts shares this
 * module and never sends one. An unconditional handler would cancel Cmd+F inside an archived
 * report and post it to a parent that ignores it, leaving a reader of a Scouts report with no
 * find at all - the browser's own having been swallowed. The Files preview is armed by the
 * workspace's first post, which happens on mount and again on the ready handshake, so it is
 * armed long before anyone can press the chord.
 *
 * The runs are rebuilt on every find message rather than cached. A previewed document is
 * static - no script of its own can run - but computed visibility is not: comment mode
 * toggles classes, and `content-visibility:auto` answers differently as the reader scrolls.
 * A cache would be a second source of truth about what is on screen.
 *
 * NO LITERAL `<` ANYWHERE IN THIS BODY, for `PREVIEW_COMMENT_SCRIPT`'s reason: the hash test
 * extracts each script with `/<script>([^<]+)<\/script>/g`, so one comparison operator would
 * truncate this body. Hence `part.to>at` rather than `at<part.to`, and `i!==ranges.length`
 * rather than `i<ranges.length` - which terminates identically for a counter stepping by one.
 */
const PREVIEW_FIND_MESSAGE = "mission:file-preview-find";
const PREVIEW_FIND_RESULT_MESSAGE = "mission:file-preview-find-result";
const PREVIEW_FIND_READY_MESSAGE = "mission:file-preview-find-ready";
const PREVIEW_FIND_CHORD_MESSAGE = "mission:file-preview-find-chord";
const PREVIEW_FIND_HIGHLIGHT = "mission-find";
const PREVIEW_FIND_CURRENT_HIGHLIGHT = "mission-find-current";
const PREVIEW_FIND_SCRIPT = `let missionFindArmed=false;let missionFindQuery="";let missionFindCase=false;let missionFindRanges=[];const missionFindSkip=["script","style","template","title","noscript"];function missionFindCan(){return typeof CSS!=="undefined"&&Boolean(CSS.highlights)&&typeof Highlight==="function"}function missionFindSpace(el){const style=getComputedStyle(el);if(style.display==="none")return"gone";if(typeof el.checkVisibility==="function")return el.checkVisibility({visibilityProperty:true,checkVisibilityCSS:true,opacityProperty:true,checkOpacity:true,contentVisibilityAuto:true})?"shown":"hidden";return style.visibility==="visible"?"shown":"hidden"}function missionFindRuns(){const runs=[];let run=null;const add=(node,text)=>{if(!run){run={text:"",parts:[]};runs.push(run)}run.parts.push({node,at:run.text.length,to:run.text.length+text.length});run.text+=text};const cut=()=>{run=null};const walk=(holder,shown)=>{for(const node of holder.childNodes){if(node.nodeType===3){if(shown&&node.data)add(node,node.data);continue}if(node.nodeType!==1)continue;const tag=node.tagName.toLowerCase();if(missionFindSkip.includes(tag))continue;const space=missionFindSpace(node);if(space==="gone")continue;if(tag==="br"){cut();continue}const lit=space==="shown";const breaks=lit!==shown||missionBlock(node)===node;if(breaks)cut();walk(node,lit);if(breaks)cut()}};if(document.body)walk(document.body,missionFindSpace(document.body)==="shown");return runs}function missionFindHits(text,re){const out=[];re.lastIndex=0;let m;while((m=re.exec(text))!==null){if(m[0]===""){re.lastIndex+=1;continue}out.push({at:m.index,to:m.index+m[0].length})}return out}function missionFindRange(run,at,to){const range=document.createRange();let open=false;for(const part of run.parts){if(!open&&part.to>at){range.setStart(part.node,at-part.at);open=true}if(open&&part.to>=to){range.setEnd(part.node,to-part.at);return range}}return null}function missionFindCollect(){if(!missionFindQuery)return[];const re=new RegExp(missionFindQuery.replace(/[.*+?^\${}()|[\\]\\\\]/g,"\\\\$&"),missionFindCase?"g":"gi");const found=[];for(const run of missionFindRuns())for(const hit of missionFindHits(run.text,re)){const range=missionFindRange(run,hit.at,hit.to);if(range&&range.getClientRects().length)found.push(range)}return found}function missionFindRender(current){const rest=new Highlight();const one=new Highlight();for(let i=0;i!==missionFindRanges.length;i++){if(i===current)one.add(missionFindRanges[i]);else rest.add(missionFindRanges[i])}CSS.highlights.set("${PREVIEW_FIND_HIGHLIGHT}",rest);CSS.highlights.set("${PREVIEW_FIND_CURRENT_HIGHLIGHT}",one)}function missionFindShow(current){const range=missionFindRanges[current];if(!range)return;const holder=range.startContainer.parentElement;if(holder)holder.scrollIntoView({block:"nearest",behavior:"instant"});const box=range.getBoundingClientRect();if(!box.height&&!box.width)return;if(box.top>=0&&innerHeight>=box.bottom)return;scrollBy({top:box.top+box.height/2-innerHeight/2,behavior:"instant"})}addEventListener("message",event=>{if(event.source!==parent||event.data?.type!=="${PREVIEW_FIND_MESSAGE}")return;missionFindArmed=true;missionFindQuery=typeof event.data.query==="string"?event.data.query:"";missionFindCase=event.data.caseSensitive===true;if(!missionFindCan())return;missionFindRanges=missionFindCollect();const count=missionFindRanges.length;const asked=Number.isInteger(event.data.index)?event.data.index:0;const current=count?Math.min(Math.max(asked,0),count-1):-1;missionFindRender(current);missionFindShow(current);parent.postMessage({type:"${PREVIEW_FIND_RESULT_MESSAGE}",query:missionFindQuery,caseSensitive:missionFindCase,count,index:current},"*")});document.addEventListener("keydown",event=>{if(!missionFindArmed)return;if(event.key!=="f"&&event.key!=="F")return;if(event.altKey||!event.metaKey&&!event.ctrlKey)return;event.preventDefault();event.stopImmediatePropagation();parent.postMessage({type:"${PREVIEW_FIND_CHORD_MESSAGE}"},"*")},true);parent.postMessage({type:"${PREVIEW_FIND_READY_MESSAGE}",highlight:missionFindCan()},"*")`;
const PREVIEW_FIND_SCRIPT_HASH = "kXZ5FhbjDBH/6STvmyhgKZequtkUH/eVM8svZjJs4jc=";

/**
 * What a found match looks like, in the two weights the dashboard's own marks use.
 *
 * A sibling of `PREVIEW_COMMENT_STYLE` rather than a line inside it, because it belongs to a
 * different bridge and `style-src 'unsafe-inline'` already permits both - so this adds no
 * policy. The colours are the app's `--find` hue written literally: a custom property
 * declared on the dashboard's `:root` means nothing in a separate document.
 *
 * `::highlight()` accepts only `color`, `background-color`, `text-decoration`, `text-shadow`
 * and `-webkit-text-stroke`, so there is no rounding or ring here to match `mark.find-hit`
 * exactly. The two weights - a tint for every hit and the solid hue for the current one - are
 * what a reader actually reads, and those carry across.
 */
const PREVIEW_FIND_STYLE = `::highlight(${PREVIEW_FIND_HIGHLIGHT}){background-color:rgba(227,179,65,0.28);color:inherit}::highlight(${PREVIEW_FIND_CURRENT_HIGHLIGHT}){background-color:#e3b341;color:#10130a}`;
const PREVIEW_CSP =
  "default-src 'none'; connect-src 'none'; script-src "
  + `'sha256-${PREVIEW_SCROLL_SCRIPT_HASH}' 'sha256-${PREVIEW_COMMENT_SCRIPT_HASH}' `
  + `'sha256-${PREVIEW_LINK_SCRIPT_HASH}' 'sha256-${PREVIEW_FIND_SCRIPT_HASH}'; `
  + "style-src 'unsafe-inline'; img-src data: blob:; "
  + "font-src data:; form-action 'none'; navigate-to 'none'";

/** The message a preview posts up when a non-fragment link is clicked inside it. */
export const HTML_PREVIEW_LINK_MESSAGE = PREVIEW_LINK_MESSAGE;
/** The message the parent posts down to scroll a preview it cannot reach into. */
export const HTML_PREVIEW_SCROLL_MESSAGE = PREVIEW_SCROLL_MESSAGE;

/** Ask the opaque HTML preview to reveal a server-resolved structural path. */
export const HTML_PREVIEW_TARGET_MESSAGE = PREVIEW_TARGET_MESSAGE;
/** Keyboard bridge configuration and the exit request posted back by a Files preview. */
export const HTML_PREVIEW_KEYBOARD_MESSAGE = PREVIEW_KEYBOARD_MESSAGE;
/**
 * The message the parent posts down to arm or disarm comment mode inside a preview.
 *
 * Carries `enabled: boolean` and nothing else. There is no "and also" here on purpose: the
 * frame is told whether the reader is commenting, and answers with where they clicked.
 */
export const HTML_PREVIEW_COMMENT_MESSAGE = PREVIEW_COMMENT_MESSAGE;
/** The message a preview posts up when a block is clicked while comment mode is armed. */
export const HTML_PREVIEW_BLOCK_MESSAGE = PREVIEW_BLOCK_MESSAGE;
/**
 * The message a preview posts up once its bridges are live and can be told anything.
 *
 * The parent answers it with the current comment-mode state. Without it the parent is
 * guessing at when a `srcdoc` document finished loading, and a guess that is early loses the
 * message in a window that no longer exists.
 */
export const HTML_PREVIEW_READY_MESSAGE = PREVIEW_READY_MESSAGE;

/**
 * The find state the parent posts down: `query`, `caseSensitive` and `index`.
 *
 * An empty query is the clear - there is no separate message for it, so the frame has one
 * code path and cannot end up highlighting a query the bar no longer holds.
 */
export const HTML_PREVIEW_FIND_MESSAGE = PREVIEW_FIND_MESSAGE;
/**
 * What the frame answers with: `count`, `index`, and the `query`/`caseSensitive` it counted.
 *
 * The query rides along so the parent can drop a reply to a state it has already moved past,
 * and keep showing the number it does have rather than a fresher-looking wrong one.
 */
export const HTML_PREVIEW_FIND_RESULT_MESSAGE = PREVIEW_FIND_RESULT_MESSAGE;
/**
 * The find bridge's own readiness, posted as its last act, carrying `highlight`.
 *
 * NEVER substitute `HTML_PREVIEW_READY_MESSAGE` for this. That one is the comment bridge's,
 * which is injected second, so it cannot speak for a script that has not run yet - and the
 * failure is silent: the first find message reaches a window with no find listener. The
 * parent answers this one with the current find state, which is also what restores the
 * highlight after the `srcDoc` reload that follows every edit.
 *
 * `highlight` is the capability, not a result. False means this frame cannot mark anything,
 * and the parent must keep the block-reveal fallback rather than trust a count of zero.
 */
export const HTML_PREVIEW_FIND_READY_MESSAGE = PREVIEW_FIND_READY_MESSAGE;
/**
 * The reader pressed the find chord with focus inside the preview.
 *
 * A sandbox is a separate browsing context, so the keystroke reaches no dashboard listener.
 * The frame cancels it and posts this instead; the parent must verify `event.source` is its
 * own frame before acting, because this message opens a UI surface.
 */
export const HTML_PREVIEW_FIND_CHORD_MESSAGE = PREVIEW_FIND_CHORD_MESSAGE;

/**
 * The sandbox attribute every preview iframe must carry.
 *
 * Exported as a constant so no call site can quietly add a token. `allow-scripts` alone is
 * what runs the two hashed bridges; adding `allow-same-origin` beside it would hand the
 * previewed document the dashboard's origin.
 */
export const HTML_PREVIEW_SANDBOX = "allow-scripts";

export function htmlPreviewSource(source: string): string {
  // The comment bridge is injected BEFORE the link bridge, and the order is the behaviour:
  // both listen on `document` in the capture phase, listeners run in registration order, and
  // `stopImmediatePropagation` only reaches the ones registered after. A paragraph containing
  // a link therefore takes a comment while comment mode is on, instead of navigating.
  //
  // The find bridge is injected LAST, and nothing depends on that position: it announces its
  // own readiness rather than borrowing the comment bridge's, and its one cross-script call
  // (`missionBlock`) happens inside a message handler, long after every script has run.
  const headContent = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`
    + `<style>${PREVIEW_COMMENT_STYLE}</style>`
    + `<style>${PREVIEW_FIND_STYLE}</style>`
    + `<script>${PREVIEW_SCROLL_SCRIPT}</script>`
    + `<script>${PREVIEW_COMMENT_SCRIPT}</script>`
    + `<script>${PREVIEW_LINK_SCRIPT}</script>`
    + `<script>${PREVIEW_FIND_SCRIPT}</script>`;
  // This prefix must be parsed before a single checkout-controlled byte. Searching
  // for <head> is unsafe: a match inside an HTML comment can absorb the CSP and bridge,
  // after which `allow-scripts` would run the document's own JavaScript unrestricted.
  // The HTML parser supplies the implicit html/head elements here; a later doctype or
  // explicit head in a complete source document is harmless and cannot precede this CSP.
  return `<!doctype html>${headContent}${source}`;
}

interface StylesheetLink {
  index: number;
  length: number;
  path: string;
}

const MAX_PREVIEW_STYLESHEETS = 32;
const PREVIEW_STYLESHEET_CONCURRENCY = 4;

function htmlAttribute(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(
    // The backtick is written as \u0060 rather than literally: this is a template
    // literal, and a bare backtick would end it early.
    `\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\u0060]+))`,
    "i",
  ));
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : null;
}

function escapeHtmlAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

/** Find checkout-local stylesheet links without treating remote CSS as readable workspace data. */
function localStylesheets(source: string, documentPath: string): StylesheetLink[] {
  const found: StylesheetLink[] = [];
  for (const match of source.matchAll(/<link\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)) {
    if (match.index == null) continue;
    const tag = match[0];
    const rel = htmlAttribute(tag, "rel") ?? "";
    if (!rel.split(/\s+/).some((part) => part.toLowerCase() === "stylesheet")) continue;
    const href = htmlAttribute(tag, "href");
    const path = href ? workspaceAssetPath(href, documentPath) : null;
    if (path) found.push({ index: match.index, length: tag.length, path });
  }
  return found;
}

/**
 * Inline local CSS before an HTML document enters its opaque sandbox.
 *
 * A srcDoc document otherwise resolves `theme.css` against the dashboard URL, which is
 * neither the checkout nor a file-serving endpoint. Keeping style-src inline-only is the
 * useful security boundary, so local CSS is read through the same contained session-file
 * API as the document and embedded rather than granting the iframe network access.
 *
 * The FILES tab needs this; Scouts does not, because a scout report is required at capture
 * time to be self-contained with inline CSS and is refused if it is not. It stays here
 * beside the boundary it exists to preserve rather than moving back into the Files
 * component, so the whole "how does untrusted HTML get rendered" story is one file.
 */
export async function inlinePreviewStyles(
  source: string,
  documentPath: string,
  read: (path: string) => Promise<string | null>,
  signal?: AbortSignal,
): Promise<string> {
  const links = localStylesheets(source, documentPath);
  if (links.length === 0) return source;
  const paths = [...new Set(links.map((link) => link.path))].slice(0, MAX_PREVIEW_STYLESHEETS);
  const css = new Map<string, string | null>();
  let cursor = 0;
  await Promise.all(Array.from(
    { length: Math.min(PREVIEW_STYLESHEET_CONCURRENCY, paths.length) },
    async () => {
      while (!signal?.aborted) {
        const path = paths[cursor++];
        if (!path) return;
        css.set(path, await read(path));
      }
    },
  ));
  if (signal?.aborted) return source;
  let output = "";
  cursor = 0;
  for (let i = 0; i < links.length; i++) {
    const link = links[i]!;
    output += source.slice(cursor, link.index);
    const text = css.get(link.path);
    if (text != null) {
      const safe = text.replace(/<\/style/gi, "<\\/style");
      output += `<style data-mission-source="${escapeHtmlAttribute(link.path)}">\n${safe}\n</style>`;
    }
    cursor = link.index + link.length;
  }
  return output + source.slice(cursor);
}
