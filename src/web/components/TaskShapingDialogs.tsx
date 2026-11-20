import { useEffect, useRef, useState } from "react";
import { SHAPING_LIMITS, type Shaper, type ShapingConfigView, type ShapingRun } from "@shared/shaping.ts";
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

/**
 * The most manifest text the dialog takes, pasted or from a file, before anything parses it. A
 * stored definition is at most `SHAPING_LIMITS.entryJsonBytes` of JSON; this leaves room for a
 * pretty-printed manifest and refuses a document that would stall the window while parsing.
 */
const MANIFEST_INPUT_MAX_CHARS = 4 * SHAPING_LIMITS.entryJsonBytes;

/** Runs one dry run for the dialog. A failed request, as opposed to a failed shaper, is `ok: false`. */
export type ShapingTestRunner = (
  request: { id: string; repository: string; prompt: string; expect?: string },
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
 * Refusals of earlier writes under one control that arrived after a newer write went out. They
 * are listed apart from the control's current refusal, which stays the reason its latest action
 * failed. The polite live region is always present, so a refusal that arrives while the current
 * one is unchanged is still announced: a region inserted together with its content often is not.
 */
export function EarlierRefusals({ messages }: { messages: readonly string[] | undefined }): React.JSX.Element {
  return (
    <div className="shaping-earlier-live" aria-live="polite">
      {messages && messages.length > 0 && (
        <ul className="shaping-earlier-refusals" aria-label="Earlier refusals">
          {messages.map((message, at) => <li key={at}>{message}</li>)}
        </ul>
      )}
    </div>
  );
}

/**
 * Import one manifest: pasted JSON or a chosen file, read with the daemon's own schema, and
 * reviewed in full before anything is saved. Saving stores it switched off, whatever its
 * manifest says and whatever was stored for its id before. A manifest the schema refuses -
 * a literal credential included - shows its reason, and there is nothing to save.
 */
export function ShapingImportDialog({ config, busy, saving, error, earlier, fresh = false, onClose, onSave }: {
  config: ShapingConfigView;
  /** Whether Save is unavailable: a write in flight, or no connection to the daemon. */
  busy: boolean;
  /** Whether this dialog's own save is in flight. Only that holds the dialog open. */
  saving: boolean;
  /** The daemon's refusal of the last save, if any. */
  error: string | null;
  /** Refusals of earlier saves that arrived after a newer one went out. */
  earlier?: readonly string[];
  /**
   * Whether the outcome arrived after this dialog opened, as a save from a dialog closed
   * meanwhile can: shown here although this dialog has saved nothing yet.
   */
  fresh?: boolean;
  onClose: () => void;
  /**
   * Store the reviewed shaper. Resolves true when it was saved and this dialog is still the one
   * that sent it, so it may close.
   */
  onSave: (shaper: Shaper) => Promise<boolean>;
}): React.JSX.Element {
  const [text, setText] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  // The name of a chosen file still being read, or null. Nothing can be saved meanwhile.
  const [readingFile, setReadingFile] = useState<string | null>(null);
  // The daemon's refusal is shown only for a save made in this dialog, never one left over from
  // an earlier import.
  const [saved, setSaved] = useState(false);
  // Bumped by every edit and every chosen file, so a file read that finishes late never replaces
  // what the operator typed or chose after it.
  const generation = useRef(0);
  /** Numbers each Save in this dialog. */
  const submissions = useRef(0);
  const reading = text.trim() === "" ? null : readShaperManifest(text);
  const existing = reading?.ok ? config.shapers.find((entry) => entry.id === reading.shaper.id) : undefined;
  const tooLarge = `A manifest is at most ${(MANIFEST_INPUT_MAX_CHARS / 1024).toLocaleString()} KiB of text here; a definition the daemon stores is at most ${SHAPING_LIMITS.entryJsonBytes / 1024} KiB.`;
  const edit = (value: string): void => {
    generation.current += 1;
    setReadingFile(null);
    if (value.length > MANIFEST_INPUT_MAX_CHARS) {
      // The reviewed manifest no longer stands for what the operator meant to import, so it goes:
      // Save must never store what was on screen before an input the dialog refused.
      setText("");
      setInputError(tooLarge);
      return;
    }
    setInputError(null);
    setText(value);
  };
  const choose = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    const mine = ++generation.current;
    // Choosing a file replaces whatever was reviewed: nothing can be saved until this file has
    // been read and reviewed, and a file that fails to read leaves nothing to save.
    setText("");
    setInputError(null);
    // Checked before reading, so a large file is never read into memory or parsed.
    if (file.size > MANIFEST_INPUT_MAX_CHARS) {
      setReadingFile(null);
      setInputError(`${file.name} is ${file.size.toLocaleString()} bytes. ${tooLarge}`);
      return;
    }
    setReadingFile(file.name);
    try {
      const content = await file.text();
      if (mine === generation.current) setText(content);
    } catch (cause) {
      if (mine === generation.current) setInputError(`Could not read ${file.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      if (mine === generation.current) setReadingFile(null);
    }
  };
  return (
    <Overlay id={OVERLAY_IDS.shapingImport} className="modal shaping-dialog" role="dialog" ariaModal ariaLabel="Import a shaper"
      onClose={onClose} closable={!saving}>
      <header className="modal-head"><h3>Import a shaper</h3></header>
      <div className="modal-body">
        <p className="shaping-dialog-lede">
          Paste a shaper manifest or choose its file. Review exactly what it runs or calls before you save it.
          It is saved switched off.
        </p>
        <label className="shaping-field" htmlFor="shaping-manifest">
          <span>Manifest</span>
          <textarea id="shaping-manifest" className="field-input field-textarea shaping-manifest" rows={8} spellCheck={false} value={text} placeholder='{ "id": "repo-notes", "label": "Repository notes", … }'
            onChange={(event) => edit(event.target.value)} />
        </label>
        <label className="shaping-file">
          <span className="btn btn-ghost">Choose a file…</span>
          <input type="file" accept=".json,application/json" aria-label="Choose a manifest file" className="sr-only"
            onChange={(event) => { void choose(event.target.files?.[0]); event.target.value = ""; }} />
        </label>
        {inputError && <p role="alert" className="shaping-refusal">{inputError}</p>}
        {readingFile && <p className="shaping-note" role="status">Reading {readingFile}…</p>}
        {reading && !reading.ok && <p role="alert" className="shaping-refusal">{reading.reason}</p>}
        {reading?.ok && (
          <>
            <ShaperReview shaper={reading.shaper} />
            {existing && (
              <p className="shaping-note">
                {isUnsupportedShaper(existing) && existing.replaceable !== true
                  ? `A shaper this build cannot run already has the id "${reading.shaper.id}". It can only be switched off or removed, so this import will be refused.`
                  : `This replaces the registered shaper "${existing.label}" and switches it off.`}
              </p>
            )}
            {reading.ignoredEnabled && (
              <p className="shaping-note">The manifest&apos;s &quot;enabled&quot; does not apply here: an imported shaper is saved switched off.</p>
            )}
          </>
        )}
        {(saved || fresh) && error && <p role="alert" className="shaping-refusal">{error}</p>}
        <EarlierRefusals messages={saved || fresh ? earlier : undefined} />
      </div>
      <footer className="modal-foot">
        <Tooltip label="Close without saving anything">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
        </Tooltip>
        <Tooltip label="Store this shaper switched off in every window">
          <button type="button" className="btn" disabled={!reading?.ok || readingFile !== null || busy}
            onClick={() => {
              if (!reading?.ok) return;
              setSaved(true);
              // The stream can free this dialog before the answer lands, and the operator may
              // paste another manifest or choose another file meanwhile: a late success closes the
              // dialog only while it still shows what was saved.
              // Each submission is numbered, so only the latest one's success may close it: the
              // same manifest saved twice shares a draft generation.
              const submitted = generation.current;
              const submission = ++submissions.current;
              void onSave(reading.shaper).then((close) => {
                if (close && generation.current === submitted && submissions.current === submission) onClose();
              });
            }}>Save switched off</button>
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
export function ShapingTestDialog({ id, label, revision, current, repositories, onTest, onClose }: {
  id: string;
  label: string;
  /** The daemon's revision of the definition the operator chose to dry-run. Sent with the run. */
  revision: string | null;
  /** The revision stored for this id now, or null once it is gone. */
  current: string | null;
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
    // Bound to the definition this dialog was opened for: the daemon refuses the run if it has
    // been replaced since, so a replacement is never run under this name.
    const answer = await onTest({ id, repository: repository.trim(), prompt, ...(revision ? { expect: revision } : {}) }, abort.signal);
    if (abort.signal.aborted) return;
    setRunning(false);
    if (answer.ok) setResult(answer.run);
    else setError(answer.reason);
  };
  const summary = result?.summary?.shapers.find((entry) => entry.id === id) ?? result?.summary?.shapers[0] ?? null;
  // Another window replaced or removed this shaper while the dialog was open.
  const replaced = current !== revision;
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
        {replaced && (
          <p role="alert" className="shaping-refusal">
            {current === null
              ? `${label} was removed in another window, so it cannot be dry-run.`
              : `${label} was replaced in another window since this dialog opened. Close it and dry-run the new definition from its row.`}
          </p>
        )}
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
          <button type="button" className="btn" disabled={running || replaced || repository.trim() === ""} onClick={() => void run()}>
            {running ? "Running…" : "Run"}
          </button>
        </Tooltip>
      </footer>
    </Overlay>
  );
}
