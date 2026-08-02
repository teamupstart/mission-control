# The ensemble decision dossier: righting an inverted hierarchy

Status: **direction approved 2026-08-01 - Direction A, The Scoreboard.** Phasing follows.
Surface: the Best-of-N decision dossier at `#/workflows/ensembles/<runId>` - `src/web/ensembles/results/BestOfN.tsx`, `results/dossier.tsx`, `results/DecisionPanel.tsx`, `EnsembleTimeline.tsx`, and `styles.css:8785-9354`.
Basis: a live read of a completed three-candidate run in the running dashboard, with every measurement below taken from the rendered DOM at 1440x900 and 1024x900.

A rendered copy lives beside this file as `plan.html`. Open that, not this.

## Decisions taken

| Question | Answer |
| --- | --- |
| Direction | **A - The Scoreboard** |
| Floor fixes in scope | **Declare the prose type scale**, plus bounding the prose (constitutive of A) |
| Event log rewrite | **Include it now** |
| Follow-up | Create phased implementation plan |

Deferred to a later plan, deliberately: resolving the anonymised `Submission A/B/C` labels (section 2.3) and the status-colour cascade onto body prose (section 2.4). The evidence for both is kept below because it is measured and still true; only the fixes are out of scope.

**This plan therefore changes no data flow.** `subjectLabel` was the only wire change proposed, and it belonged to label resolution. What ships is entirely client-side rendering plus copy.

---

## 1. Why this screen

The dossier is where an operator picks a winner. The decision is one-shot and destructive: it promotes one snapshot, reaps the losing worktrees, and refuses a second `decide` on `expectedStatus`. `DecisionPanel` is honest about it - *"Recorded once. A decision cannot be replayed or revised."*

So the screen has exactly one job: **make the choice defensible in under a minute.** Everything below is measured against that job, not against taste.

The feature's information architecture is already good. The strategy renderers preserve the judge's reasoning, the reported-versus-observed split is a genuinely principled distinction, and the CSS carries load-bearing comments explaining most layout choices. This is not about what the screen knows. It is about the fact that the screen's typography ranks its content in almost exactly the reverse of its evidential value.

---

## 2. The evidence

Every figure here was read off the live DOM, not inferred from source.

### 2.1 The type hierarchy is inverted - IN SCOPE

| Element | Selector | Size | Weight | Colour |
| --- | --- | --- | --- | --- |
| Unverified agent prose | `.ensemble-reported p` | **16px** | 400 | `--fg` |
| Unverified check list | `.ensemble-checks li` | **16px** | 400 | `--fg` |
| Strengths / risks | `.ensemble-scorecard-cols li` | **16px** | 400 | `--fg` |
| Rank marker | `.ensemble-rank` | 16px | 800 | `--fg` |
| **Judge's score** | `.ensemble-score` | **12px** | **400** | **`--muted`** |
| Run intent | `.dossier-intent` | 13px | 400 | `--fg` |

The block the interface itself labels *"Claims, not verified by Mission Control"* is set 33% larger than the judge's score, in a brighter colour. The score - the one number the entire comparison stage exists to produce - is the smallest, dimmest text on the card.

That 16px is not a choice. `body` never declares a `font-size`, so it resolves to the user-agent default and every ensemble paragraph inherits it. The rest of the dashboard sets its own sizes: 87% of all `font-size` declarations in `styles.css` fall between 9px and 13px, with 11.5px as the canonical secondary size. **The decision screen is the one surface in the app that opted out of the app's type scale, and it did so by omission.**

`line-height` on all of that prose computes to `normal` - roughly 1.2 - across a 337px column. Long-form text at 16px/1.2 in a 337px measure is the worst-reading configuration on the page, and it is the largest body of text on the page.

### 2.2 The comparison grid does not compare - IN SCOPE

`.dossier-cols` is `repeat(auto-fit, minmax(min(320px, 100%), 1fr))` with `align-items: start`. Three columns, no shared rows. Each candidate's prose is unbounded, so each column is an independent essay and peer sections drift apart vertically.

Measured at 1440x900, offsets from each card's own top:

| Section | Candidate 1 | Candidate 2 | Candidate 3 | Spread |
| --- | --- | --- | --- | --- |
| Score line | +71px | +71px | +44px | 27px |
| Reported by this candidate | +97px | +97px | +70px | 27px |
| Observed by Mission Control | +2160px | +1286px | +309px | **1851px** |
| Strengths | +2365px | +1453px | +514px | **1851px** |
| Risks | +2603px | +1691px | +676px | **1927px** |

Card heights: **2806px / 1932px / 936px**. The row is 3.1 viewports tall.

To compare the three candidates' risks - the reason a person is on this screen - you scroll roughly 1900px between each one. At 1024px the columns stack entirely and the same spread grows past 3600px. The layout that exists to prevent holding a candidate in your head requires holding two of them in your head.

The CSS comment at `styles.css:8905` anticipates the failure exactly: *"a column that outgrows it neither clips nor scrolls."* It is right about the mechanism. What follows from it is that nothing bounds the growth.

### 2.3 The judge's headline sentence cannot be resolved - DEFERRED

Kept as evidence; the fix is out of scope for this plan.

The comparison summary renders verbatim: *"Submission B best addresses the half-screen requirement..."*. The cards beneath it are titled `Candidate 2 (claude · claude-opus-5)`, `Candidate 3`, `Candidate 1`, ranked `#1 #2 #3`. **Nothing on the screen says which candidate is Submission B.** Three numbering systems name the same three objects, none agree, and no legend maps them. In the Timeline the collision lands inside a single bullet list, two lines apart.

Cause, for whoever picks this up: `packet.ts:211-217` builds `labelToArtifact`; `comparative.ts:102` and `panel.ts:137` use it to de-anonymise the **structured** entries only. The **free text** - `summary`, `caveats`, per-subject `rationale` - passes through untouched and the map is discarded. Carrying `subjectLabel` on each de-anonymised entry, a value already in hand at both call sites, would let the client resolve the prose.

### 2.4 Status colour is applied to body prose - DEFERRED

Kept as evidence; the fix is out of scope for this plan.

`.ensemble-member.ensemble-tone-done` sets a tone colour that cascades to its whole subtree. Measured live, a member lane's evidence list computes to `rgb(53, 192, 138)` - `--idle` green - for multiple paragraphs of ordinary prose. An eliminated member renders its neutral facts (`Attempt #1 · selected`, `commit capture #1`) in `--danger` red. Red and green stop meaning pass and fail once they are also the identity of a lane.

Note for sequencing: this lives in the Members section, not the dossier, so it does not block anything here.

### 2.5 Structure that does not encode information - IN SCOPE

- `#1 #2 #3` at 16px/800 are the loudest thing on each card, but rank is derivable and already implied by document order. The quantity that is not derivable - **the margin**, 92 against 84 against 67 - is set in 12px muted grey. A decisive win and a coin flip look identical.
- `Recommended` is bare green text inline in the header, not a badge. Because it sits in the flow, it pushes the recommended card's contents 27px down relative to its peers. The one card you most want to line up against the others is the only one that cannot line up.
- The Events list renders raw enum members - `run_completed`, `member_eliminated`, `finalization_blocked`, `winner_materialized`, `stage_succeeded`, `run_recovered` - in bold at body size, beside 18 identical grey `5d ago` stamps. The system's internal vocabulary is the most prominent text in the block, and the only column that varies carries no information.

---

## 3. What ships

### 3.1 The type scale

Set an explicit size and `line-height` on `.ensemble-reported`, `.ensemble-checks`, and `.ensemble-scorecard-cols` so nothing inherits the 16px UA default. Body prose lands at **12.5px/1.55**, inside the app's existing ramp. Scores and figures get `font-variant-numeric: tabular-nums`.

This is the root defect and it is independent of layout, so it can land first and alone.

### 3.2 Bounded prose

No cell may set the height of a comparison row. The claim clamps to three lines with an explicit `Read the full claim` expander. Strengths and risks clamp to three items with an `N more` expander.

Required by 3.3: the Scoreboard's criteria rows only work if no cell can blow out.

### 3.3 Direction A - The Scoreboard

Transpose the grid. Rows become comparison criteria, columns become candidates. Every row answers one question across all three at once: score, confidence, diff, elapsed, strengths, risks, claim. Scanning a row is the whole interaction.

**Signature: the margin ruler.** A single 0-100 axis directly under the header, plotting all three scores as ticks on one line. The gap between ticks is the margin of victory - the fact that decides whether the recommendation is worth accepting or worth overriding, and the fact today's `score 92/100` in 12px grey completely hides. It encodes a real quantity spatially, which is what a structural device is for.

**Type.** Scores promoted to 26px `--mono` with `tabular-nums` and tight tracking, `/100` trailing at 10px. Criteria labels in the app's existing 10.5px uppercase eyebrow treatment. Prose at the 3.1 scale, clamped per 3.2.

**Alignment.** `Recommended` becomes a badge in a fixed-height slot so the winning column still lines up with its peers. The recommended column carries a 5% `--idle` tint and an inset left rule rather than a border that shifts layout.

**Elapsed is new.** The run measured 49m / 5h 24m / 4h 38m: the winner was roughly six times faster than its rivals, and that fact appears nowhere on the decision screen today. It is a criteria row.

**Responsive.** Below the point where three criteria columns stop fitting, the grid falls back to one candidate per row group with the criteria labels repeated, rather than the current full stack. No horizontal scroll on the page body.

**Palette.** No new colour. Dark-only, the existing six state hues, `color-mix` off existing tokens, no web fonts.

### 3.4 The event log in the operator's words

`winner_materialized` becomes *Winner restored to a checkout*; `member_eliminated` becomes *Candidate 3 eliminated*. Group by stage rather than listing 18 flat rows. Timestamps carry information or they go.

This touches `EnsembleTimeline.tsx`, outside the dossier proper, and was explicitly included.

---

## 4. Considered and set aside

Two other directions were mocked up and reviewed at commit `578fbc9`, where their mockups remain if anyone wants them.

**B - The Verdict Sheet.** Lead with the ruling at a 68ch measure, resolve the anonymised labels inline, and put candidates in a docket that opens one at a time. Signature was a mono seal at 34px, the app's first display type. Set aside because it gives up simultaneous three-way comparison, and because its central move depends on the label resolution that is deferred.

**C - The Ledger.** A dense blotter at native density with a score gutter whose fill height is the score, and a peek pane that swaps as you arrow through rows. Set aside as less self-explanatory for an infrequent reader, though it remains the strongest option if ensemble volume rises.

---

## 5. Scope

In scope: `dossier.tsx`, `BestOfN.tsx`, `DecisionPanel.tsx`, the `.ensemble-scorecard` / `.dossier-*` CSS, and `EnsembleTimeline.tsx` for the event log.

Panel vote and Consensus reuse `CandidateColumn` and inherit the type-scale and bounding fixes for free. Their strategy-specific surfaces - the rank matrix, ballots, divergence cards - are out of scope and should follow the Scoreboard in a later pass.

Not in scope: label resolution and the `subjectLabel` wire change (2.3), the tone-cascade fix (2.4), the Compare workspace file matrix, the dispatch flow, run list, artifacts, and the ensembles-live-under-Workflows navigation question.

No server change. No schema change. No wire change.

---

## 6. Proof

A Playwright spec in `e2e/` covering the decision dossier, since this surface currently has none that asserts what the operator can actually read:

- No candidate cell exceeds its bounded height, and the criteria rows align across all three columns.
- The score is present, readable, and larger than the claim prose.
- The margin ruler renders a tick per candidate.
- At 1024px the page body does not scroll horizontally.
- The event log renders operator words, not raw enum members.

Plus the existing suites: `npm run typecheck`, `npm test`, `npm run lint`, and `npm run build` before the e2e run.
