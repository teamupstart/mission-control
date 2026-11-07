---
name: mockups
description: Write every requested mock-up as a renderable file in the session's own checkout and present its checkout-relative path on its own line, so Mission Control links it to the Files viewer and previews it inline in the conversation. Use whenever someone asks for mock-ups, mockups, mock ups, wireframes, UI sketches, screen designs, design comps, or visual concepts of an interface, including mock-ups that accompany a plan.
metadata:
  mission:
    category: design
    enforcement: triggered
---

# Mock-ups

A mock-up described in chat, drawn in a fenced block of box characters, or written to
`/tmp` is a mock-up the person asking cannot look at. They asked to see something. Make
it a file they can open: put it in the checkout, name its path in the conversation, and
let the dashboard show it.

In a Mission Control session that hand-off does two things. A checkout-relative path in a
turn becomes a link that opens the file in the session's **Files** tab, rendered rather
than as source. And when the path is an HTML page or an image presented on its own line,
the conversation also previews it at the foot of that turn, so the mock-up is visible
without a click. Both depend on the file being in the session's own checkout and on the
path being written the way this skill says.

## When this applies

Whenever the ask is to show what something could look like: a mock-up, mockup, mock up,
wireframe, UI sketch, screen design, design comp, layout option, or visual concept, for a
whole page or one control. It applies equally when the mock-ups are part of a larger piece
of work, such as a plan that needs a picture of the screen it proposes.

Not for: proof that shipped UI works. A screenshot of the running app taken as evidence for
a review is evidence, and it follows the repository's evidence rules instead.

## Always: write each mock-up into the checkout

1. **In the session's own checkout.** Use `docs/mockups/<slug>/`, where `<slug>` is a
   kebab-case name for the subject (`settings-panel`, `retry-banner`). When the mock-ups
   belong to a plan kept in the repository, put them beside its `plan.md` instead. Never in
   `/tmp`, a scratchpad, your home directory, or another worktree: the conversation links
   and previews only files inside this session's checkout.
2. **Never under an ignored path.** The Files list and the conversation's links are built
   from the checkout's tracked and untracked files, and ignored files are in neither, so a
   mock-up written there renders as dead text. Check before you hand it over:

   ```sh
   git check-ignore -q docs/mockups/settings-panel/two-column.html && echo ignored
   ```

   If that prints `ignored`, move the file.
3. **One file per mock-up or variant**, named for what it shows
   (`two-column.html`, `tabs.html`), not `mockup1.html`. Put variants of one subject in the
   same directory so they sit together in Files.
4. **Leave it untracked** unless the person asks you to commit it or the work you are
   delivering ships it. A mock-up existing in the checkout is not a reason to commit it.

## Always: make it a format the conversation renders

Two formats preview inline. Prefer HTML.

- **HTML (`.html`).** Previewed as a live page in the conversation and full-size in Files.
  - **Self-contained.** CSS in one `<style>`, images as `data:` URIs, no request of any
    kind. No CDN for fonts, CSS, icons, or a framework - the preview has no network, so a
    page styled by a CDN stylesheet renders unstyled.
  - **No JavaScript.** The preview is a sandboxed frame that runs no script of the page's
    own, so a page that builds itself at runtime is blank. Show states side by side, or
    use `<details>`, `:hover` and `:focus-within` for the little interaction a mock-up
    needs.
  - **The one exception is a stylesheet in the checkout.** A relative
    `<link rel="stylesheet" href="...">` to a stylesheet in this checkout (under 2 MiB) is
    inlined by the preview, so a mock-up of the product can be drawn with the product's
    real styles. The href resolves against the mock-up's own directory: from
    `docs/mockups/<slug>/`, the checkout root is `../../../`.
  - **Set the page's own background and text colour on `body`.** The preview sits inside
    the dashboard, usually on a dark surface, and a page that leaves its background to the
    browser can arrive as a white slab. When you are drawing the product, use its look.
- **Images (`.png`, `.svg`, `.webp`, `.gif`, `.jpg`, `.jpeg`, `.avif`, `.apng`, `.bmp`,
  `.ico`).** Previewed scaled to fit the conversation's card, and full-size in Files. Use
  one when the mock-up is a picture: an SVG wireframe, or a PNG you rendered from an HTML
  mock-up. An SVG is displayed as an image, so it runs no script and loads nothing
  external: embed what it needs.

Keep each file under 5 MiB, the preview limit. Anything else - Markdown, plain text, a box
drawing in chat, a link to a design tool - does not preview inline. A quick sketch in chat
is fine for an idea; when someone asks for a mock-up, make the file.

## Always: present each path on its own line

In the message that finishes the work, after the files exist, name each one like this:

```
Mockup: docs/mockups/settings-panel/two-column.html
Mockup: docs/mockups/settings-panel/tabs.png
```

That exact shape is what the conversation looks for, and anything looser stays a plain
link or plain text:

- **Checkout-relative.** No leading `/`, no `~`, no `file://`, no absolute path.
- **Its own line.** The path alone, or a short label of letters and spaces, a colon, then
  the path: `Mockup:`, `Variant B:`, `Screenshot:`. A label with a digit in it
  (`Option 2:`), a list marker in front (`- `, `1. `), or backticks, quotes or bold around
  the path all disqualify the line from the inline preview.
- **Or a Markdown link**, which qualifies anywhere, including inside a list:
  `[Two-column layout](docs/mockups/settings-panel/two-column.html)`. Use
  `[label](<path with spaces.html>)` for a path containing a space.
- **At most three previews per message.** A fourth path and beyond still links but is not
  previewed. With more variants than that, put them side by side in one `variants.html`
  and present that page, or present the three that matter most first.

Around those lines, say in a sentence or two what each mock-up shows and how the variants
differ. Do not paste the HTML or SVG source into the conversation as well - the preview is
right there.

When you revise a mock-up, write it to the same path and present the path again in the
turn that describes the change, so the new version is previewed where the conversation
talks about it. A new variant gets a new file.

## Mock-ups that accompany a plan

Put them beside the plan in the repository, link each from the plan's own HTML with a
relative href (`<a href="two-column.html">`), and present them in the conversation as above
as well. A reviewer reading the plan and a reader scrolling the session should both reach
the same file.
