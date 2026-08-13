import { useGuidedDispatch } from "../lib/guided-dispatch.ts";
import { Tooltip } from "./Tooltip.tsx";

/**
 * How the dispatch form asks for a task.
 *
 * The durable home for the guided-dispatch preference. The dispatch modal's header carries
 * the same switch, and that one is where you reach for it mid-dispatch - but it is only
 * findable if you are ALREADY dispatching, which makes it a control for people who have met
 * the feature rather than a place to look one up. This panel is the place to look it up,
 * and it is what puts the preference in the ⌘K index under a name.
 *
 * Both surfaces are `useGuidedDispatch()`, which is a module-level store rather than a hook
 * over `useState` - so the switch here and the switch in the modal are one value and cannot
 * drift apart while both are on screen.
 *
 * No props and no effects, deliberately: `useUiConfig()` is synchronous with shipped
 * defaults, so this renders its anchor and its control on the first paint. The daemon-backed
 * panels cannot, which is why they render disabled-but-present until their poll lands - and
 * why the static render harness in `test/settings-search.test.ts` can hand this one nothing
 * at all.
 */
export function DispatchSettingsPanel(): React.JSX.Element {
  const [guided, setGuided] = useGuidedDispatch();
  return (
    <section className="settings-section">
      <p className="settings-hint settings-blurb">
        How this dashboard <strong>composes</strong> a dispatch. Nothing here changes what a
        dispatched agent is given or what it may do - those are Harnesses, and they reach
        sessions this page never opened.
      </p>

      <label
        className={`settings-toggle${guided ? " is-on" : ""}`}
        data-anchor="dispatch/guided"
      >
        <Tooltip label="Ask for kind, harness and after work first, then hand over the form">
          <input
            type="checkbox"
            checked={guided}
            onChange={(e) => setGuided(e.target.checked)}
          />
        </Tooltip>
        <span className="settings-toggle-text">
          <span className="settings-toggle-label">Guided dispatch</span>
          <span className="settings-toggle-desc">
            Opening the dispatch form asks three questions first - what kind of run this is,
            which harness runs it, and what happens after the work - each answerable with a
            single key, and then hands over the ordinary form with those answers already
            filled in. Press <kbd>⇥</kbd> at any question to leave the pass and fill the rest
            of the form yourself; everything answered up to that point is kept.
          </span>
        </span>
      </label>

      <p className="settings-hint">
        The same switch sits in the dispatch form's own header, so the pass can be turned off
        without abandoning the dispatch you are in the middle of. There is one preference
        behind both, and it is per browser.
      </p>
    </section>
  );
}
