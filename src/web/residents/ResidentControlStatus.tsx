import type { Session } from "@shared/types.ts";
import { SessionControlToggle } from "../components/SessionControlToggle.tsx";
import { Tooltip } from "../components/Tooltip.tsx";

/**
 * Whether a resident's conversation holds session control right now: the Registry's live grant
 * (`session.sessionControlEnabled`), which a desktop Launch click gives the run and a restart of
 * the same conversation keeps. "Control not granted" carries the existing session control menu,
 * so the one way to grant it afterwards is the menu every session already has.
 */
export function ResidentControlStatus({ session, name }: { session: Session; name: string }): React.JSX.Element {
  const granted = session.sessionControlEnabled === true;
  return (
    <span className={`resident-control${granted ? " is-granted" : ""}`}>
      <Tooltip
        label={granted
          ? `${name} can read and steer your other live sessions. Turn it off from the session control menu.`
          : "Only a Launch click in the Mission Control desktop app gives a resident session control. The session control menu grants it for this conversation only."}
      >
        <span className="resident-control-state" role="status" tabIndex={0}>
          {granted ? "control granted" : "control not granted"}
        </span>
      </Tooltip>
      {!granted && <SessionControlToggle session={session} />}
    </span>
  );
}
