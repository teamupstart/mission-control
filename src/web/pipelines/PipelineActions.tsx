import { useEffect, useRef, useState } from "react";
import {
  PIPELINE_ACTION_INFO,
  PIPELINE_CONSOLE_INFO,
  PIPELINE_PROVIDER_INFO,
  PIPELINE_CONTROL_LIMITS,
  PIPELINE_UNGRANTABLE_STEPS,
  pipelineGrantRefusal,
  pipelineGrantableSteps,
  type PipelineAction,
  type PipelineConsole,
  type PipelineRun,
} from "@shared/pipeline.ts";
import type { TerminalBackendId } from "@shared/terminal.ts";
import { LaunchList } from "../components/LaunchMenu.tsx";
import { Tooltip } from "../components/Tooltip.tsx";
import { openPipelineConsole, runPipelineAction } from "../lib/api.ts";
import { useTerminalTargets } from "../lib/terminalTargets.ts";

/**
 * The verbs and consoles one pipeline run offers, drawn once for both surfaces that offer them.
 *
 * ONE component for the run header and the attention row, and that is the load-bearing
 * decision here rather than a saving: a grant is a step, a rationale and a refusal an operator
 * has to read, and two copies of that form would be two places to get the rationale wrong. The
 * hosts differ only in WHICH verbs they pass - the header offers what the run's state makes
 * useful, the inbox offers what the halt's class calls for - so `actions` and `consoles` are
 * props rather than something this component derives.
 *
 * Nothing here re-reads the run afterwards. Every verb re-projects on the daemon and arrives
 * back as `pipeline_upsert` on the stream that already owns the row, so a component that
 * refetched would be a second, racing copy of a record the app is already given. `onRefresh`
 * exists for the one fact that is NOT on that stream: the daemon chip, which the rail polls.
 */

/**
 * What came back, in the two parts an operator needs: our sentence, and the engine's.
 *
 * A failure carries the ENGINE'S OWN WORDS, and that is the whole point of the stdout
 * posture rather than a nicety. conductor exits 0 on a malformed invocation and answers with
 * a refusal about an unrelated subcommand, so `detail` can only ever say "it exited cleanly
 * without confirming this" - a sentence that is true, useless on its own, and reads exactly
 * the same for a version skew, a wrong working directory and a feature the engine has never
 * heard of. The route already carries the clipped output and the command it ran; dropping
 * them here would have thrown away the only thing that tells those three apart.
 *
 * A success clears itself. A FAILURE DOES NOT: it is now a transcript to read rather than a
 * sentence to glance at, and one that vanished on a timer while somebody was reading it
 * would be worse than none. It goes when the operator dismisses it, or when the next verb
 * replaces it.
 */
interface Flash {
  text: string;
  error: boolean;
  /** The exact command the daemon spawned, shown so a failure can be reproduced by hand. */
  command?: string;
  /** What the engine printed, already clipped by the daemon. */
  output?: string;
}

/** One console button and the backend chooser it opens. */
function ConsoleButton({
  console_,
  blocked,
  busy,
  onChoose,
}: {
  console_: PipelineConsole;
  /** Why this cannot be opened, as a sentence, or null when it can. */
  blocked: string | null;
  busy: boolean;
  onChoose: (backend: TerminalBackendId) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const { targets, failed } = useTerminalTargets();
  const info = PIPELINE_CONSOLE_INFO[console_];

  // Escape closes the chooser and nothing else. Taken in the capture phase and stopped
  // immediately, above every other claimant, because this menu can be open over the attention
  // inbox - and an Escape that dismissed both would close a modal the operator was reading.
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      event.stopImmediatePropagation();
      event.preventDefault();
      setOpen(false);
      root.current?.querySelector<HTMLButtonElement>(".pipelines-action")?.focus();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  // Pointerdown rather than click, matching the session launchers: a press that starts
  // outside should dismiss before whatever it lands on acts, so one press does one thing.
  useEffect(() => {
    if (!open) return;
    function onDown(event: PointerEvent): void {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [open]);

  return (
    <span className="launch pipelines-console" ref={root}>
      <Tooltip label={blocked ?? info.blurb}>
        <button
          type="button"
          className="btn btn-ghost pipelines-action"
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={blocked !== null || busy}
          onClick={() => setOpen((value) => !value)}
        >
          {info.label}
          <span className="launch-caret" aria-hidden>
            ▾
          </span>
        </button>
      </Tooltip>
      {open && (
        <div className="launch-pop" role="menu" aria-label={info.label}>
          <span className="launch-head">{info.verb}</span>
          <LaunchList
            targets={targets}
            failed={failed}
            verb={info.verb}
            onChoose={(target) => {
              setOpen(false);
              onChoose(target.id);
            }}
          />
        </div>
      )}
    </span>
  );
}

export function PipelineActions({
  run,
  actions,
  consoles,
  onRefresh,
}: {
  run: PipelineRun;
  /** The verbs this host offers, in the order it wants them read. */
  actions: readonly PipelineAction[];
  /** The hosted terminals this host offers. */
  consoles: readonly PipelineConsole[];
  /** Re-read what the host polls - the daemon chip - now that a verb may have moved it. */
  onRefresh?: () => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [form, setForm] = useState<"grant" | "reseal" | null>(null);
  const grantable = pipelineGrantableSteps(run.provider);
  const [step, setStep] = useState(grantable[0]?.name ?? "");
  const [grantReason, setGrantReason] = useState("");
  const [paths, setPaths] = useState("");
  const [resealReason, setResealReason] = useState("");
  // The engine only clears a halt it raised over a seal, so this is pre-answered for the run
  // that is in that state and left alone for every other - the operator is agreeing with what
  // they are looking at rather than being asked a question the run has already answered.
  const [clearHalt, setClearHalt] = useState(run.halt?.class === "protected-artifact");

  // A confirmation clears itself, on the session launchers' own timing. A failure does not -
  // see `Flash`: it carries the engine's transcript, and a transcript on a timer is one an
  // operator races rather than reads.
  useEffect(() => {
    if (!flash || flash.error) return;
    const timer = setTimeout(() => setFlash(null), 3500);
    return () => clearTimeout(timer);
  }, [flash]);

  const resealPaths = paths
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

  async function act(action: PipelineAction): Promise<void> {
    const info = PIPELINE_ACTION_INFO[action];
    setBusy(action);
    const result = await runPipelineAction({
      provider: run.provider,
      repoRoot: run.repoRoot,
      // From the record rather than from the caller, so a repository verb can never be sent
      // carrying a slug - which the engine would read as "pause this feature" and answer by
      // pausing every feature in the checkout.
      slug: info.scope === "run" ? run.slug : null,
      action,
      step: info.needsStep ? step : null,
      reason: info.needsReason ? grantReason.trim() || null : null,
    });
    setBusy(null);
    setFlash({
      text: result.detail,
      error: !result.ok,
      // Only on a failure. A successful verb's output is a sentence we have just restated in
      // our own words, and showing both invites the reader to look for the difference.
      ...(result.ok ? {} : { command: result.command, output: result.output }),
    });
    if (!result.ok) return;
    if (info.needsReason) setGrantReason("");
    setForm(null);
    onRefresh?.();
  }

  async function openConsole(console_: PipelineConsole, backend: TerminalBackendId): Promise<void> {
    setBusy(console_);
    const reseal = console_ === "reseal";
    const result = await openPipelineConsole({
      provider: run.provider,
      repoRoot: run.repoRoot,
      slug: PIPELINE_CONSOLE_INFO[console_].scope === "run" ? run.slug : null,
      console: console_,
      paths: reseal ? resealPaths : [],
      reason: reseal ? resealReason.trim() : "",
      clearHalt: reseal ? clearHalt : false,
      backend,
    });
    setBusy(null);
    setFlash(
      result.ok
        ? {
            // Deliberately not "resealed" or "attached": what happened is that a window
            // opened. What the ceremony then decides happens in front of the person watching
            // it, and claiming its outcome from here would be claiming an outcome nothing
            // read.
            text: `Opened in ${result.label || backend} - read it there`,
            error: false,
          }
        : { text: result.error ?? "could not open a terminal", error: true },
    );
  }

  const engine = PIPELINE_PROVIDER_INFO[run.provider].label;
  // Every step this provider refuses to grant, explained rather than merely absent: a picker
  // that silently omitted the one step an operator came looking for reads as a build that has
  // fallen behind the engine.
  const ungrantable = PIPELINE_UNGRANTABLE_STEPS[run.provider]
    .map((name) => pipelineGrantRefusal(run.provider, name))
    .filter((line): line is string => line !== null);

  return (
    <div className="pipelines-actions">
      <div className="pipelines-action-row">
        {actions.map((action) => {
          const info = PIPELINE_ACTION_INFO[action];
          // The two verbs that carry an operator's own words open a form instead of firing.
          const opens = info.needsStep || info.needsReason;
          return (
            <Tooltip key={action} label={info.blurb}>
              <button
                type="button"
                className="btn btn-ghost pipelines-action"
                disabled={busy !== null || (opens && grantable.length === 0)}
                aria-expanded={opens ? form === "grant" : undefined}
                onClick={() =>
                  opens ? setForm(form === "grant" ? null : "grant") : void act(action)
                }
              >
                {info.label}
                {opens && (
                  <span className="launch-caret" aria-hidden>
                    ▾
                  </span>
                )}
              </button>
            </Tooltip>
          );
        })}
        {consoles.map((console_) =>
          console_ === "reseal" ? (
            <Tooltip key={console_} label={PIPELINE_CONSOLE_INFO[console_].blurb}>
              <button
                type="button"
                className="btn btn-ghost pipelines-action"
                disabled={busy !== null}
                aria-expanded={form === "reseal"}
                onClick={() => setForm(form === "reseal" ? null : "reseal")}
              >
                {/* The ceremony's own button is inside the form, where it can say which
                    terminal it will open in. This one only unfolds the form, so it is named
                    for that - two controls sharing "Open reseal terminal" would be two
                    different promises under one word. */}
                Reseal an artifact
                <span className="launch-caret" aria-hidden>
                  ▾
                </span>
              </button>
            </Tooltip>
          ) : (
            <ConsoleButton
              key={console_}
              console_={console_}
              blocked={null}
              busy={busy !== null}
              onChoose={(backend) => void openConsole(console_, backend)}
            />
          ),
        )}
      </div>

      {form === "grant" && (
        <form
          className="pipelines-form"
          aria-label="Grant DECIDE re-entry"
          onSubmit={(event) => {
            event.preventDefault();
            void act("grant");
          }}
        >
          <label className="pipelines-field">
            <span>Step</span>
            <Tooltip label={`The DECIDE step ${run.slug} may re-enter once`}>
              <select value={step} onChange={(event) => setStep(event.target.value)}>
                {grantable.map((entry) => (
                  <option key={entry.name} value={entry.name}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </Tooltip>
          </label>
          <label className="pipelines-field">
            <span>Why you are allowing it</span>
            <input
              type="text"
              value={grantReason}
              maxLength={PIPELINE_CONTROL_LIMITS.reasonBytes}
              placeholder="what changed since the gate refused"
              onChange={(event) => setGrantReason(event.target.value)}
            />
          </label>
          <p className="pipelines-note">
            One entry, spent on the next dispatch and never renewed on its own. {engine} records
            it against your name.
          </p>
          {ungrantable.map((line) => (
            <p className="pipelines-note is-refusal" key={line}>
              {line}
            </p>
          ))}
          <div className="pipelines-form-foot">
            <Tooltip
              label={
                grantReason.trim() === ""
                  ? `${engine} records why an autonomous re-entry was allowed - say what changed`
                  : `Record the grant with ${engine}. It is spent on the next dispatch.`
              }
            >
              <button
                type="submit"
                className="btn btn-primary"
                disabled={busy !== null || step === "" || grantReason.trim() === ""}
              >
                Grant
              </button>
            </Tooltip>
          </div>
        </form>
      )}

      {form === "reseal" && (
        <div className="pipelines-form" role="group" aria-label="Reseal a protected artifact">
          <label className="pipelines-field">
            <span>Artifacts, one path per line</span>
            <textarea
              rows={3}
              value={paths}
              placeholder={".docs/decisions/" + run.slug + ".md"}
              onChange={(event) => setPaths(event.target.value)}
            />
          </label>
          <label className="pipelines-field">
            <span>Why they changed</span>
            <input
              type="text"
              value={resealReason}
              maxLength={PIPELINE_CONTROL_LIMITS.reasonBytes}
              placeholder="what moved, and who agreed to it"
              onChange={(event) => setResealReason(event.target.value)}
            />
          </label>
          <label className="pipelines-check">
            <Tooltip label={`Pass --clear-halt, so ${engine} lifts the halt the broken seal raised`}>
              <input
                type="checkbox"
                checked={clearHalt}
                onChange={(event) => setClearHalt(event.target.checked)}
              />
            </Tooltip>
            <span>Also clear the halt this raised</span>
          </label>
          <p className="pipelines-note">
            {engine} refuses to re-seal without a terminal, so this opens one and runs the
            ceremony in front of you. Nothing is re-sealed until you read what it says.
          </p>
          <div className="pipelines-form-foot">
            <ConsoleButton
              console_="reseal"
              blocked={
                resealPaths.length === 0
                  ? "name at least one sealed artifact, one path per line"
                  : resealReason.trim() === ""
                    ? `${engine} records why a seal was broken - say what moved`
                    : resealPaths.length > PIPELINE_CONTROL_LIMITS.paths
                      ? `one ceremony re-seals at most ${PIPELINE_CONTROL_LIMITS.paths} artifacts`
                      : null
              }
              busy={busy !== null}
              onChoose={(backend) => void openConsole("reseal", backend)}
            />
          </div>
        </div>
      )}

      {flash && (
        <div
          className={`pipelines-flash${flash.error ? " is-error" : ""}`}
          role={flash.error ? "alert" : "status"}
        >
          <p className="pipelines-flash-line">{flash.text}</p>
          {/* The engine's own transcript, verbatim and already clipped by the daemon. It is
              the whole difference between "conductor refused this" and knowing WHY, and it
              is the only place the operator can see that the refusal was about a subcommand
              they never asked for - which is what a version skew looks like from here. */}
          {flash.error && (flash.output || flash.command) && (
            <>
              {flash.command && (
                <pre className="pipelines-transcript is-command">
                  <code>{flash.command}</code>
                </pre>
              )}
              {flash.output && (
                <pre className="pipelines-transcript">
                  <code>{flash.output}</code>
                </pre>
              )}
            </>
          )}
          {flash.error && (
            <div className="pipelines-form-foot">
              <Tooltip label="Dismiss what the engine said">
                <button
                  type="button"
                  className="btn btn-ghost pipelines-action"
                  onClick={() => setFlash(null)}
                >
                  Dismiss
                </button>
              </Tooltip>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
