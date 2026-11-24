/**
 * One dispatch flow at a time per session. The command starts its flow without holding the hook
 * open, and the tool shares the same pane state (`draftId`), so a second start while a dialog or a
 * daemon call of the first is pending would interleave with it and could leave the wrong draft
 * waiting for its description. A second start is refused with a line instead.
 */
export const FLOW_BUSY_TEXT = "A dispatch is already open. Answer or dismiss it first, then run /mission-dispatch again.";

export interface FlowGate {
  /** Runs `flow` unless another is running; `busy` is the answer when one is. */
  run: <T>(flow: () => Promise<T>) => Promise<{ busy: false; value: T } | { busy: true }>;
}

export function createFlowGate(): FlowGate {
  let running = false;
  return {
    run: async (flow) => {
      if (running) return { busy: true };
      running = true;
      try {
        return { busy: false, value: await flow() };
      } finally {
        running = false;
      }
    },
  };
}
