/** App's document-lifetime latch is settled only by an opening, a launch, or disabled startup. */
export function startupTourDecision(state: {
  handled: boolean;
  hydrated: boolean;
  enabled: boolean;
  hasTours: boolean;
  busy: boolean;
}): "wait" | "settle" | "open" {
  if (state.handled || !state.hydrated) return "wait";
  if (!state.enabled || !state.hasTours) return "settle";
  return state.busy ? "wait" : "open";
}
