import { useEffect, useState } from "react";
import { resolveSessionRuntime } from "@shared/harness-capabilities.ts";
import type { StandingInstructionsDelivery } from "@shared/standing-instructions.ts";
import type { AgentType } from "@shared/types.ts";
import { fetchResolvedStandingInstructions } from "../lib/api.ts";
import { deliverySummary } from "../lib/standing-instructions-view.ts";
import { StandingInstructionsDeliveryView } from "./StandingInstructionsDelivery.tsx";
import { Tooltip } from "./Tooltip.tsx";

/** Long enough to outlast typing, short enough that the note follows a pick immediately. */
const RESOLVE_DEBOUNCE_MS = 250;

/**
 * What this dispatch will send, read from LIVE configuration.
 *
 * A forecast, not a record: nothing has happened yet, so the resolved route is the right
 * source and it must follow the form. The session header's chip is the other half of this
 * pair and reads the opposite thing - see `SessionStandingInstructionsChip`.
 *
 * `repoRoots` is EVERY attached repository, in the manifest's order, not just the primary. A
 * launch composes a block for all of them, so sending one `repoPath` when the form has two
 * attached is the failure worth naming: if the primary has no rule and the secondary does,
 * this note would read "nothing will be sent" while the launch sends the secondary's block -
 * and an operator who has been told nothing is coming does not go looking for it.
 *
 * Read-only, deliberately. One editor, in Settings, is the point.
 */
export function StandingInstructionsNote({
  repoRoots,
  agent,
  storedRuntime,
}: {
  repoRoots: readonly string[];
  agent: AgentType;
  /** The harness config's stored runtime for this agent, narrowed the way a launch narrows it. */
  storedRuntime: string | null | undefined;
}): React.JSX.Element | null {
  const [delivery, setDelivery] = useState<StandingInstructionsDelivery | null>(null);
  const [open, setOpen] = useState(false);
  const runtime = resolveSessionRuntime(agent, storedRuntime).runtime;
  /**
   * The attached repositories as ONE value the effect can depend on.
   *
   * A raw array is a new identity on every render, so depending on it directly would refetch
   * forever; the effect still has to re-run when ANY attached repository changes, because the
   * note has to follow every one of them and not only the primary.
   *
   * `JSON.stringify`, and NOT a `join`. A checkout path may contain a space - `~/My Projects`
   * is an ordinary macOS directory - and a space-joined key splits back into two paths that
   * are each not a repository. The route would then refuse them, `fetchJsonWithSignal` would
   * return null, and the note would say nothing is coming while the launch delivered the
   * block. That is precisely the failure this marker exists to prevent, and it would have hit
   * exactly the operators whose paths this app never chose for them.
   */
  const key = JSON.stringify([...repoRoots]);

  useEffect(() => {
    const paths = (JSON.parse(key) as string[]).map((p) => p.trim()).filter(Boolean);
    if (paths.length === 0) {
      setDelivery(null);
      return;
    }
    const abort = new AbortController();
    // Debounced, because the repo field is a combobox an operator TYPES a path into and this
    // effect keys on its value: without it every keystroke is a request the daemon answers
    // by shelling out to `git`, and all but the last of them are about a path that was never
    // a repository. The abort still covers the in-flight one when the value moves again.
    const timer = setTimeout(() => {
      void fetchResolvedStandingInstructions(paths, agent, runtime, abort.signal).then((d) => {
        if (!abort.signal.aborted) setDelivery(d);
      });
    }, RESOLVE_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [key, agent, runtime]);

  if (!delivery?.text) return null;

  return (
    <div className="dispatch-wait-note si-note">
      <p className="si-note-line">
        <span aria-hidden>&#9998;</span>
        <span>
          <strong>Standing instructions will be sent.</strong>{" "}
          {deliverySummary(delivery.text, delivery.mechanism)}
        </span>
        <Tooltip label="Show the exact text this dispatch will send">
          <button
            type="button"
            className="btn btn-ghost si-note-view"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "hide" : "view"}
          </button>
        </Tooltip>
      </p>
      {open && (
        <StandingInstructionsDeliveryView
          delivery={delivery}
          heading="Exactly what will be sent"
        />
      )}
    </div>
  );
}
