import {
  SETUP_SERVICE_INFO,
  type SetupServiceId,
} from "@shared/setup-catalog.ts";

import { herdrServerStart } from "../terminal/herdr.ts";
import type { TerminalResult } from "../terminal/types.ts";

/**
 * Starting one local background service a Setup row asked about.
 *
 * The sibling of `install.ts`, and deliberately narrower than it. An install remedy composes
 * a command and opens it in a terminal the operator watches, because installing writes to
 * their machine and takes minutes. Starting a service does not: it is a call the daemon
 * already makes on its own during a dispatch, so it runs here and returns whether the
 * service is now answering.
 *
 * The request carries an id and nothing else. Every starter is a function in this file, so
 * there is no argv for a browser to influence and no path by which an unknown service can
 * be named - `Record<SetupServiceId, …>` fails typecheck until a new id has one.
 */
export type SetupServiceOutcome = "started" | "refused" | "unknown";

export interface SetupServiceResult {
  ok: boolean;
  service: SetupServiceId;
  outcome: SetupServiceOutcome;
  label: string;
  detail: string;
}

export type SetupServiceStarters = Record<SetupServiceId, () => Promise<TerminalResult>>;

export const DEFAULT_SETUP_SERVICE_STARTERS: SetupServiceStarters = {
  "herdr-server": () => herdrServerStart(),
};

export interface SetupServiceResponse {
  status: 200 | 409 | 504;
  body: SetupServiceResult;
}

/** Start the named service, reporting only what this call established. */
export async function startSetupService(
  service: SetupServiceId,
  starters: SetupServiceStarters = DEFAULT_SETUP_SERVICE_STARTERS,
): Promise<SetupServiceResponse> {
  const label = SETUP_SERVICE_INFO[service].label;
  const result = await starters[service]();
  if (result.ok) {
    return {
      status: 200,
      body: {
        ok: true,
        service,
        outcome: "started",
        label,
        detail: `The ${label} is running.`,
      },
    };
  }
  // `outcomeUnknown` is the transport saying it may have started something it could not then
  // confirm. Reporting that as a refusal would invite a second start against a server that
  // is already up, so it keeps its own outcome and the row is re-checked either way.
  const unknown = result.outcomeUnknown;
  return {
    status: unknown ? 504 : 409,
    body: {
      ok: false,
      service,
      outcome: unknown ? "unknown" : "refused",
      label,
      detail: result.error ?? `The ${label} could not be started.`,
    },
  };
}
