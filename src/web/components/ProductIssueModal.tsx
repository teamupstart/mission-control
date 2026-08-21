import { useCallback, useEffect, useRef, useState } from "react";
import {
  PRODUCT_ISSUE_LIMITS,
  PRODUCT_ISSUE_TYPES,
  type ProductIssueConfirmation,
  type ProductIssueDraft,
  type ProductIssuePreflight,
  type ProductIssuePreview,
  type ProductIssueSubmitResult,
  type ProductIssueType,
} from "@shared/product-issues.ts";
import {
  confirmProductIssue,
  fetchProductIssuePreflight,
  previewProductIssue,
  submitProductIssue,
} from "../lib/api.ts";
import {
  AttachmentStrip,
  useImageDrop,
  type PendingAttachment,
} from "./ImageDrop.tsx";
import { Overlay, OVERLAY_IDS } from "./Overlay.tsx";
import { Tooltip } from "./Tooltip.tsx";

/**
 * Report a product issue to the public Mission Control issue tracker.
 *
 * This form's one unusual property is that submitting it PUBLISHES - the daemon files a real
 * GitHub issue in a repository strangers can read, and no button here can take that back. So
 * two things are true of everything below and are worth stating before the code:
 *
 * 1. **The browser chooses nothing that can steer GitHub.** Repository, the three labels, the
 *    `source:dashboard` mark, the environment block and the rendered Markdown body are all
 *    the daemon's, derived per call by Phase 1's service. This component sends a type, a
 *    title and details, and DISPLAYS what the daemon says it will publish. That is why the
 *    preview is fetched rather than composed here: a locally-rendered preview would be a
 *    second implementation of the body, and the two would drift apart silently - with the
 *    public copy being the one nobody was shown.
 * 2. **Publishing takes two deliberate presses, against content that is on screen.** The
 *    first press confirms - it asks the daemon for a short-lived, single-use grant for the
 *    preview React has actually RENDERED - and the button then relabels to name the public
 *    repository it is about to write to. The second press publishes with that grant, and
 *    nothing is fetched between it and the publish.
 *
 *    Both halves of that were defects once, and both are worth naming. Submission used to
 *    echo the preview's `draftIdentity`, which is a hash of the request: anything holding
 *    the draft could recompute it, so it authorized nothing. It then used a random token the
 *    PREVIEW reply handed out, which is authority falling out of a read - the modal previews
 *    on every settled keystroke, and nobody chose to publish by typing. And an even earlier
 *    revision fetched its preview inside the click handler and submitted it in the same
 *    promise chain, so React never rendered what was published.
 *
 *    Editing the report drops the grant, so it can never outlive the words it was taken
 *    against; so does its two-minute expiry. The daemon re-derives everything and refuses a
 *    grant whose derivation has moved, and the modal then shows the refreshed preview and
 *    waits to be confirmed again.
 *
 * The draft outlives the modal. Someone who closes this to go re-read the bug they are
 * reporting comes back to the words they had written; only **Clear** and a confirmed
 * creation reset it. That retention is the whole reason the state lives in `ProductIssueLayer`
 * rather than in the modal - see there.
 *
 * Screenshots are drawn, and are inert. The GitHub CLI has no first-party attachment flag yet
 * (cli/cli#13256), so the daemon's attachment capability is off and refuses a non-empty list
 * outright. The region is mounted with the real `useImageDrop`, disabled, so paste, drop and
 * file selection all fall through as no-ops - and the day the CLI ships, the change is one
 * capability flag and this copy, not a placeholder swapped for a real component.
 */

/** The GitHub issue that has to land upstream before screenshots can work. */
export const PRODUCT_ISSUE_ATTACHMENT_ISSUE_URL = "https://github.com/cli/cli/issues/13256";

/**
 * How each report type reads to a person, and what a good report of that type contains.
 *
 * The `label` is UI copy and may be re-worded; the value under it is the append-only wire
 * value from the shared contract and never is. The guidance is per-type but the FIELD is
 * one field - switching type re-labels the prompt without discarding what was written,
 * because "actually this is a usability problem, not a bug" should not cost the paragraph
 * that made that clear.
 */
export const PRODUCT_ISSUE_TYPE_UI: Record<
  ProductIssueType,
  { label: string; blurb: string; detailsGuidance: string }
> = {
  bug: {
    label: "Bug",
    blurb: "Something is broken or behaves incorrectly.",
    detailsGuidance:
      "What you did, what you expected, and what happened instead. Steps someone else can follow are the most useful thing you can write here.",
  },
  "feature-request": {
    label: "Feature request",
    blurb: "Something Mission Control cannot do yet.",
    detailsGuidance:
      "What you are trying to accomplish and why the current product cannot do it. Describe the outcome you want, not only the control you imagine.",
  },
  documentation: {
    label: "Documentation",
    blurb: "Docs are missing, wrong, or hard to follow.",
    detailsGuidance:
      "Which page or section, what it currently says, and what left you stuck. A link to the page beats a description of it.",
  },
  usability: {
    label: "Usability",
    blurb: "It works, but it is confusing or awkward.",
    detailsGuidance:
      "What you were trying to do, where you got lost, and what you expected the interface to tell you at that moment.",
  },
  other: {
    label: "Other",
    blurb: "Anything that does not fit the four above.",
    detailsGuidance:
      "Describe the situation in your own words. A report in the wrong category is far better than one nobody files.",
  },
};

/** The reporter-authored draft, plus the local attachment rows the disabled region owns. */
export interface ProductIssueDraftState {
  type: ProductIssueType;
  title: string;
  details: string;
  /**
   * Always empty in production. Present so the enablement follow-up flips a capability
   * rather than inventing a field - and so the request built from this draft has the same
   * shape either way.
   */
  attachments: PendingAttachment[];
}

export const EMPTY_PRODUCT_ISSUE_DRAFT: ProductIssueDraftState = {
  type: "bug",
  title: "",
  details: "",
  attachments: [],
};

/** UTF-8 bytes, because that is the bound the daemon actually enforces. */
const utf8 = new TextEncoder();
export function productIssueFieldBytes(value: string): number {
  return utf8.encode(value).byteLength;
}

/**
 * Why this draft cannot be previewed yet, or null.
 *
 * Deliberately mirrors the shared schema's bounds rather than inventing softer ones: a form
 * that accepts what the daemon will refuse teaches people to distrust the form. It is not a
 * SUBSTITUTE for that schema - the daemon validates again and is the authority - it just
 * says so before the round-trip.
 */
export function productIssueDraftProblem(draft: ProductIssueDraftState): string | null {
  if (!draft.title.trim()) return "Add a short title.";
  if (productIssueFieldBytes(draft.title.trim()) > PRODUCT_ISSUE_LIMITS.titleBytes) {
    return `The title is over the ${PRODUCT_ISSUE_LIMITS.titleBytes}-character limit.`;
  }
  if (!draft.details.trim()) return "Describe what happened.";
  if (productIssueFieldBytes(draft.details.trim()) > PRODUCT_ISSUE_LIMITS.detailsBytes) {
    return "The details are over the length limit.";
  }
  return null;
}

/** The wire draft this state produces. Attachments are ids, never local paths. */
export function productIssueDraftPayload(draft: ProductIssueDraftState): ProductIssueDraft {
  return {
    type: draft.type,
    title: draft.title.trim(),
    details: draft.details.trim(),
    attachmentUploadIds: draft.attachments.flatMap((a) => (a.uploadId ? [a.uploadId] : [])),
  };
}

/** The preview that is in hand for THIS draft, or null if the draft has moved on. */
function previewMatches(
  preview: ProductIssuePreview | null,
  draft: ProductIssueDraftState,
): ProductIssuePreview | null {
  if (!preview) return null;
  const wanted = productIssueDraftPayload(draft);
  const have = preview.draft;
  const same =
    have.type === wanted.type &&
    have.title === wanted.title &&
    have.details === wanted.details &&
    have.attachmentUploadIds.length === wanted.attachmentUploadIds.length &&
    have.attachmentUploadIds.every((id, i) => id === wanted.attachmentUploadIds[i]);
  return same ? preview : null;
}

/**
 * The grant in hand for THIS rendered preview, or null.
 *
 * Compared against the preview's identity rather than merely against the draft, because that
 * is the thing the daemon pinned the grant to. A grant left over from content that has since
 * moved must read as "not confirmed" on screen, or the button would offer a publish the
 * daemon is about to refuse.
 */
function confirmationMatches(
  confirmation: ProductIssueConfirmation | null,
  matched: ProductIssuePreview | null,
): ProductIssueConfirmation | null {
  if (!confirmation || !matched) return null;
  return confirmation.draftIdentity === matched.draftIdentity ? confirmation : null;
}

/** Everything the presentational modal draws. Owned by the layer, so a close keeps it. */
export interface ProductIssueModalProps {
  draft: ProductIssueDraftState;
  onDraftChange: (next: ProductIssueDraftState) => void;
  /** null while the opening's preflight is still in flight. */
  preflight: ProductIssuePreflight | null;
  /** The daemon's trusted preview of this exact draft, or null. */
  preview: ProductIssuePreview | null;
  /** A refusal or configuration problem the preview itself reported. */
  previewProblem: string | null;
  previewing: boolean;
  /** The grant taken by the confirming press, or null while none is held. */
  confirmation: ProductIssueConfirmation | null;
  confirming: boolean;
  submitting: boolean;
  /** The last terminal outcome of this opening. Survives a close, like the draft. */
  result: ProductIssueSubmitResult | null;
  /** False once an `unknown` outcome has made blind retry unsafe for this opening. */
  retryAllowed: boolean;
  /** First press: ask the daemon to confirm the rendered preview. */
  onConfirm: () => void;
  /** Second press: publish with the grant that press returned. */
  onSubmit: () => void;
  onClear: () => void;
  onClose: () => void;
}

export function ProductIssueModal({
  draft,
  onDraftChange,
  preflight,
  preview,
  previewProblem,
  previewing,
  confirmation,
  confirming,
  submitting,
  result,
  retryAllowed,
  onConfirm,
  onSubmit,
  onClear,
  onClose,
}: ProductIssueModalProps): React.JSX.Element {
  const attachmentsEnabled = preflight?.attachments.enabled ?? false;
  const attachmentReason =
    preflight?.attachments.reason ?? "Screenshot upload is waiting for first-party GitHub CLI support";
  // Mounted with the REAL hook, disabled. Not a styled div pretending: paste, drop and
  // selection are refused by the same code path that will accept them once the capability
  // is on, so nothing here has to be re-derived when it is.
  const drop = useImageDrop({
    attachments: draft.attachments,
    onChange: (attachments) => onDraftChange({ ...draft, attachments }),
    disabled: !attachmentsEnabled,
  });

  const draftProblem = productIssueDraftProblem(draft);
  const created = result?.outcome === "created" ? result : null;
  /**
   * Bring the outcome into view when one arrives.
   *
   * Not decoration. This dialog is taller than a short window, so the body is scrolled to
   * wherever the person was typing - and every terminal result lands BELOW that. Without
   * this, pressing the button that publishes a public issue looks exactly like pressing a
   * button that did nothing, which is how the same report gets filed twice.
   */
  const outcomeRef = useRef<HTMLParagraphElement | null>(null);
  useEffect(() => {
    if (!result) return;
    outcomeRef.current?.scrollIntoView({ block: "nearest" });
  }, [result]);
  const preflightProblem = preflight && !preflight.ready ? preflight.problems[0] ?? null : null;
  const matched = previewMatches(preview, draft);
  const confirmed = confirmationMatches(confirmation, matched);
  const blocked =
    created !== null ||
    confirming ||
    submitting ||
    previewing ||
    drop.uploading ||
    !retryAllowed ||
    draftProblem !== null ||
    preflight === null ||
    !preflight.ready ||
    // Nothing rendered means nothing to confirm. Both presses act on the preview on screen,
    // so neither is offered while there is not one.
    matched === null;

  const typeUi = PRODUCT_ISSUE_TYPE_UI[draft.type];

  return (
    <Overlay
      id={OVERLAY_IDS.productIssue}
      onClose={onClose}
      className="modal feedback-modal"
      role="dialog"
      ariaLabel="Report product feedback"
      closable={!submitting}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (blocked) return;
          // One submit handler, two meanings, and the grant decides which. Holding a grant
          // for the rendered preview is exactly the state "this person has already asked to
          // publish this text", so that press publishes; anything else confirms first.
          if (confirmed) onSubmit();
          else onConfirm();
        }}
      >
        <header className="modal-head">
          <h2>Report product feedback</h2>
          <Tooltip label="Close - your draft is kept until you clear it (Escape)">
            <button
              type="button"
              className="icon-btn"
              aria-label="Close"
              onClick={onClose}
              disabled={submitting}
            >
              ✕
            </button>
          </Tooltip>
        </header>

        <div className="modal-body feedback-body">
          {/* Never below the fold and never only a colour. Someone who reads one sentence
              on this form has to read the one that says where their words are going. */}
          <p className="feedback-warning" role="note">
            <strong>This is published publicly.</strong> Mission Control files a GitHub issue
            that anyone can read. Do not include credentials, customer data, file paths, or
            anything from a private repository.
          </p>

          {preflight === null && (
            <p className="feedback-status" role="status">
              Checking that Mission Control can file reports…
            </p>
          )}
          {preflightProblem && (
            <p className="feedback-error" role="alert">
              Reporting is unavailable: {preflightProblem.message}
            </p>
          )}

          <fieldset className="feedback-types">
            <legend>What kind of feedback is this?</legend>
            {PRODUCT_ISSUE_TYPES.map((type) => (
              <label key={type} className="feedback-type">
                <Tooltip label={PRODUCT_ISSUE_TYPE_UI[type].blurb}>
                  <input
                    type="radio"
                    name="product-issue-type"
                    value={type}
                    checked={draft.type === type}
                    onChange={() => onDraftChange({ ...draft, type })}
                    disabled={submitting}
                    // Named explicitly, because the wrapping <label> carries the blurb as
                    // well and a control whose accessible name is a whole sentence is one
                    // nobody can address by name. The visible text starts with this exact
                    // string, so the label-in-name rule still holds.
                    aria-label={PRODUCT_ISSUE_TYPE_UI[type].label}
                  />
                </Tooltip>
                <span className="feedback-type-label">{PRODUCT_ISSUE_TYPE_UI[type].label}</span>
                <span className="feedback-type-blurb">{PRODUCT_ISSUE_TYPE_UI[type].blurb}</span>
              </label>
            ))}
          </fieldset>

          <label className="feedback-field">
            <span className="feedback-field-name">Title</span>
            {/* Named explicitly for the reason the radios are: the byte counter and the
                guidance live inside this label, and a field whose accessible name ends in
                "0 / 200 bytes" cannot be addressed by name. */}
            <input
              type="text"
              value={draft.title}
              maxLength={PRODUCT_ISSUE_LIMITS.titleBytes}
              placeholder="One line someone scanning the issue list would understand"
              onChange={(e) => onDraftChange({ ...draft, title: e.target.value })}
              disabled={submitting}
              aria-label="Title"
            />
            <span className="feedback-count">
              {productIssueFieldBytes(draft.title)} / {PRODUCT_ISSUE_LIMITS.titleBytes} bytes
            </span>
          </label>

          <label className="feedback-field">
            <span className="feedback-field-name">Details</span>
            {/* One value, re-prompted. Switching type keeps what was written - see the
                type table's comment for why that matters. */}
            <span className="feedback-field-hint">{typeUi.detailsGuidance}</span>
            <textarea
              value={draft.details}
              rows={7}
              onChange={(e) => onDraftChange({ ...draft, details: e.target.value })}
              onPaste={drop.onPaste}
              disabled={submitting}
              aria-label="Details"
            />
            <span className="feedback-count">
              {productIssueFieldBytes(draft.details)} / {PRODUCT_ISSUE_LIMITS.detailsBytes} bytes
            </span>
          </label>

          <section
            className={`feedback-shots${attachmentsEnabled ? "" : " is-unavailable"}`}
            aria-label="Screenshots"
            {...drop.dropProps}
          >
            <h3>Screenshots</h3>
            <p className="feedback-shots-reason">
              {attachmentReason}.{" "}
              <Tooltip label="Open the upstream GitHub CLI issue this waits on">
                <a href={PRODUCT_ISSUE_ATTACHMENT_ISSUE_URL} target="_blank" rel="noreferrer">
                  cli/cli#13256
                </a>
              </Tooltip>{" "}
              tracks it upstream. Describe what you saw in Details instead.
            </p>
            <Tooltip
              label={
                attachmentsEnabled
                  ? "Choose screenshots to attach"
                  : `${attachmentReason} - this control does nothing yet`
              }
            >
              <input
                type="file"
                accept="image/*"
                multiple
                disabled={!attachmentsEnabled}
                aria-label="Add screenshots"
                onChange={(e) => drop.addFiles(Array.from(e.target.files ?? []))}
              />
            </Tooltip>
            <AttachmentStrip
              attachments={draft.attachments}
              onRemove={drop.remove}
              removeContext="this report"
            />
          </section>

          {/* The trusted preview. Fetched, never composed here. */}
          <section className="feedback-preview" aria-label="What will be published">
            <h3>What will be published</h3>
            {previewing && <p className="feedback-status" role="status">Building the preview…</p>}
            {draftProblem && !previewing && (
              <p className="feedback-status">{draftProblem}</p>
            )}
            {previewProblem && (
              <p className="feedback-error" role="alert">
                {previewProblem}
              </p>
            )}
            {matched && (
              <dl className="feedback-preview-facts">
                <dt>Repository</dt>
                <dd className="feedback-target">{matched.target}</dd>
                <dt>Title</dt>
                <dd>{matched.draft.title}</dd>
                <dt>Labels</dt>
                <dd>{matched.labels.join(", ")}</dd>
                <dt>Environment</dt>
                <dd>
                  Mission Control {matched.environment.missionControlVersion} ·{" "}
                  {matched.environment.platform} / {matched.environment.architecture} ·{" "}
                  {matched.environment.client}
                </dd>
                <dt>Body</dt>
                <dd>
                  <pre className="feedback-body-preview">{matched.body}</pre>
                </dd>
              </dl>
            )}
          </section>

          {confirmed && !created && (
            /* The state between the two presses, said out loud. A button that silently
               relabels is a button somebody presses twice by reflex, and the second press
               here is irreversible - so the destination and the way back out are both on
               screen, not only in the tooltip. */
            <p className="feedback-armed" role="status">
              Ready to publish in {confirmed.target}. Press again to file it publicly, or edit
              the report to go back.
            </p>
          )}
          {created && (
            <p className="feedback-created" role="status" ref={outcomeRef}>
              {/* The URL itself, not a second "View GitHub issue" - the footer already
                  carries that name, and two links answering to it is one a screen-reader
                  user cannot choose between. Spelling the address out is also the more
                  useful of the two here: this is the record of WHERE the words went. */}
              Reported in {created.target}:{" "}
              <Tooltip label="Open the public issue this report created">
                <a href={created.issueUrl} target="_blank" rel="noreferrer">
                  {created.issueUrl}
                </a>
              </Tooltip>
            </p>
          )}
          {result && result.outcome !== "created" && (
            <p className="feedback-error" role="alert" ref={outcomeRef}>
              {result.message}
              {result.outcome === "unknown" && (
                <>
                  {" "}
                  Nothing here can tell whether the issue was created, so this opening will not
                  send it again. Check the target repository, then reopen this form.
                </>
              )}
            </p>
          )}
        </div>

        <footer className="modal-foot">
          <Tooltip label="Discard this draft and the last result">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={onClear}
              disabled={submitting}
            >
              Clear
            </button>
          </Tooltip>
          <span className="actions-spacer" />
          {/* No second Close here. The header ✕, Escape and the backdrop already close this,
              and two controls answering to "Close" is one a screen-reader user cannot pick
              between. */}
          {created ? (
            /* The outcome, on the control that was just pressed. A "Report publicly" button
               left sitting there after a successful report is an invitation to file the
               same issue again - and the daemon would answer that second press with an
               uncertain result rather than a refusal, which is the worst answer to get. */
            <Tooltip label={`Open ${created.issueUrl}`}>
              <a
                className="btn btn-primary feedback-created-action"
                href={created.issueUrl}
                target="_blank"
                rel="noreferrer"
              >
                View GitHub issue
              </a>
            </Tooltip>
          ) : (
          <Tooltip
            label={
              blocked
                ? draftProblem ??
                  (!retryAllowed
                    ? "The last attempt had an uncertain result; check GitHub before reporting again"
                    : preflightProblem
                      ? preflightProblem.message
                      : "Waiting for Mission Control to confirm what will be published")
                : confirmed
                  ? `Publish this now in ${confirmed.target}`
                  : `Check this over before it is published in ${matched?.target ?? "the public issue tracker"}`
            }
          >
            <button
              type="submit"
              className="btn btn-primary"
              disabled={blocked}
              /* The accessible name changes with the press, because the two presses do
                 different things and a screen reader must not hear the same word twice for
                 "check this" and "publish this irreversibly". */
              aria-label={
                confirmed ? `Publish to ${confirmed.target}` : "Report publicly"
              }
            >
              {submitting
                ? "Publishing…"
                : confirming
                  ? "Checking…"
                  : confirmed
                    ? `Publish to ${confirmed.target}`
                    : "Report publicly"}
            </button>
          </Tooltip>
          )}
        </footer>
      </form>
    </Overlay>
  );
}

/**
 * The one owner of the Feedback draft, opener state and last result.
 *
 * Mounted unconditionally beside `DispatchLayer`, and for the same two reasons that one is:
 * a draft has to survive a close (someone goes to re-read the thing they are reporting and
 * comes back), and App re-renders the whole fleet on every SSE frame, so keystrokes must not
 * travel through it. `open` is the only thing App holds.
 *
 * There is exactly one of these. The topbar glyph and the command palette both call App's
 * single `openFeedback`, so the two doorways cannot become two drafts.
 */
export function ProductIssueLayer({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): React.JSX.Element | null {
  const [draft, setDraft] = useState<ProductIssueDraftState>(EMPTY_PRODUCT_ISSUE_DRAFT);
  const [preflight, setPreflight] = useState<ProductIssuePreflight | null>(null);
  const [preview, setPreview] = useState<ProductIssuePreview | null>(null);
  const [previewProblem, setPreviewProblem] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  /**
   * The grant taken by the confirming press, held only until it is spent or goes stale.
   *
   * Deliberately not folded into `preview`. A preview is re-fetched as the draft settles,
   * and a publishing capability that rode along with it would be re-issued by typing -
   * which is the defect this state exists to make impossible to reintroduce.
   */
  const [confirmation, setConfirmation] = useState<ProductIssueConfirmation | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ProductIssueSubmitResult | null>(null);
  const [retryAllowed, setRetryAllowed] = useState(true);
  /**
   * Bumped to force a re-preview that the draft alone would not trigger.
   *
   * The debounced effect keys on the draft, so after a refusal - where the words are
   * unchanged but the daemon's derivation may not be - nothing would re-fetch and the
   * screen would keep showing the preview that was just rejected.
   */
  const [previewNonce, setPreviewNonce] = useState(0);
  /**
   * This opening's duplicate guard.
   *
   * One id per opening, not per keystroke: the daemon binds a submission claim to it, so
   * reusing it is what makes a double-click, a double-submit and a re-preview of the same
   * words provably one report rather than two. A confirmed creation retires it along with
   * the draft.
   */
  const requestIdRef = useRef<string>(newRequestId());
  /** Ignore a preflight or preview reply that a newer opening or keystroke has outrun. */
  const generationRef = useRef(0);

  const resetDraft = useCallback(() => {
    requestIdRef.current = newRequestId();
    generationRef.current++;
    setDraft(EMPTY_PRODUCT_ISSUE_DRAFT);
    setPreview(null);
    setPreviewProblem(null);
    setConfirmation(null);
    setResult(null);
    setRetryAllowed(true);
  }, []);

  // A confirmed creation is the one automatic reset: those words are filed, and the next
  // opening starting on top of them would be a second report of the same thing. Everything
  // else - a refusal, an unknown outcome, an ordinary close - keeps them.
  const createdUrl = result?.outcome === "created" ? result.issueUrl : null;
  const clearOnNextOpen = useRef(false);
  clearOnNextOpen.current = createdUrl !== null;

  useEffect(() => {
    if (!open) return;
    if (clearOnNextOpen.current) resetDraft();
    let live = true;
    setPreflight(null);
    void fetchProductIssuePreflight().then((next) => {
      if (live) setPreflight(next);
    });
    return () => {
      live = false;
    };
    // Keyed on the opening alone. `resetDraft` is stable, and the draft deliberately does
    // not appear here: re-running preflight per keystroke is what the debounced preview is
    // for, and it would blank the target while someone was still typing.
  }, [open, resetDraft]);

  // The trusted preview, refreshed as the draft settles. Debounced because it is a network
  // round-trip per keystroke otherwise, and cancelled by generation because an in-flight
  // reply for older words must not be shown beside newer ones.
  const problem = productIssueDraftProblem(draft);
  useEffect(() => {
    /**
     * Editing the report drops the grant.
     *
     * The daemon would refuse a grant whose derivation moved anyway, so this is not the
     * boundary - it is the screen telling the truth. A button still reading "Publish to
     * acme/public-issues" under words that have since changed is an offer to publish
     * something that is no longer what is written.
     */
    setConfirmation(null);
    if (!open || problem !== null) {
      setPreview(null);
      setPreviewProblem(null);
      return;
    }
    const generation = ++generationRef.current;
    const payload = productIssueDraftPayload(draft);
    const timer = setTimeout(() => {
      setPreviewing(true);
      void previewProductIssue({
        ...payload,
        requestId: requestIdRef.current,
        client: productIssueClient(),
      }).then((response) => {
        if (generation !== generationRef.current) return;
        setPreviewing(false);
        if (response.outcome === "preview") {
          setPreview(response);
          setPreviewProblem(null);
        } else {
          setPreview(null);
          setPreviewProblem(response.message);
        }
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [open, problem, draft, previewNonce]);

  /**
   * Let the grant expire on screen at the moment it expires at the daemon.
   *
   * Without this the button keeps offering to publish for as long as the modal stays open,
   * and the press would come back as a refusal that reads like a fault. Two minutes is the
   * daemon's TTL; this only mirrors it.
   */
  useEffect(() => {
    if (!confirmation) return;
    const remaining = confirmation.expiresAt - Date.now();
    if (remaining <= 0) {
      setConfirmation(null);
      return;
    }
    const timer = setTimeout(() => setConfirmation(null), remaining);
    return () => clearTimeout(timer);
  }, [confirmation]);

  /**
   * The two presses.
   *
   * `onConfirm` takes a grant for `matched` - the preview React has actually RENDERED for
   * this draft. `onSubmit` spends it. Nothing is fetched between the second press and the
   * publish, which is the ordering that makes the content on screen and the content
   * published the same thing: a preview requested inside the publishing handler would
   * resolve after the render that showed the old one.
   *
   * The daemon re-derives everything and compares it against what the grant was minted for,
   * so a target or environment that moved in between is refused rather than published. A
   * refusal re-previews below, which puts the person back in front of the current content
   * with no grant in hand.
   */
  const matched = previewMatches(preview, draft);
  const confirmed = confirmationMatches(confirmation, matched);

  const onConfirm = useCallback(() => {
    if (confirming || submitting || !retryAllowed || !matched) return;
    setConfirming(true);
    setResult(null);
    const request = {
      ...productIssueDraftPayload(draft),
      requestId: requestIdRef.current,
      client: productIssueClient(),
    };
    void confirmProductIssue(request).then((next) => {
      setConfirming(false);
      if (next.outcome === "confirmation") {
        setConfirmation(next);
        return;
      }
      // Anything else is a terminal-shaped answer and belongs in the same place every other
      // outcome does. `unknown` here means the opening is already publishing, which is the
      // one case where pressing again is not safe.
      setResult(next);
      if (next.outcome === "unknown") setRetryAllowed(false);
      setPreview(null);
      setPreviewNonce((n) => n + 1);
    });
  }, [confirming, draft, matched, retryAllowed, submitting]);

  const onSubmit = useCallback(() => {
    if (submitting || confirming || !retryAllowed || !confirmed) return;
    setSubmitting(true);
    setResult(null);
    const request = {
      ...productIssueDraftPayload(draft),
      requestId: requestIdRef.current,
      client: productIssueClient(),
    };
    void submitProductIssue(request, confirmed.token).then((next) => {
      setSubmitting(false);
      setResult(next);
      // The grant is single-use at the daemon either way, so holding it here after any
      // answer would only offer a press that is already going to be refused.
      setConfirmation(null);
      // Only `unknown` closes the door. A refusal is explicitly retry-safe - the daemon
      // released its claim - and telling someone to go check GitHub after a refusal that
      // provably published nothing would be advice that costs them the draft.
      if (next.outcome === "unknown") setRetryAllowed(false);
      // A refusal may be the daemon saying its own derivation moved since this grant was
      // minted. Drop the stale preview and fetch a fresh one, so the next confirmation is
      // taken against content the person has been shown rather than against the old screen.
      if (next.outcome === "refused" || next.outcome === "configuration") {
        setPreview(null);
        setPreviewNonce((n) => n + 1);
      }
    });
  }, [confirmed, confirming, draft, retryAllowed, submitting]);

  if (!open) return null;
  return (
    <ProductIssueModal
      draft={draft}
      onDraftChange={setDraft}
      preflight={preflight}
      preview={preview}
      previewProblem={previewProblem}
      previewing={previewing}
      confirmation={confirmation}
      confirming={confirming}
      submitting={submitting}
      result={result}
      retryAllowed={retryAllowed}
      onConfirm={onConfirm}
      onSubmit={onSubmit}
      onClear={resetDraft}
      onClose={onClose}
    />
  );
}

/**
 * Which shell this tab is running in.
 *
 * Informative only - it lands in the public environment block. The daemon does not trust it
 * for anything, and there is nothing here that could be steered by getting it wrong.
 */
function productIssueClient(): "browser" | "electron" {
  return typeof window !== "undefined" && window.missionDesktop ? "electron" : "browser";
}

function newRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Only reachable in a non-secure context, where `randomUUID` is absent. The id is a
  // duplicate guard, not a secret, so a v4-shaped fallback is sufficient and the daemon
  // validates its shape either way.
  const hex = "0123456789abcdef";
  const pick = (): string => hex[Math.floor(Math.random() * 16)]!;
  const block = (n: number): string => Array.from({ length: n }, pick).join("");
  return `${block(8)}-${block(4)}-4${block(3)}-${"89ab"[Math.floor(Math.random() * 4)]}${block(3)}-${block(12)}`;
}
