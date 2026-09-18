import { useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { missionRouteHash } from "../workflows/useWorkflowRoute.ts";
import { Overlay, OVERLAY_IDS } from "./Overlay.tsx";
import { Tooltip } from "./Tooltip.tsx";

export function ForemanInfoButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <Tooltip label="About Foreman">
      <button type="button" className="foreman-info-btn" aria-label="About Foreman" onClick={onClick}>
        <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" aria-hidden="true">
          <circle cx="10" cy="10" r="8" />
          <path d="M10 9v5" strokeWidth="1.5" />
          <circle cx="10" cy="6" r="1" fill="currentColor" stroke="none" />
        </svg>
      </button>
    </Tooltip>
  );
}

/** One guide for every Foreman surface. The portal clears the topbar and drawer stacking contexts. */
export function ForemanGuide({
  onClose,
  onOpenProfile = onClose,
}: {
  onClose: () => void;
  onOpenProfile?: () => void;
}): React.JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null);
  const linkRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    const previous = document.activeElement;
    closeRef.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  const containTab = useCallback((event: KeyboardEvent) => {
    if (event.key !== "Tab") return;
    if (event.shiftKey && document.activeElement === closeRef.current) {
      event.preventDefault();
      linkRef.current?.focus();
    } else if (!event.shiftKey && document.activeElement === linkRef.current) {
      event.preventDefault();
      closeRef.current?.focus();
    }
  }, []);

  return createPortal(
    <Overlay
      id={OVERLAY_IDS.foremanGuide}
      onClose={onClose}
      onKeyDown={containTab}
      className="modal foreman-guide"
      role="dialog"
      ariaLabel="About Foreman"
      ariaModal
    >
      <header className="modal-head">
        <h2>About Foreman</h2>
        <Tooltip label="Close the Foreman guide (Escape)">
          <button ref={closeRef} type="button" className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </Tooltip>
      </header>
      <div className="modal-body foreman-guide-body">
        <p className="foreman-guide-intro">
          Foreman is your optional operator in Mission Control. It watches participating
          agent sessions, helps with routine decisions, and keeps work moving toward your
          goal. The session&apos;s agent does the work; Foreman helps decide what should happen next.
        </p>
        <section>
          <h3>How it works on your behalf</h3>
          <p>
            When an agent needs an answer, Foreman reads the question and recent context.
            It can draft or send a routine reply, recommend a choice, or bring you a short
            decision brief when your judgment is needed. You can inspect its reasoning and
            what was actually sent in the session&apos;s Foreman pane and in Settings → Foreman.
          </p>
          <p>
            With the relevant options enabled, it also checks whether assigned work is
            complete, asks the agent to address remaining gaps, and hands finished work to
            its workflow or the selected next step. It can follow pull request feedback and
            failing checks, and schedule ready backlog tasks within your limits.
          </p>
        </section>
        <section>
          <h3>What context it has</h3>
          <p>
            Foreman receives the session&apos;s goal, recent conversation, current question,
            and available session details. For a terminal session, it can also read the
            visible screen. When checking completion, it can use the work item, changes,
            project guidance, and available evidence of the work.
          </p>
          <p>
            Each evaluation starts fresh with the context supplied for that decision and
            your standing guidance. It does not have an unlimited memory of every chat or
            the whole repository. Missing context can mean it needs to leave the decision to you.
          </p>
        </section>
        <section>
          <h3>You choose how much it can do</h3>
          <ul>
            <li><strong>Dry-run:</strong> drafts replies without sending them.</li>
            <li><strong>Semi-auto:</strong> offers a draft for you to approve and send.</li>
            <li><strong>Live:</strong> can reply on your behalf in repositories you have trusted.</li>
          </ul>
          <p>
            Foreman must be enabled and running, and a session must be invited. Sessions
            launched by Mission Control are invited automatically; you can withdraw that
            invite from the session&apos;s Foreman pane. Access approvals and other automation
            have their own controls. Risky or destructive requests and decisions about
            what you actually want are handed back to you.
          </p>
        </section>
        <section>
          <h3>Make its judgment fit your priorities</h3>
          <p>
            Edit Foreman&apos;s prompt in its Library System profile to describe your
            priorities, when it should ask you, and what good work looks like. Saved guidance
            applies to later evaluations. It shapes judgment; it cannot grant extra
            permissions or turn off safety checks. Modes, models, and repository trust
            stay in their Settings controls.
          </p>
        </section>
      </div>
      <footer className="modal-foot">
        <Tooltip label="Open Foreman's standing prompt in Library">
          <a
            ref={linkRef}
            className="btn"
            href={missionRouteHash({ page: "library", shelf: "personas", assetId: "foreman" })}
            onClick={onOpenProfile}
          >
            Edit Foreman prompt in Library
          </a>
        </Tooltip>
      </footer>
    </Overlay>,
    document.body,
  );
}
