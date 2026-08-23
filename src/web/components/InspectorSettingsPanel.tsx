import { useState } from "react";
import type { InspectorInspection } from "@shared/types.ts";
import type { InspectorState } from "../useInspector.ts";
import { Tooltip } from "./Tooltip.tsx";
import { TrustGrantSummary } from "./TrustPanel.tsx";
import type { SettingsNavigate } from "../lib/settings-registry.ts";
import {
  ConsoleCard,
  ConsoleState,
  ConsoleStrip,
  ConsoleSwitch,
  ConsoleTable,
  PrLink,
  type ConsoleColumn,
  type ConsoleStat,
} from "./settings-console.tsx";

// The Inspector's settings category.
//
// This panel has one job the other panels don't: it is the only place that says, in
// plain words, that turning this on causes something to be PUBLISHED under the operator's
// GitHub account. Every other control in the app is local. So the copy here is part of
// the feature, not decoration around it.
//
// It is drawn as a CONSOLE - controls in a narrow column, the inspections ledger in a
// wide one - because the two halves are read at different times and by different needs.
// The knobs are set once. The ledger is the whole readout of a dry run, and the only
// place an operator can see what the Inspector would have said before letting it speak;
// as a 12px list under a vertical form it was the least legible thing on the page and the
// most important. See `settings-console.tsx` for the shape, which Shipping shares.

const MODE_LABEL: Record<"dry-run" | "live", string> = {
  "dry-run": "Dry run - review and record findings, post nothing",
  live: "Live - post review comments on GitHub",
};

/** The same two modes as one word, for the segmented control. */
const MODE_SHORT: Record<"dry-run" | "live", string> = {
  "dry-run": "Dry run",
  live: "Live",
};

/** Relative time for the inspections list. Coarse on purpose - this is an at-a-glance list. */
export function ago(then: number | null, now: number): string {
  if (then === null) return "not yet reviewed";
  const secs = Math.max(0, Math.round((now - then) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Which pile a row belongs in - the axis the count strip tallies and the filter selects.
 *
 * Deliberately NOT the same question as `inspectionSummary`, which is what the row SAYS
 * about itself. A closed pull request that was reviewed with three findings still reports
 * "3 findings" (that is the record of what the Inspector said about something that has
 * since landed) while belonging in `retired`, because it is out of the sweep for good and
 * counting it as work in hand is the bug this feature already shipped once. One row, two
 * honest answers; conflating them is how the list became a backlog nobody could act on.
 */
export type InspectionBucket = "failed" | "findings" | "queued" | "clean" | "retired";

export function inspectionBucket(row: InspectorInspection): InspectionBucket {
  // CLOSED outranks a stored error, and the order is the whole point. A row whose last
  // attempt failed and whose pull request has since closed will never be retried - the
  // sweep loads open rows only - so counting it under `failed` puts something nobody can
  // act on into the one tile that means "act on this", and inflates it permanently. That
  // is the same defect `inspectionSummary` shipped in its own vocabulary, one branch down.
  // The error is not lost: `inspectorHealth` reads `lastError` off the rows directly, and
  // the row still SAYS "failed", because what the Inspector last said about a pull request
  // that has since closed is history worth keeping.
  if (row.state === "closed") return "retired";
  if (row.lastError) return "failed";
  if (row.round === 0) return "queued";
  return row.openFindings > 0 ? "findings" : "clean";
}

/**
 * What one ledger row says about itself, in one phrase.
 *
 * The RETIRED branch is the one to keep: a row whose PR has closed is out of the sweep
 * for good (`loadOpenInspectorPrs` selects `state = 'open'`), and `processPr` clears
 * `lastError` on the way out, so without this it lands on `round === 0` and reads
 * "queued" - forever, for something that will never be looked at again. Two dozen merged
 * PRs said "queued / not yet reviewed" on this panel, which is not a slow queue being
 * reported honestly, it is a finished one being reported wrongly.
 *
 * A retired row that WAS reviewed keeps its findings instead: that is the record of what
 * the Inspector said about a PR that has since landed, and it is the more useful fact.
 */
export function inspectionSummary(row: InspectorInspection): string {
  if (row.lastError) return "failed";
  if (row.state === "closed" && row.round === 0) return row.mergedAt ? "merged" : "closed";
  if (row.round === 0) return "queued";
  if (row.openFindings === 0) return "clean";
  return `${row.openFindings} finding${row.openFindings === 1 ? "" : "s"}`;
}

/**
 * The strip's tallies, in strip order.
 *
 * Computed from `inspectionBucket` rather than by re-testing the fields here, so a tile's
 * number and the rows the same tile filters to cannot disagree - a count that does not
 * match what clicking it shows is worse than no count.
 */
export function inspectionTallies(
  rows: readonly InspectorInspection[],
): Record<InspectionBucket, number> {
  const t: Record<InspectionBucket, number> = {
    failed: 0,
    findings: 0,
    queued: 0,
    clean: 0,
    retired: 0,
  };
  for (const row of rows) t[inspectionBucket(row)] += 1;
  return t;
}

/**
 * When the Inspector last completed anything, and what it last failed on.
 *
 * Both are read off the ledger rather than reported by the daemon, because both are
 * already there: a sweep that reviewed something advanced that row's `lastReviewedAt`,
 * and a failure is stored verbatim on the row it happened to. The card exists because a
 * dry run that is quiet and a dry run that has been erroring for three hours look
 * identical in the list - every row simply keeps its last verdict.
 */
export function inspectorHealth(rows: readonly InspectorInspection[]): {
  lastSweep: number | null;
  failed: InspectorInspection | null;
} {
  let lastSweep: number | null = null;
  let failed: InspectorInspection | null = null;
  for (const row of rows) {
    if (row.lastReviewedAt !== null && (lastSweep === null || row.lastReviewedAt > lastSweep)) {
      lastSweep = row.lastReviewedAt;
    }
    if (row.lastError && (failed === null || row.updatedAt > failed.updatedAt)) failed = row;
  }
  return { lastSweep, failed };
}

/**
 * The strip, one tile per bucket - and EVERY bucket, which is the property that makes the
 * numbers worth reading.
 *
 * The first cut left `retired` out, on the theory that history is not work in hand. On a
 * real ledger that is 49 rows of 50: the strip read "1 with findings, 0, 0, 0" over a
 * table of fifty, which does not say "one thing needs you", it says "this panel cannot
 * count". A strip that accounts for every row can be trusted the day one tile is the only
 * one that matters. Pinned by `settings-console.test.ts`.
 */
const STRIP: readonly { id: InspectionBucket; label: string; tone: ConsoleStat["tone"]; hint: string }[] =
  [
    {
      id: "findings",
      label: "with findings",
      tone: "attention",
      hint: "Show only pull requests GitHub Inspector is carrying open findings on",
    },
    { id: "clean", label: "clean", tone: "ok", hint: "Show only pull requests reviewed with nothing outstanding" },
    { id: "queued", label: "queued", tone: "plain", hint: "Show only pull requests nothing has looked at yet" },
    { id: "failed", label: "failed", tone: "danger", hint: "Show only pull requests whose last review attempt errored" },
    {
      id: "retired",
      label: "retired",
      tone: "plain",
      hint: "Show only pull requests that have closed - out of the sweep for good, kept as the record of what was said about them",
    },
  ];

/**
 * The buckets the strip has a tile for. Exported so a test can hold it against the bucket
 * vocabulary itself: a bucket with no tile is a pile of rows nothing on this screen
 * counts, which is how the strip came to ignore 49 rows out of 50.
 */
export const INSPECTION_STRIP_BUCKETS: readonly InspectionBucket[] = STRIP.map((s) => s.id);

/**
 * What an emptied filter says, per bucket. A `Record`, so the compiler asks for a sentence
 * whenever a bucket is added.
 *
 * Written out rather than composed from the bucket id, which is what produced the actual
 * first draft of this screen: "No pull request is findings right now." A filter that has
 * nothing to show is the moment the panel is most obliged to sound like it was written by
 * someone.
 */
const EMPTY_FILTER: Record<InspectionBucket, string> = {
  findings: "Nothing is carrying open findings.",
  clean: "Nothing has been reviewed clean yet.",
  queued: "Nothing is waiting to be reviewed.",
  failed: "No review has failed.",
  retired: "No adopted pull request has closed yet.",
};

/** The ledger's column names. `sc-when` matches the cells, so the header tracks them. */
const COLUMNS: readonly ConsoleColumn[] = [
  { label: "Pull request" },
  { label: "Verdict" },
  { label: "Closed" },
  { label: "Reviewed", className: "sc-when" },
  { label: "Resolve", className: "sc-act" },
];

/**
 * Whether this row can be handed to `resolveFindings`.
 *
 * Open pull requests carrying findings only. A retired row is out of the sweep for good,
 * so closing its ledger would change nothing anyone can see and would quietly rewrite the
 * record of what the Inspector said about something that has already landed.
 */
export function canResolveFindings(row: InspectorInspection): boolean {
  return row.state === "open" && row.openFindings > 0;
}

export function InspectorSettingsPanel({
  state,
  onNavigate,
}: {
  state: InspectorState;
  onNavigate: SettingsNavigate;
}): React.JSX.Element {
  const { config, inspections, update, error } = state;
  const enabled = config?.enabled ?? false;
  const mode = config?.mode ?? "dry-run";
  const allowlist = config?.repoAllowlist ?? [];
  const now = Date.now();
  const [filter, setFilter] = useState<string | null>(null);
  /** The PR key whose findings are being resolved right now, so its button can say so. */
  const [resolving, setResolving] = useState<string | null>(null);
  const tallies = inspectionTallies(inspections);
  const health = inspectorHealth(inspections);
  // The tile the filter belongs to, so the ledger's own chrome can say what is being
  // shown in the words the tile uses rather than in the bucket's id.
  const active = STRIP.find((s) => s.id === filter) ?? null;
  const rows = active === null ? inspections : inspections.filter((r) => inspectionBucket(r) === active.id);

  return (
    <section className="settings-section sc-section">
      <p className="settings-hint sc-lede">
        Reviews the pull requests Mission Control opened - and only those - against the
        repository's <code>personas/INSPECTOR.md</code>, or its root <code>INSPECTOR.md</code>.
        It comments on what it finds, answers replies in its own threads, re-reviews on every
        push, and closes its own threads once a push fixes them.
      </p>

      <div className="sc-split">
        <div className="sc-controls">
          <ConsoleCard
            title="GitHub Inspector"
            anchor="inspector/enabled"
            action={
              <ConsoleSwitch
                label="Run GitHub Inspector"
                tooltip="Review the pull requests Mission Control opened, and comment on them"
                checked={enabled}
                disabled={!config}
                onChange={(next) => void update({ enabled: next })}
              />
            }
          >
            {/* The posture line. It exists because the switch beside it cannot tell the
                four states apart, and three of them look like "on": computing findings
                and publishing them, computing findings and publishing nothing, and not
                running at all. */}
            {!config ? (
              <ConsoleState tone="unknown">Unknown - the daemon has not answered</ConsoleState>
            ) : !enabled ? (
              <ConsoleState tone="off">Off - nothing is being reviewed</ConsoleState>
            ) : mode === "live" ? (
              <ConsoleState tone="danger">Live - posting review comments to GitHub</ConsoleState>
            ) : (
              <ConsoleState tone="attention">Dry run - reviewing, publishing nothing</ConsoleState>
            )}

            {/* The daemon has not answered. Said out loud, because the fallbacks below are
                `off` / `dry run` / `no repos` - the safe posture - and presenting schema
                defaults as the daemon's answer tells the operator GitHub Inspector is quiet
                when the stored config may well be enabled and live. Disabled inputs are
                not a statement about what is running. */}
            {!config && (
              <p className="settings-warn inspector-unknown">
                Can't reach the daemon, so what GitHub Inspector is actually set to is unknown. The
                controls below are showing defaults, not its current state.
              </p>
            )}

            {/* The one warning in this app about something leaving the machine. It is shown
                whenever live is selected, not only on the click that selects it, because the
                risk is ongoing rather than momentary. */}
            {mode === "live" && enabled && (
              <p className="settings-warn inspector-live-warn">
                Comments are posted to GitHub under your account, and are public on a public
                repository. GitHub Inspector can read files in the reviewed worktree to do its job.
              </p>
            )}

            <fieldset className="sc-field sc-seg" data-anchor="inspector/mode">
              <legend className="sc-field-label">Mode</legend>
              <div className="sc-seg-row">
                {(["dry-run", "live"] as const).map((m) => (
                  <Tooltip key={m} label={MODE_LABEL[m]}>
                    <label className={`sc-seg-opt${mode === m ? " is-on" : ""}`}>
                      <input
                        type="radio"
                        name="inspector-mode"
                        checked={mode === m}
                        disabled={!config}
                        onChange={() => void update({ mode: m })}
                      />
                      <span>{MODE_SHORT[m]}</span>
                    </label>
                  </Tooltip>
                ))}
              </div>
              <p className="settings-hint">{MODE_LABEL[mode]}.</p>
            </fieldset>

            {/* The pointer left by the provider select and the model box. Both moved to
                Settings > Models, where every call this app makes on your account is
                answerable in one screen - including what an unset provider now inherits,
                which is a question this panel could not answer at all while it resolved to a
                literal Claude. No `data-anchor`: search points at the Models page, and an
                anchor whose only content is a signpost is a result that jumps to a sentence
                rather than to a control. */}
            <p className="settings-hint">
              GitHub Inspector starts an isolated call per review. Claude receives read-only tools
              scoped to the worktree; Codex reviews the supplied diff without repository tools.
            </p>
            <p className="settings-hint">
              Which provider and model it starts now sits with every other model this app spends
              on.{" "}
              <Tooltip label="Open Settings > Models and flash GitHub Inspector's row">
                <button
                  type="button"
                  className="settings-link"
                  onClick={() => onNavigate("models", "models/inspector")}
                >
                  Open it in Models →
                </button>
              </Tooltip>
            </p>
          </ConsoleCard>

          <ConsoleCard title="May post in" anchor="inspector/reviewed-repos">
            {/* The consent copy stays with the count: it is about the grant, not the editor. */}
            <p className="settings-hint">
              GitHub Inspector only posts in these repos - their worktrees count too, wherever they
              live on disk. It still reviews everywhere while in dry run.
            </p>
            <TrustGrantSummary
              configured={Boolean(config)}
              count={allowlist.length}
              subject="GitHub Inspector may post reviews in"
              onNavigate={onNavigate}
            />
          </ConsoleCard>

          {/* Absent until there is something to report, rather than rendering "never" at a
              fresh install: an empty ledger already says nothing has happened, and a
              health card that says it again in two more lines is noise. */}
          {inspections.length > 0 && (
            <ConsoleCard title="Health">
              <p className="sc-health-row">
                <span>Last completed review</span>
                <span className="sc-health-value">{ago(health.lastSweep, now)}</span>
              </p>
              <p className="sc-health-row">
                <span>Last failure</span>
                {health.failed ? (
                  <Tooltip label={health.failed.lastError ?? ""}>
                    <span className="sc-health-value sc-health-bad">
                      {health.failed.repo}#{health.failed.number}
                    </span>
                  </Tooltip>
                ) : (
                  <span className="sc-health-value">none</span>
                )}
              </p>
            </ConsoleCard>
          )}
        </div>

        {/* Without this, dry run is indistinguishable from broken: it reviews, finds things,
            posts nothing, and says nothing anywhere. This is where you read what it WOULD
            have said before you let it speak. */}
        <div className="sc-ledger" data-anchor="inspector/recent">
          <ConsoleStrip
            stats={STRIP.map((s) => ({ ...s, count: tallies[s.id] }))}
            active={filter}
            onPick={setFilter}
          />
          <ConsoleTable
            title="Inspections"
            variant="inspector"
            columns={COLUMNS}
            rows={rows}
            rowKey={(row) => row.key}
            filter={
              active && {
                label: active.label,
                hint: "Show every adopted pull request again",
                onClear: () => setFilter(null),
              }
            }
            // Computed whether or not it is shown, so it has to be TOTAL: `active` is null
            // whenever the strip is showing everything, and a `!` here would throw on the
            // ordinary render rather than on the empty one it was written for.
            empty={
              active === null || inspections.length === 0
                ? "Nothing yet. A pull request appears here once Mission Control opens one."
                : EMPTY_FILTER[active.id]
            }
            foot="In dry run this table is the only place GitHub Inspector's findings exist - nothing is posted, and nothing else in the app shows them."
            renderRow={(row) => {
              const bucket = inspectionBucket(row);
              return (
                <div className={`sc-row${bucket === "retired" ? " is-retired" : ""}`}>
                  <PrLink
                    repo={row.repo}
                    number={row.number}
                    url={row.url}
                    tooltip={row.lastError ?? `Open ${row.repo}#${row.number} on GitHub`}
                  />
                  <span className={`sc-verdict sc-verdict-${bucket}`}>
                    {inspectionSummary(row)}
                  </span>
                  {/* Findings that are no longer open, and the one tally nothing else in the
                      app shows. Blank rather than "0", so the column reads as a list of
                      outcomes instead of a column of zeroes.

                      It says "closed", not "fixed", and the distinction is the honest one:
                      `resolvedFindings` sums a single `resolved` status that three different
                      things now write - a review round confirming a push fixed it, the
                      GitHub Inspector dropping its own finding in conversation, and an operator
                      asserting it was handled. Only the first is evidence a fix landed, and
                      the ledger does not record which of the three it was, so a column
                      labelled "fixed" would be claiming provenance the number does not
                      carry. The tooltip names all three rather than picking the flattering
                      one. */}
                  <span className="sc-fixed">
                    {row.resolvedFindings > 0 ? (
                      <Tooltip
                        label={
                          `${row.resolvedFindings} finding${row.resolvedFindings === 1 ? "" : "s"} ` +
                          "on this pull request are no longer open. A finding closes when a review " +
                          "round confirms a push fixed it, when GitHub Inspector drops it while " +
                          "answering a reply, or when an operator resolves it here - this count " +
                          "does not distinguish them."
                        }
                      >
                        <span>{row.resolvedFindings} closed</span>
                      </Tooltip>
                    ) : (
                      ""
                    )}
                  </span>
                  <span className="sc-when">{ago(row.lastReviewedAt, now)}</span>
                  {/* The way out of a finding that has genuinely been addressed and that
                      nothing else can close - see `resolveInspectorFindings`. Blank on
                      every row that has nothing to resolve, like the Fixed column beside
                      it, so the column reads as "these need you" rather than as a row of
                      buttons daring you to press one. */}
                  <span className="sc-act">
                    {canResolveFindings(row) && (
                      <Tooltip
                        label={
                          `Mark GitHub Inspector's ${row.openFindings} open ` +
                          `finding${row.openFindings === 1 ? "" : "s"} on ${row.repo}#${row.number} ` +
                          "as resolved, for when they have been addressed but no review round " +
                          "is left to say so. This does not merge anything: every other gate, " +
                          "including unresolved review threads on GitHub, is still checked."
                        }
                      >
                        <button
                          type="button"
                          className="settings-link"
                          aria-label={`Resolve GitHub Inspector's findings on ${row.repo}#${row.number}`}
                          disabled={resolving === row.key}
                          onClick={() => {
                            setResolving(row.key);
                            void state.resolveFindings(row.key).finally(() => setResolving(null));
                          }}
                        >
                          {resolving === row.key ? "Resolving…" : "Resolve"}
                        </button>
                      </Tooltip>
                    )}
                  </span>
                </div>
              );
            }}
          />
        </div>
      </div>

      {error && <p className="settings-error">{error}</p>}
    </section>
  );
}
