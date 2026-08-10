# The Library

Mission Control keeps its three primary pages in one segmented top bar control:
**▦ Fleet / ⌗ Library / ▷ Runs**. Fleet shows the sessions doing the work, **Library** holds
everything you author once and reuse, and **Runs** monitors live and finished workflow runs.
Nothing on the Library runs - each shelf carries a single cross-link to where its assets are
executing, and no live state beyond it. That link sits beside the shelf's question as a
counted pill wearing a status dot: blue while work is merely open, amber when the count is
one you have to answer. The original pull request includes runtime captures of both the wide
and narrow layouts.

Switching primary pages changes only the dashboard body. The fleet header, live SSE
connection, and Cards, Console, or Board selection stay mounted, so returning to **Fleet**
does not reconnect or discard the fleet view.

`#/library` opens five shelves, each headed by the question it answers rather than by its own
noun:

| Shelf | Question | What is on it |
| --- | --- | --- |
| Workflows | What counts as done? | Workflow cards - version, reviewer count, draft validation errors. The builder is one level deeper |
| Personas | Who does the reviewing? | Persona cards with the provider and model each resolves to |
| Actions | What can a run tell the session to do? | [Session action](workflows.md#session-actions) cards - required skill and what proves completion |
| Ensembles | Not sure of the best approach? | Strategy launchers (Best of N, Panel vote, Consensus) that open Dispatch already in Ensemble mode on that strategy |
| Missions · Sources | Where does work come from? | Recurring missions and a link to task sources in Settings |

The three authoring surfaces mount one level deeper, unchanged, at bookmarkable hashes:

| Hash | Surface |
| --- | --- |
| `#/library` | The five shelves |
| `#/library/workflows[/:id]` | The workflow builder, on that workflow |
| `#/library/personas[/:id]` | The Persona library and editor |
| `#/library/actions[/:id]` | The session action library and editor |
| `#/library/<shelf>/new` | The same surface, opened on a blank draft |

The asset id follows what the editor actually has open: selecting a second Persona rewrites
the hash without adding a history entry, so the address bar is always a shareable link to what
you are looking at and **Back** still means the page you came from. `new` is reserved and
never an asset id.

Execution is not a Library shelf. Workflow Runs is a top-level page in the segmented control
and [the Line](ui.md#the-line-the-pipeline-strip-above-the-fleet) links directly into it; Ensemble
runs remain a top-level page reached from the Line. The Workflows page that once held all five
surfaces as sibling tabs is retired:

| Hash | Surface |
| --- | --- |
| `#/runs` | Every workflow run, its rail and reader. `?status=`, `?workflowId=` and `?session=` filter the list |
| `#/runs/:id` | That run's reader - verdicts, deliveries, timeline, exports |
| `#/ensembles` | Every ensemble run |
| `#/ensembles/:id` | That run's full dossier and its one-shot decision |
| `#/shipped` | The **Ship log**: every pull request the fleet opened, across every repository |

Every `#/workflows/*` spelling redirects permanently, and the address bar is rewritten to the
new one so a kept bookmark stops being a legacy link: `#/workflows` → `#/library`,
`#/workflows/personas` → `#/library/personas`, `#/workflows/actions` → `#/library/actions`,
`#/workflows/runs[/:id]` → `#/runs[/:id]`, `#/workflows/ensembles[/:id]` →
`#/ensembles[/:id]`. The runs page's three filters - `status`, `workflowId` and `session` -
survive the redirect, so a saved `#/workflows/runs?status=completed` lands on the same filtered
list it always did.

Those three are the only query parameters any route has ever had, and **anything else in a
query string is dropped**. That is a property of the router rather than of redirecting: a route
is a typed value serialized back out of its own fields, so `#/runs?source=x` loses `source`
exactly as `#/workflows/runs?source=x` does, and always has.

Those five are every spelling that ever shipped, and **anything else under the prefix lands on
`#/library` too** rather than falling through to the fleet. The prefix named one page, so a
hash carrying it is a link to that page however it is misspelled or half-remembered, and an
unrecognized sub-path cannot say which half was meant - so it takes the front door the whole
page's front door took. A hash that does *not* carry the prefix still falls back to the fleet,
as every unknown hash always has.

An editor with unsaved changes still holds a navigation away from it and asks first, whichever
home you are leaving for.

### The Ship log

`#/shipped` is the cross-repo record of what the fleet landed: the Inspector's adoption
ledger, read as a page rather than counted. Every row is one pull request Mission Control can
prove one of its agents opened, tagged with the repository it belongs to - which is what makes
this the surface that answers "what shipped, across everything we touched".

The page has three parts.

- A **KPI row**: how many shipped in the range and how that compares with the range before it
  (with a twelve-week trend line), how many of them merged and at what rate, the same
  fleet-wide per-pull-request cost figure the [spend chip](sessions.md#cost-telemetry) carries, and how
  many repositories the range touched.
- A **repository rail**: one row per repository with its count and a merged / open / gone mix
  bar. The rail doubles as the filter - press a repository to narrow the feed to it, press it
  again to come back. The KPI row deliberately does *not* narrow with it, because the context
  the selection was made from is what makes the selection readable.
- The **feed**: the range's pull requests grouped by the local day they were adopted, newest
  first. Each row carries its merge state as a mark *and* a word, the repository, the title,
  the number and branch, the session that opened it, and how long ago.

Three details are worth knowing.

**Titles arrive late, and rows are named by what is known.** The adoption signal is a hook
catching `gh pr create` and carries only a URL, so the title is written by the Inspector's
first poll afterwards. A row falls back to its branch name until then, and to its number when
even the branch has not been observed. A row adopted before this build and already closed may
keep its branch name for ever - the poll retires merged and closed rows and never looks again.

**Merged means merged by anyone.** YOLO mode records the merges it performs itself; a merge a
person pressed is visible only through what the poll last observed. The page counts both, so
"merged" here answers "did this land" rather than "did the fleet land it unattended". The
[Shipping settings panel](skills-and-settings.md#settings) keeps the finer five-way reading (merged, soaking, held
at a gate, not looked at, closed), which is a different question about the same rows.

**Range and repository are not in the hash.** Both are what you are currently looking at
rather than where you are, so `#/shipped` is the whole address and a reload comes back to the
default seven days across every repository. The page reads the ledger once over a window wide
enough for every range it offers, so switching between Today, 7 days and 30 days is instant
and cannot fail halfway through a comparison. It is fetched only while the page is open.

A range here is **whole local days ending today**, because the feed's day headings are its
ordering and half a day under a heading naming all of it would be a lie about both. The
Line's Shipped count is a rolling seven days to the minute, so the two figures differ by
however much of today has already gone. That is the only way they are allowed to differ: the
page reads the ledger through the adoption window, so neither truncation nor a re-review can
put them out of step about which pull requests exist.

Reach it with `⌘K` (search for "shipped", "merged" or "pull request"), by opening the hash, or
from the Line: clicking ⚑ **Shipped** opens the [Shipped drawer](ui.md#the-stage-drawers) over the
fleet, and its **Ship log →** header action lands here.
