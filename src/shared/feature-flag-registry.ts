import type { FeatureFlagDefinition } from "./feature-flags.ts";

export const FEATURE_FLAGS = [
  {
    id: "async-input",
    label: "Ask without stopping",
    description:
      "request_input files the question in the attention inbox and returns at once, so the agent keeps " +
      "working; your answer reaches it later as a message. A session that stops with a question open shows " +
      "as waiting on your answer.",
    stage: "preview",
    keywords: ["request_input", "question", "inbox", "asynchronous", "non-blocking", "ask"],
  },
] as const satisfies readonly FeatureFlagDefinition[];

/** Append-only. Never reuse an id: an old stored choice could gate an unrelated feature. */
export const RETIRED_FEATURE_FLAG_IDS = [] as const;
