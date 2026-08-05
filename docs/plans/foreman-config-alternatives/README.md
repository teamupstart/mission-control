# Foreman configuration pane - six alternatives, and the plan for the one chosen

**Option B (grouped tabs) was chosen.** The plan and its phases live beside the mockups:

| File | What it is |
| --- | --- |
| [`plan.md`](plan.md) ([rendered](plan.html)) | The approved plan - the measured problem, the decision, and the requirements |
| [`phased-plan.md`](phased-plan.md) ([rendered](phased-plan.html)) | The implementation index - findings, phase table, cross-phase contracts |
| [`phase-1-tab-strip-and-anchors.md`](phase-1-tab-strip-and-anchors.md) | Phase 1 - the tab strip, the group table, the deep-link contract |
| [`phase-2-blurbs-on-demand.md`](phase-2-blurbs-on-demand.md) | Phase 2 - the prose stops being printed twice |

The mockups below are the evidence the decision was made from. They remain accurate and are
not superseded by the plan.

## The mockups

Mockups only. Nothing in them is wired to the app; no `src/` file was changed to build them.

Open [`index.html`](index.html) in a browser. It carries the measurement, the six options
side by side, and links into each mockup. **The mockups are interactive** - tabs switch,
rows expand, the sheet opens, presets apply. Every pixel figure in a header chip is measured
off the laid-out page in JavaScript rather than asserted in prose, so a claim cannot drift
from what the mockup actually renders.

| File | What it shows |
| --- | --- |
| `index.html` | The diagnosis, a comparison table, and a recommendation |
| `option-a-digest.html` | Digest column - one line per setting, expands to the real editor |
| `option-b-tabs.html` | Grouped tabs - four groups, so the column is the tallest one not their sum |
| `option-c-ledger-first.html` | Ledger first - a posture bar plus a Configure sheet, ledger full width |
| `option-d-grid.html` | Card grid - ledger on top, config below as a responsive grid |
| `option-e-sentence.html` | The config as an editable English sentence |
| `option-f-presets.html` | Named postures, with the 14 fields as the detail behind them |

## Why the column is the problem

Measured on the live pane at an 849px viewport:

- The control column (`.sc-controls`) is **1988px** tall - 2.3 screens - and carries **14**
  interactive controls, roughly one every 142px.
- The ledger beside it is **597px** and scrolls inside itself, so it never grows. Everything
  past the first screenful is form on the left and empty space on the right.
- **Seven of the fourteen controls are model dropdowns** (provider, four Foreman roles,
  three backlog harnesses). They are set once and never touched, and they occupy about
  900px - 45% of the column.
- At that window the ledger's `Asked` column is **366px** and truncates the `purpose` line
  on nearly every row. `purpose` is the only field that reliably differs between two rows.

## Correctness

`mock-data.js` is the single source of truth for all six mockups, and every value in it was
verified against the code rather than remembered:

| Fact | Source |
| --- | --- |
| Roles and their blurbs | `src/shared/foreman-models.ts`, `FOREMAN_MODEL_SPECS` |
| Role tiers (review/verify deep, triage cheap, backlog balanced) | the daemon's own rendered `Default - <id>` options |
| Provider defaults per tier | `src/shared/model.ts`, `providerModelDefault` |
| Completion safeguards | `src/web/components/ForemanSettingsPanel.tsx` |
| Live repositories | `src/web/components/TrustPanel.tsx`, `TrustGrantSummary` |
| Model option lists | read off the running daemon's `<select>` elements |

**Foreman has no Trust setting.** An earlier draft of these mockups gave Foreman a "Trust"
group, which invented a control the panel does not have. The repo allowlist is edited in the
separate Trust category; Foreman renders a read-only count and a "Manage in Trust" deep link.

Five of the six render that line through one shared helper (`data-live-repos`) which can only
produce a sentence and a link, so they cannot reintroduce the mistake. Option E is the
exception by necessity - its whole design is one paragraph, so the count has to sit inside
the sentence - and it satisfies the same rule directly: the repositories token is the only
value in that paragraph with no picker behind it, carrying no `aria-haspopup` and rendering
as two `settings-link` buttons that navigate, exactly like `TrustGrantSummary` does.

Two related details the mockups get right and are easy to get wrong:

- **The model lists are provider-scoped.** The snapshot runs Codex, so every Foreman role
  lists Codex models. Changing the provider in the real panel clears all four role overrides.
  A mockup may not mix a Claude id into a Codex list.
- **There is no Cheap-tier column on the ledger.** That column is keyed on the Shadow
  posture only, and this snapshot is On, so rendering it would show a permanently empty track.

## How the mockups are built

`console.css` is extracted from `src/web/styles.css` by selector, comments stripped, rules
verbatim: the design tokens, the whole `sc-` settings-console block, and the supporting form
rules (`.field-input`, `.kb-row`, `.skill-switch`, `.settings-hint`). That is why the mockups
match the app rather than approximating it. Regenerating it means re-running the extraction
against `styles.css`, not hand-editing it.

`mock-data.js` and `mock.js` are **classic scripts, deliberately not ES modules**: these pages
are opened straight off disk with `file://`, where module scripts fail the CORS check and
render nothing at all.

`mock.js` owns everything the six options have in common - the ledger, the count strip, the
health readout, the live-repositories summary, the field leaves, and the tab/accordion/
disclosure wiring. Six hand-copied ledgers would disagree with each other by the third edit.

`mock.css` is annotation chrome that exists only in these files - the header, the metric
chips, the pros and cons footer. None of it is proposed for the app.

## Status

No decision has been made and nothing has been implemented. If one of these is chosen it
needs a `docs/plans/<name>/plan.md`, and per `CLAUDE.md` any UI change lands with a
Playwright spec in `e2e/`.
