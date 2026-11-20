import { useEffect, useRef, useState } from "react";
import type { Shaper, ShapingConfigView, ShapingRun } from "@shared/shaping.ts";
import {
  isUnsupportedShaper,
  readShaperManifest,
  shaperEnvironmentNames,
  shaperReach,
  shaperReceives,
} from "../lib/shaping-settings.ts";
import { Overlay, OVERLAY_IDS } from "./Overlay.tsx";
import { RepoCombobox } from "./RepoCombobox.tsx";
import { Tooltip } from "./Tooltip.tsx";

const STAGE_LABEL: Record<string, string> = { gather: "Gather", select: "Select" };

/** Runs one dry run for the dialog. A failed request, as opposed to a failed shaper, is `ok: false`. */
export type ShapingTestRunner = (
  request: { id: string; repository: string; prompt: string },
  signal: AbortSignal,
) => Promise<{ ok: true; run: ShapingRun } | { ok: false; aborted: boolean; reason: string }>;

function ReviewLine({ term, children }: { term: string; children: React.ReactNode }): React.JSX.Element {
  return <div className="shaping-review-line"><dt>{term}</dt><dd>{children}</dd></div>;
}

/** Exactly what a shaper will run or call and what it is given, for the import review. */
export function ShaperReview({ shaper }: { shaper: Shaper }): React.JSX.Element {
  const environment = shaperEnvironmentNames(shaper);
  const receives = shaperReceives(shaper);
  return (
    <section className="shaping-review" aria-label="What this shaper runs or calls">
      <dl>
        <ReviewLine term="Label">{shaper.label}</ReviewLine>
        <ReviewLine term="Id"><code>{shaper.id}</code></ReviewLine>
        <ReviewLine term="Stage">{STAGE_LABEL[shaper.stage] ?? shaper.stage}</ReviewLine>
        {shaperReach(shaper).map((line) => (
          <ReviewLine key={`${line.label}:${line.value}`} term={line.label}><code>{line.value}</code></ReviewLine>
        ))}
        <ReviewLine term="Environment variables">
          {environment.length > 0 ? environment.map((name) => <code key={name}>{name}</code>) : "None"}
        </ReviewLine>
        {shaper.kinds.length > 0 && <ReviewLine term="Task kinds">{shaper.kinds.join(", ")}</ReviewLine>}
        {shaper.repositories.length > 0 && <ReviewLine term="Repositories">{shaper.repositories.join(", ")}</ReviewLine>}
      </dl>
      <div className="shaping-receives">
        <h4>{receives.remote ? "What it is sent" : "What it can reach"}</h4>
        <ul>{receives.sent.map((line) => <li key={line}>{line}</li>)}</ul>
        {receives.never && <p>{receives.never}</p>}
      </div>
    </section>
  );
}

/**
 * Import one manifest: pasted JSON or a chosen file, read with the daemon's own schema, and
 * reviewed in full before anything is saved. Saving stores it switched off, whatever its
 * manifest says and whatever was stored for its id before. A manifest the schema refuses -
 * a literal credential included - shows its reason, and there is nothing to save.
 */
export function ShapingImportDialog({ config, busy, error, onClose, onSave }: {
  config: ShapingConfigView;
  busy: boolean;
  /** The daemon's refusal of the last save, if any. */
  error: string | null;
  onClose: () => void;
  onSave: (shaper: Shaper) => Promise<void>;
}): React.JSX.Element {
  const [text, setText] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  // The daemon's refusal is shown only for a save made in this dialog, never one left over from
  // an earlier import.
  const [saved, setSaved] = useState(false);
  const reading = text.trim() === "" ? null : readShaperManifest(text);
  const existing = reading?.ok ? config.shapers.find((entry) => entry.id === reading.shaper.id) : undefined;
  const choose = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    setFileError(null);
    try {
      setText(await file.text());
    } catch (cause) {
      setFileError(`Could not read ${file.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };
  return (
    <Overlay id={OVERLAY_IDS.shapingImport} className="modal shaping-dialog" role="dialog" ariaModal ariaLabel="Import a shaper"
      onClose={onClose} closable={!busy}>
      <header className="modal-head"><h3>Import a shaper</h3></header>
      <div className="modal-body">
        <p className="shaping-dialog-lede">
          Paste a shaper manifest or choose its file. Review exactly what it runs or calls before you save it.
          It is saved switched off.
        </p>
        <label className="shaping-field" htmlFor="shaping-manifest">
          <span>Manifest</span>
          <textarea id="shaping-manifest" className="field-input field-textarea shaping-manifest" rows={8} spellCheck={false} value={text} placeholder='{ "id": "repo-notes", "label": "Repository notes", … }'
            onChange={(event) => setText(event.target.value)} />
        </label>
        <label className="shaping-file">
          <span className="btn btn-ghost">Choose a file…</span>
          <input type="file" accept=".json,application/json" aria-label="Choose a manifest file" className="sr-only"
            onChange={(event) => { void choose(event.target.files?.[0]); event.target.value = ""; }} />
        </label>
        {fileError && <p role="alert">{fileError}</p>}
        {reading && !reading.ok && <p role="alert" className="shaping-refusal">{reading.reason}</p>}
        {reading?.ok && (
          <>
            <ShaperReview shaper={reading.shaper} />
            {existing && (
              <p className="shaping-note">
                {isUnsupportedShaper(existing)
                  ? `A shaper this build cannot run already has the id "${reading.shaper.id}". It can only be removed.`
                  : `This replaces the registered shaper "${existing.label}" and switches it off.`}
              </p>
            )}
            {reading.ignoredEnabled && (
              <p className="shaping-note">The manifest&apos;s &quot;enabled&quot; does not apply here: an imported shaper is saved switched off.</p>
            )}
          </>
        )}
        {saved && error && <p role="alert" className="shaping-refusal">{error}</p>}
      </div>
      <footer className="modal-foot">
        <Tooltip label="Close without saving anything">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        </Tooltip>
        <Tooltip label="Store this shaper switched off in every window">
          <button type="button" className="btn" disabled={!reading?.ok || busy}
            onClick={() => { if (reading?.ok) { setSaved(true); void onSave(reading.shaper); } }}>Save switched off</button>
        </Tooltip>
      </footer>
    </Overlay>
  );
}

const OUTCOME_LABEL: Record<string, string> = {
  ok: "OK", degraded: "Degraded", failed: "Failed", timed_out: "Timed out", invalid: "Invalid reply", unavailable: "Unavailable",
};

/**
 * Dry-run one shaper against a repository Mission Control knows: whatever its stored choice,
 * nothing is saved, and closing the dialog stops the run.
 */
export function ShapingTestDialog({ id, label, repositories, onTest, onClose }: {
  id: string;
  label: string;
  repositories: () => Promise<string[]>;
  onTest: ShapingTestRunner;
  onClose: () => void;
}): React.JSX.Element {
  const [repos, setRepos] = useState<string[]>([]);
  const [repository, setRepository] = useState("");
  const [prompt, setPrompt] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ShapingRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    let live = true;
    void repositories().then((list) => {
      if (!live) return;
      setRepos(list);
      setRepository((current) => current || (list[0] ?? ""));
    });
    return () => { live = false; };
  }, [repositories]);
  useEffect(() => () => controller.current?.abort(), []);
  const run = async (): Promise<void> => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setRunning(true);
    setError(null);
    setResult(null);
    const answer = await onTest({ id, repository: repository.trim(), prompt }, abort.signal);
    if (abort.signal.aborted) return;
    setRunning(false);
    if (answer.ok) setResult(answer.run);
    else setError(answer.reason);
  };
  const summary = result?.summary?.shapers.find((entry) => entry.id === id) ?? result?.summary?.shapers[0] ?? null;
  return (
    <Overlay id={OVERLAY_IDS.shapingTest} className="modal shaping-dialog" role="dialog" ariaModal ariaLabel={`Dry-run ${label}`}
      onClose={onClose}>
      <header className="modal-head"><h3>Dry-run {label}</h3></header>
      <div className="modal-body">
        <p className="shaping-dialog-lede">
          Runs this one shaper now, whether or not it is switched on, and shows what it would add to a
          worker&apos;s first prompt. Nothing is saved.
        </p>
        <div className="shaping-field">
          <label htmlFor="shaping-test-repo">Repository</label>
          <RepoCombobox id="shaping-test-repo" repos={repos} value={repository} onChange={setRepository}
            disabled={running} placeholder="/path/to/repository" />
        </div>
        <label className="shaping-field" htmlFor="shaping-test-prompt">
          <span>Prompt (optional)</span>
          <textarea id="shaping-test-prompt" className="field-input field-textarea" rows={3} value={prompt} disabled={running}
            placeholder="What the task asks for, as a worker would receive it" onChange={(event) => setPrompt(event.target.value)} />
        </label>
        {error && <p role="alert" className="shaping-refusal">{error}</p>}
        {running && <p className="shaping-note" role="status">Running {label}…</p>}
        {result && (
          <section className="shaping-result" aria-label="Dry-run result">
            {summary ? (
              <p className={`shaping-outcome is-${summary.outcome}`}>
                <strong>{OUTCOME_LABEL[summary.outcome] ?? summary.outcome}</strong>
                <span>{`${summary.durationMs.toLocaleString()} ms`}</span>
                {summary.version && <span>{`version ${summary.version}`}</span>}
                {summary.truncated && <span>truncated</span>}
                {summary.redacted && <span>a credential value was removed from its reply</span>}
              </p>
            ) : <p className="shaping-note">It did not apply to this repository.</p>}
            {summary?.reason && <p className="shaping-reason">{summary.reason}</p>}
            <h4>{result.entries.length === 0
              ? "Nothing would be added."
              : `${result.entries.length} ${result.entries.length === 1 ? "entry" : "entries"} would be added`}</h4>
            {result.entries.map((entry) => (
              <article className="shaping-entry" key={`${entry.repo}:${entry.id}`} aria-label={entry.title ?? entry.id}>
                <header>
                  <strong>{entry.title ?? entry.id}</strong>
                  <code>{entry.id}</code>
                  {entry.truncated && <span>{`truncated, ${entry.omittedBytes.toLocaleString()} bytes omitted`}</span>}
                </header>
                <pre>{entry.body}</pre>
              </article>
            ))}
          </section>
        )}
      </div>
      <footer className="modal-foot">
        <Tooltip label="Close, and stop the run if it is still going">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
        </Tooltip>
        <Tooltip label="Run this shaper once against the repository">
          <button type="button" className="btn" disabled={running || repository.trim() === ""} onClick={() => void run()}>
            {running ? "Running…" : "Run"}
          </button>
        </Tooltip>
      </footer>
    </Overlay>
  );
}
