/** A bounded, body-free projection of the daemon's complete provider observation. */
export interface CodeRabbitFinding {
  id: string;
  rootId: string;
  url: string;
  path: string | null;
  identity: string;
  resolved: boolean;
  generation: number;
}

export interface CodeRabbitSummary {
  status: "unknown" | "complete" | "error";
  observationId: string | null;
  headSha: string | null;
  observedAt: number | null;
  freshUntil: number | null;
  unresolved: number | null;
  error: string | null;
  /** Only a bounded link sample travels in session snapshots. */
  threads: Pick<CodeRabbitFinding, "id" | "url" | "path">[];
  pending: number;
  delivery: string;
}

/** This request carries identity, never authority or worker-authored instructions. */
export interface CodeRabbitFollowup {
  prKey: string;
  observationId: string;
}
