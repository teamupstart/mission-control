import type { Session } from "@shared/types.ts";
import { SessionControlToggle } from "../components/SessionControlToggle.tsx";
import { Tooltip } from "../components/Tooltip.tsx";

/**
 * Whether a resident's conversation holds session control right now: the Registry's live grant
 * (`session.sessionControlEnabled`), which a desktop Launch click gives the run and a restart of
 * the same conversation keeps. "Control not granted" carries the existing session control menu,
 * so the one way to grant it afterwards is the menu every session already has.
 *
 * `badge` draws it as the dock card's footer badge: a shield and one word, because the footer
 * shares its line with the run controls and Open. The status keeps its full sentence as its
 * accessible name, so a screen reader hears the same words the band prints.
 */
export function ResidentControlStatus({ session, name, badge = false }: {
  session: Session;
  name: string;
  badge?: boolean;
}): React.JSX.Element {
  const granted = session.sessionControlEnabled === true;
  const status = granted ? "control granted" : "control not granted";
  return (
    <span className={`resident-control${granted ? " is-granted" : ""}${badge ? " is-badge" : ""}`}>
      <Tooltip
        label={granted
          ? `${name} can read and steer your other live sessions. Turn it off from the session control menu.`
          : "Only a Launch click in the Mission Control desktop app gives a resident session control. The session control menu grants it for this conversation only."}
      >
        <span className="resident-control-state" role="status" tabIndex={0} aria-label={badge ? status : undefined}>
          {badge ? <>
            <svg className="resident-control-shield" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 1.5 2.5 3.6v4.1c0 3.2 2.3 5.9 5.5 6.8 3.2-.9 5.5-3.6 5.5-6.8V3.6L8 1.5Z" />
              {granted && <path d="m5.6 8 1.7 1.7 3.2-3.3" />}
            </svg>
            {granted ? "Control" : "No control"}
          </> : status}
        </span>
      </Tooltip>
      {!granted && <SessionControlToggle session={session} />}
    </span>
  );
}
