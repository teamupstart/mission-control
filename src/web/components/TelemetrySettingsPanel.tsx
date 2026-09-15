import { useEffect, useState } from "react";
import type {
  TelemetryProfileId,
  TelemetryProfileSummary,
  TelemetryPauseReason,
} from "@shared/telemetry.ts";
import { validateEndpoint } from "@shared/telemetry-endpoint.ts";
import type { TelemetryState } from "../useTelemetry.ts";
import { Tooltip } from "./Tooltip.tsx";

// The general telemetry section: what this installation collects about itself, where it sends
// it, and what is stuck.
//
// This is NOT the Cost section, and the distinction is the first thing the copy has to make.
// Cost configures Claude Code exporting ITS usage INTO Mission Control, over a receiver this
// daemon runs. This configures Mission Control exporting ITS OWN facts OUT. They share no
// storage, no queue and no consent, and one switch over two unrelated consents is precisely
// the thing the design refuses.
//
// Three independent destinations, three independent opt-ins:
//
//   local    collection with no endpoint at all - kept on this machine, sent nowhere. This is
//            what the master switch alone gives you, and it is a complete, useful state.
//   user     the operator's own OTLP backend. Their infrastructure, their data.
//   product  the minimized audience: a second destination carrying only the facts that mean
//            something off this machine, never the diagnostics that are only about this
//            installation. Mission Control hosts no public analytics service, so no address is
//            baked in and none is implied - an operator who runs their own minimized collector
//            points this at it, and until they do it reports unavailable rather than offering a
//            switch that would queue for somewhere that cannot answer.
//
// Every destructive control confirms in place rather than in a modal. Purging a queue and
// resetting an identity are irreversible, and a second click on a button that has changed its
// own label is a cheaper confirmation than a dialog for an action taken this rarely.

/** How long a confirm-in-place button stays armed before it goes back to being safe. */
const CONFIRM_MS = 5000;

export function TelemetrySettingsPanel({ state }: { state: TelemetryState }): React.JSX.Element {
  const { summary, status, health, error, conflict, notice, probe, busy, update, operate } = state;
  const config = status?.config ?? null;
  const enabled = config?.enabled ?? false;

  return (
    <section className="settings-section">
      <p className="settings-hint settings-blurb">
        Mission Control can record what it does - sessions, workflows, errors - as OpenTelemetry
        metrics and traces. It is <strong>off until you turn it on</strong>, and turning it on
        collects to this machine only. Sending anything anywhere needs a second, separate decision
        below. This is the opposite direction from the <strong>Cost</strong> section, which
        configures Claude Code reporting its usage <em>to</em> this daemon.
      </p>

      {summary === null && (
        // Not "off". A dashboard that has not received a snapshot yet, or one talking to a
        // daemon too old to report this, knows nothing - and drawing a confident all-clear over
        // that is the one thing a consent surface must never do.
        <p className="settings-warn">
          This daemon has not reported its telemetry state yet, so nothing below is known to be
          current.
        </p>
      )}

      {error && (
        <p className="settings-error">
          {conflict ? "Not saved. " : ""}
          {error}
        </p>
      )}
      {notice && <p className="settings-hint">{notice}</p>}

      <div className="kb-row" data-anchor="telemetry/collect">
        <div className="kb-row-text">
          <span className="kb-row-label">Collect telemetry on this machine</span>
          <span className="kb-row-desc">
            Records Mission Control's own activity into its local database. Nothing leaves this
            machine unless you configure a destination below. Switching this off stops collection
            and drops anything that had not been sent; data a backend already accepted cannot be
            recalled.
          </span>
        </div>
        <div className="kb-row-controls">
          <Tooltip label="Record this app's own activity locally, sending it nowhere">
            <label className="skill-switch">
              <input
                type="checkbox"
                checked={enabled}
                disabled={!config || busy === "config"}
                onChange={(e) => void update({ enabled: e.target.checked })}
                aria-label="Collect Mission Control telemetry on this machine"
              />
            </label>
          </Tooltip>
        </div>
      </div>

      {enabled && (
        <p className="settings-hint">
          Collecting locally. Everything recorded stays in this daemon's database and is pruned on
          its own schedule.
        </p>
      )}

      <LocalProfile state={state} />
      <UserDestination state={state} />
      <ProductDestination state={state} />
      <Coverage state={state} />
      <Identity state={state} />

      {probe && (
        <p className={probe.outcome === "accepted" ? "settings-hint" : "settings-error"}>
          Connection test: {probe.outcome.replace(/_/g, " ")} in {probe.latencyMs}ms. {probe.detail}{" "}
          {probe.traceId && (
            <>
              This test produced trace <code>{probe.traceId}</code>, which you can search for in
              your backend once the next export lands. It is a synthetic check, not a record of
              anything the app did.
            </>
          )}
        </p>
      )}

      {health && health.gaps.length > 0 && (
        <div className="kb-row" data-anchor="telemetry/gaps">
          <div className="kb-row-text">
            <span className="kb-row-label">Incomplete coverage</span>
            <span className="kb-row-desc">
              Things that were not recorded, counted rather than guessed at. A gap does not mean the
              app misbehaved - it means this record is known to be missing something, which matters
              when you are reading a chart built from it.
            </span>
            <ul className="settings-hint">
              {health.gaps.map((gap) => (
                <li key={gap.kind}>
                  <strong>{gap.kind.replace(/_/g, " ")}</strong>: {gap.count}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}

/** Local-only capture: a destination with no endpoint, and the one the master switch gives you. */
function LocalProfile({ state }: { state: TelemetryState }): React.JSX.Element | null {
  const local = profile(state, "local");
  if (!state.summary?.enabled) return null;
  return (
    <div className="kb-row" data-anchor="telemetry/local">
      <div className="kb-row-text">
        <span className="kb-row-label">On this machine</span>
        <span className="kb-row-desc">
          Saved locally, which means committed to this daemon's database - not queued somewhere that
          a restart would lose. {local ? describeLocal(local) : ""}
        </span>
        {state.health && (
          <span className="kb-row-desc">
            Using {formatBytes(state.health.usedBytes)} of {formatBytes(state.health.maxBytes)}.
          </span>
        )}
      </div>
      <div className="kb-row-controls">
        <ConfirmButton
          label="Clear local data"
          confirmLabel="Confirm clear"
          tooltip="Delete what this machine has collected locally."
          busy={state.busy === "purge:local"}
          disabled={state.busy !== null}
          ariaLabel="Clear locally collected telemetry"
          onConfirm={() => void state.operate("purge", "local")}
        />
      </div>
    </div>
  );
}

/**
 * The operator's own backend.
 *
 * The endpoint and credential are drafted locally and saved together, rather than written on
 * every keystroke: half a URL is a different destination, and a destination change costs a
 * generation bump and refuses the batches built for the previous one.
 */
function UserDestination({ state }: { state: TelemetryState }): React.JSX.Element {
  const { status, summary, busy, update } = state;
  const config = status?.config ?? null;
  const user = profile(state, "user");
  const [endpoint, setEndpoint] = useState("");
  const [headerName, setHeaderName] = useState("authorization");
  const [credential, setCredential] = useState("");
  const [dirty, setDirty] = useState(false);

  // Adopt the stored values whenever the daemon's copy changes, unless the operator is midway
  // through an edit - in which case their typing wins until they save or the panel remounts.
  useEffect(() => {
    if (dirty || !config) return;
    setEndpoint(config.user.endpoint);
    setHeaderName(config.user.headerName);
  }, [config, dirty]);

  const credentialAfter = credential.length > 0 || (status?.userCredentialConfigured ?? false);
  // The SAME predicate the daemon applies, imported rather than reimplemented - which is what
  // makes "the form and the API agree" a fact instead of an intention.
  const check =
    endpoint.trim().length > 0
      ? validateEndpoint(endpoint, { hasCredential: credentialAfter })
      : null;

  const save = async (): Promise<void> => {
    const ok = await update({
      user: {
        endpoint: endpoint.trim(),
        headerName: headerName.trim() || "authorization",
      },
      ...(credential.length > 0 ? { userCredential: credential } : {}),
    });
    if (ok) {
      setDirty(false);
      // Never retained after a successful save. The daemon holds it in its own secret table and
      // has no read path for it; keeping a copy in a React state that survives a route change
      // would put it back in reach of anything that can read the page.
      setCredential("");
    }
  };

  return (
    <div className="kb-row" data-anchor="telemetry/user">
      <div className="kb-row-text">
        <span className="kb-row-label">Send to your own backend</span>
        <span className="kb-row-desc">
          An OTLP/HTTP endpoint you run - a Collector, or a backend that speaks OTLP directly. Your
          data goes to your infrastructure. A credential may only be sent over HTTPS, or to a
          Collector on this machine.
        </span>

        <label className="ts-field">
          <span className="ts-field-label">Endpoint</span>
          <input
            className="field-input mono"
            type="text"
            placeholder="http://127.0.0.1:4318"
            value={endpoint}
            disabled={!config}
            aria-label="Telemetry export endpoint"
            onChange={(e) => {
              setDirty(true);
              setEndpoint(e.target.value);
            }}
          />
        </label>

        <label className="ts-field">
          <span className="ts-field-label">Credential header</span>
          <input
            className="field-input mono"
            type="text"
            value={headerName}
            disabled={!config}
            aria-label="Telemetry credential header name"
            onChange={(e) => {
              setDirty(true);
              setHeaderName(e.target.value);
            }}
          />
        </label>

        <label className="ts-field">
          <span className="ts-field-label">Credential</span>
          <input
            className="field-input mono"
            type="password"
            autoComplete="off"
            placeholder={
              status?.userCredentialConfigured
                ? "A credential is stored. Type to replace it."
                : "No credential"
            }
            value={credential}
            disabled={!config}
            aria-label="Telemetry export credential"
            onChange={(e) => {
              setDirty(true);
              setCredential(e.target.value);
            }}
          />
        </label>
        <span className="kb-row-desc">
          Stored by the daemon and never read back - not by this page, not by the config route, not
          by a settings snapshot. Leaving this blank keeps whatever is already stored.
        </span>

        {check && !check.ok && <span className="settings-error">{check.detail}</span>}
        {check?.warning && <span className="settings-warn">{check.warning}</span>}
        {status?.endpoint && !status.endpoint.ok && (
          <span className="settings-error">Saved endpoint: {status.endpoint.detail}</span>
        )}

        <div className="tele-actions">
          <Tooltip label="Store the endpoint and credential above, as one change">
            <button
              className="btn"
              disabled={!config || busy !== null || (check !== null && !check.ok)}
              onClick={() => void save()}
            >
              Save destination
            </button>
          </Tooltip>
          <Tooltip label="Send a real, empty OTLP request and report what came back">
            <button
              className="btn"
              disabled={!config || busy !== null || !user?.exporting}
              aria-label="Test the telemetry export connection"
              onClick={() => void state.probeEndpoint("user")}
            >
              Test connection
            </button>
          </Tooltip>
          {status?.userCredentialConfigured && (
            <ConfirmButton
              label="Remove credential"
              confirmLabel="Confirm removal"
              tooltip="Forget the stored export credential."
              busy={false}
              disabled={busy !== null}
              ariaLabel="Remove the stored telemetry credential"
              onConfirm={() => void update({ userCredential: "" })}
            />
          )}
        </div>

        {/*
          Pause carries its own sentence rather than sitting as a second bare switch beside the
          enable one. Two unlabelled boxes in a row is the shape that made the earlier cut
          unreadable: the difference between pausing and disabling is the whole point of having
          both, and a person cannot tell which box is which from a tooltip they have to hover to
          find. It appears only once there is something to pause.
        */}
        {(config?.user.enabled ?? false) && (
          <label className="tele-toggle">
            <Tooltip label="Stop sending without stopping collection. The queue is kept.">
              <span className="skill-switch">
                <input
                  type="checkbox"
                  checked={config?.user.paused ?? false}
                  disabled={!config || busy === "config"}
                  onChange={(e) => void update({ user: { paused: e.target.checked } })}
                  aria-label="Pause sending to your own backend"
                />
              </span>
            </Tooltip>
            <span>
              Pause sending. Collection keeps running and the queue is kept, unlike switching this
              destination off.
            </span>
          </label>
        )}

        {summary && !summary.enabled && (config?.user.enabled ?? false) && (
          <span className="kb-row-desc">Collection is off, so nothing is being sent.</span>
        )}

        {user && <ProfileHealth summary={user} state={state} />}
      </div>

      <div className="kb-row-controls">
        <Tooltip label="Send collected telemetry to the endpoint above">
          <label className="skill-switch">
            <input
              type="checkbox"
              checked={config?.user.enabled ?? false}
              disabled={!config || busy === "config"}
              onChange={(e) => void update({ user: { enabled: e.target.checked } })}
              aria-label="Export telemetry to your own backend"
            />
          </label>
        </Tooltip>
      </div>
    </div>
  );
}

/**
 * The minimized product audience: a second destination, narrower than the personal one.
 *
 * What makes it "product" is the audience policy rather than who receives it - it carries only
 * the facts declared for every audience and excludes everything operator-only, so it is not a
 * second copy of the personal stream. Mission Control hosts no public analytics service, so
 * there is no endpoint baked in and none is implied; an operator who runs their own minimized
 * collector points this at it.
 *
 * It gets its own endpoint field rather than borrowing the one above, because the two must never
 * be able to become the same destination by accident. No credential field: a credential belongs
 * to the operator's own backend, and the daemon stores none for this profile.
 */
function ProductDestination({ state }: { state: TelemetryState }): React.JSX.Element {
  const { status, busy, update } = state;
  const config = status?.config ?? null;
  const unavailable = (state.summary?.productEnrollment ?? "unavailable") === "unavailable";
  const product = profile(state, "product");
  const [endpoint, setEndpoint] = useState("");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (dirty || !config) return;
    setEndpoint(config.product.endpoint);
  }, [config, dirty]);

  // The same shared predicate the personal destination and the daemon both use. No credential is
  // stored for this profile, so `hasCredential` is false rather than optimistic.
  const check =
    endpoint.trim().length > 0 ? validateEndpoint(endpoint, { hasCredential: false }) : null;

  return (
    <div className="kb-row" data-anchor="telemetry/product">
      <div className="kb-row-text">
        <span className="kb-row-label">Share anonymous product analytics</span>
        <span className="kb-row-desc">
          A separate decision from the one above, with its own identity, its own queue and its own
          consent: opting into one never opts you into the other, and turning this off drops
          anything of its own that had not been sent without touching your own backend's queue. It
          carries a narrower set of facts - the ones that mean something off this machine - and
          never the diagnostics that are only about your installation.
        </span>
        <span className="kb-row-desc">
          Mission Control does not run a public analytics service, so there is no address here
          unless you supply one. Point this at a collector you run.
        </span>

        <label className="ts-field">
          <span className="ts-field-label">Endpoint</span>
          <input
            className="field-input mono"
            type="text"
            placeholder="http://127.0.0.1:4318"
            value={endpoint}
            disabled={!config}
            aria-label="Product analytics endpoint"
            onChange={(e) => {
              setDirty(true);
              setEndpoint(e.target.value);
            }}
          />
        </label>

        {check && !check.ok && <span className="settings-error">{check.detail}</span>}
        {check?.warning && <span className="settings-warn">{check.warning}</span>}

        <div className="tele-actions">
          <Tooltip label="Store the product analytics endpoint above">
            <button
              className="btn"
              disabled={!config || busy !== null || (check !== null && !check.ok)}
              aria-label="Save the product analytics destination"
              onClick={() => {
                void update({ product: { endpoint: endpoint.trim() } }).then((ok) => {
                  if (ok) setDirty(false);
                });
              }}
            >
              Save destination
            </button>
          </Tooltip>
          <Tooltip label="Send a real, empty OTLP request to the product endpoint">
            <button
              className="btn"
              disabled={!config || busy !== null || !product?.exporting}
              aria-label="Test the product analytics connection"
              onClick={() => void state.probeEndpoint("product")}
            >
              Test connection
            </button>
          </Tooltip>
        </div>

        {unavailable && (
          <span className="kb-row-desc">
            Nothing is configured yet, so this cannot be switched on: turning it on with no address
            would claim to be sharing while queueing for somewhere that cannot answer.
          </span>
        )}

        {product && <ProfileHealth summary={product} state={state} />}
      </div>
      <div className="kb-row-controls">
        <Tooltip label="Send the minimized product subset to the endpoint above">
          <label className="skill-switch">
            <input
              type="checkbox"
              checked={config?.product.enabled ?? false}
              disabled={!config || unavailable || busy === "config"}
              onChange={(e) => void update({ product: { enabled: e.target.checked } })}
              aria-label="Share anonymous product analytics"
            />
          </label>
        </Tooltip>
      </div>
    </div>
  );
}

/** One destination's live queue state, and the two operations that act on it. */
function ProfileHealth({
  summary,
  state,
}: {
  summary: TelemetryProfileSummary;
  state: TelemetryState;
}): React.JSX.Element {
  const detail = state.health?.profiles.find((p) => p.profile === summary.profile) ?? null;
  return (
    <div className="kb-row-desc tele-queue" data-anchor={`telemetry/queue-${summary.profile}`}>
      <p>{describeDestination(summary)}</p>
      {summary.pending > 0 && (
        <p>
          {summary.pending} queued ({formatBytes(summary.pendingBytes)})
          {summary.oldestPendingAgeMs !== null &&
            `, oldest ${formatAge(summary.oldestPendingAgeMs)}`}
          .
        </p>
      )}
      {summary.lastAcceptedAt !== null && (
        <p>Last accepted {formatAge(Date.now() - summary.lastAcceptedAt)} ago.</p>
      )}
      {detail?.lastError && <p className="settings-error">{detail.lastError}</p>}
      {/*
        The sentence above is drawn whatever the state is - "Off" is a state an operator needs
        to read as much as "Up to date" is. The ACTIONS are not: a retry and a discard both act
        on a queue, and a destination that is switched off has none. Showing them anyway would
        offer two buttons whose only honest behavior is to report that they did nothing.
      */}
      {summary.capturing && (
        <div className="tele-actions">
          <Tooltip label="Clear a pause this daemon applied and attempt the queue now">
            <button
              className="btn"
              disabled={state.busy !== null}
              aria-label={`Try sending to ${label(summary.profile)} again`}
              onClick={() => void state.operate("retry", summary.profile)}
            >
              Try again
            </button>
          </Tooltip>
          <ConfirmButton
            label="Discard queue"
            confirmLabel="Confirm discard"
            tooltip="Drop this destination's undelivered batches."
            busy={state.busy === `purge:${summary.profile}`}
            disabled={state.busy !== null}
            ariaLabel={`Discard the queue for ${label(summary.profile)}`}
            onConfirm={() => void state.operate("purge", summary.profile)}
          />
        </div>
      )}
    </div>
  );
}

/** What this installation reports itself as, and how to stop being that installation. */
function Identity({ state }: { state: TelemetryState }): React.JSX.Element {
  const health = state.health;
  return (
    <div className="kb-row" data-anchor="telemetry/identity">
      <div className="kb-row-text">
        <span className="kb-row-label">This installation's pseudonym</span>
        <span className="kb-row-desc">
          A local random value, not an account and not a device fingerprint. It is what lets you
          filter a dashboard to this installation. Resetting it makes this installation look like a
          new one everywhere, discards anything not yet sent under the old one, and cannot recall
          what a backend already accepted. Your sessions, tasks and history are untouched.
        </span>
        {health && health.installationId !== "" ? (
          <span className="kb-row-desc mono">
            {health.installationId} (epoch {health.identityEpoch})
          </span>
        ) : (
          <span className="kb-row-desc">
            No pseudonym has been minted. Nothing has been collected on this machine.
          </span>
        )}
      </div>
      <div className="kb-row-controls">
        <ConfirmButton
          label="Reset identity"
          confirmLabel="Confirm reset"
          tooltip="Mint a new pseudonym. Every queue built under the old one goes with it."
          busy={state.busy === "reset_identity:all"}
          disabled={state.busy !== null || !health || health.installationId === ""}
          ariaLabel="Reset this installation's telemetry pseudonym"
          onConfirm={() => void state.operate("reset_identity")}
        />
      </div>
    </div>
  );
}

/** What a settings restore does and does not bring with it. */
function Coverage({ state }: { state: TelemetryState }): React.JSX.Element {
  return (
    <p className="settings-hint" data-anchor="telemetry/restore">
      Nothing on this page is carried by a settings snapshot. Restoring settings - on this machine
      or another one - cannot switch collection on, cannot point an export somewhere it was never
      pointed, and never restores a credential or this installation's pseudonym.
      {state.summary?.enabled === false &&
        " Collection is currently off, so no telemetry is being recorded."}
    </p>
  );
}

/**
 * A button that asks once, in place.
 *
 * Rather than a modal, because these actions are rare, irreversible and small: a dialog for
 * "discard four queued batches" is more ceremony than the decision deserves, and a button whose
 * own label changes to name what is about to happen is a confirmation a person actually reads.
 * It disarms itself, so an armed button cannot be left lying on the page.
 */
function ConfirmButton({
  label,
  confirmLabel,
  ariaLabel,
  tooltip,
  busy,
  disabled,
  onConfirm,
}: {
  label: string;
  confirmLabel: string;
  ariaLabel: string;
  /** What this is about to do, in the hover the house style requires of every control. */
  tooltip: string;
  busy: boolean;
  disabled: boolean;
  onConfirm: () => void;
}): React.JSX.Element {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), CONFIRM_MS);
    return () => clearTimeout(id);
  }, [armed]);
  return (
    <Tooltip label={armed ? `${tooltip} This cannot be undone.` : tooltip}>
      <button
        className={armed ? "btn btn-danger" : "btn"}
        disabled={disabled || busy}
        aria-label={armed ? `${ariaLabel} - confirm` : ariaLabel}
        onClick={() => {
          if (!armed) {
            setArmed(true);
            return;
          }
          setArmed(false);
          onConfirm();
        }}
      >
        {armed ? confirmLabel : label}
      </button>
    </Tooltip>
  );
}

function profile(state: TelemetryState, id: TelemetryProfileId): TelemetryProfileSummary | null {
  return state.summary?.profiles.find((p) => p.profile === id) ?? null;
}

function label(id: TelemetryProfileId): string {
  return id === "local"
    ? "local collection"
    : id === "user"
      ? "your own backend"
      : "product analytics";
}

function describeLocal(local: TelemetryProfileSummary): string {
  return local.capturing
    ? "Collection is on."
    : "Collection is off, so nothing new is being recorded here.";
}

/**
 * One sentence for a destination's state.
 *
 * The distinctions this has to keep apart are the ones an operator acts on differently:
 * disabled (nothing is being collected for it), paused by you (collection continues, the queue
 * is kept), paused by the daemon (something is wrong and it says what), and reachable but
 * behind.
 */
function describeDestination(summary: TelemetryProfileSummary): string {
  if (!summary.capturing) return "Off. Nothing is being collected for this destination.";
  if (summary.pausedReason !== null) return pauseSentence(summary.pausedReason);
  if (summary.paused) return "Paused by you. Collection continues and the queue is kept.";
  if (!summary.exporting) return "Collecting, but no endpoint is configured, so nothing is sent.";
  if (summary.failing && summary.pending > 0) {
    return "The last attempt did not get through. The queue is kept and will be retried.";
  }
  if (summary.pending > 0) return "Sending. Some of the queue has not been delivered yet.";
  return "Up to date. Everything collected has been accepted.";
}

function pauseSentence(reason: TelemetryPauseReason): string {
  switch (reason) {
    case "auth":
      return "Stopped: the destination rejected the credential. Fix it and use Try again.";
    case "configuration":
      return "Stopped: the destination refused the request as configured. Check the endpoint.";
    case "payload":
      return "Stopped: the destination refused what was sent. Discarding the queue will clear it.";
    case "quota":
      return "Stopped: the destination is over quota and asked us to stop.";
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
