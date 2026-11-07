---
name: mockups
description: Write every requested mock-up as a renderable file in the session's own checkout, in a git-ignored docs/mockups/ so it is never committed unless a plan needs it, and present its checkout-relative path on its own line, so Mission Control links it to the Files viewer and previews it inline in the conversation. Use whenever someone asks for mock-ups, mockups, mock ups, wireframes, UI sketches, screen designs, design comps, or visual concepts of an interface, including mock-ups that accompany a plan.
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

## Always: write each mock-up into the checkout, and keep it out of git

1. **In the session's own checkout, under `docs/mockups/<slug>/`**, where `<slug>` is a
   kebab-case name for the subject (`settings-panel`, `retry-banner`). Never in `/tmp`, a
   scratchpad, your home directory, or another worktree: the conversation links and previews
   only files inside this session's checkout.
2. **Make `docs/mockups/` ignore itself before writing the first one:**

   ```sh
   mkdir -p docs/mockups && { [ -e docs/mockups/.gitignore ] || printf '*\n' > docs/mockups/.gitignore; }
   ```

   When the marker is the one this command wrote, it ignores the whole directory, itself
   included: nothing in it shows in `git status`, `git add -A` stages none of it, and a
   workflow's review snapshot leaves it out, so a "commit everything that was reviewed" step
   cannot carry a mock-up into a pull request. A repository's own `docs/mockups/.gitignore`
   is left as it is and may not ignore anything, so the marker alone proves nothing; step 3's
   check does. Mission Control still lists the HTML pages and images in `docs/mockups/` in
   Files, links their paths and previews them. It is the one ignored directory it does that
   for, and only for those formats, so a mock-up anywhere else that git ignores, or in
   another format, renders as dead text.
3. **Confirm each path is ignored before you write it.** A mock-up git does not ignore can
   be swept into a commit, so this check is not optional:

   ```sh
   git check-ignore -q docs/mockups/settings-panel/two-column.html || echo "not ignored"
   ```

   If that prints `not ignored`, the repository has its own rules for `docs/mockups/`. Add
   the directory to this checkout's local exclude file, which git never commits or shares,
   then run the check again:

   ```sh
   f="$(git rev-parse --git-path info/exclude)" && mkdir -p "$(dirname "$f")" && { grep -qx 'docs/mockups/' "$f" 2>/dev/null || printf 'docs/mockups/\n' >> "$f"; }
   ```

   If it still prints `not ignored`, the repository tracks that exact file. Choose another
   name and check that one. Never write or hand over a mock-up at a path git does not
   ignore.
4. **One file per mock-up or variant**, named for what it shows
   (`two-column.html`, `tabs.html`), not `mockup1.html`. Put variants of one subject in the
   same directory so they sit together in Files.
5. **Never commit a mock-up, unless it is necessary to a plan.** That is the only exception,
   and the next section says how. Not because it exists, not because a step says to commit
   everything, not because it is good work. A mock-up is for looking at; the change it
   informs is what ships.

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

**Verify before you hand over.** Immediately before the message that presents the mock-ups,
check every `docs/mockups/` path you are about to name, and that git has nothing to commit
under `docs/mockups/`:

```sh
for p in docs/mockups/settings-panel/two-column.html docs/mockups/settings-panel/tabs.png; do git check-ignore -q "$p" || echo "not ignored: $p"; done; git status --porcelain --untracked-files=all -- docs/mockups
```

It must print nothing. Anything it prints is a mock-up a commit could pick up: fix it with
step 3 above before you present anything. The one path this check does not cover is a
mock-up a plan needs, which lives beside the plan outside `docs/mockups/` and is meant to be
committed with it; the next section says what to confirm for that one instead.

In that message, name each one like this:

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

A mock-up is committed only when it is part of a plan kept in the repository and the plan
needs it: the plan links to it, or its design is argued from it. That one moves out of
`docs/mockups/` and sits beside the plan's `plan.md` in `docs/plans/<name>/`, which is not
ignored. Link it from the plan's own HTML with a relative href
(`<a href="two-column.html">`), present it in the conversation as above, and commit it with
the plan. It is not ignored on purpose, so leave it out of the hand-over check: before you
present it, confirm instead that it sits in the plan's own directory and that the plan links
it. A mock-up that fails either test is not part of the plan, so it goes back to
`docs/mockups/`. A reviewer reading the plan and a reader scrolling the session then reach the same
file.

Everything else stays in `docs/mockups/` and uncommitted: the variants the plan rejected,
sketches made while exploring, and every mock-up for a plan stored outside the repository.
