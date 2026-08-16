import {
  ForemanInstructionsConflictSchema,
  ForemanInstructionsViewSchema,
} from "@shared/protocol.ts";
import type {
  ForemanInstructionsConflict,
  ForemanInstructionsUpdate,
  ForemanInstructionsView,
} from "@shared/protocol.ts";

export class ForemanProfileRequestError extends Error {
  readonly status: number;
  readonly conflict: ForemanInstructionsConflict | null;

  constructor(message: string, status: number, conflict: ForemanInstructionsConflict | null) {
    super(message);
    this.name = "ForemanProfileRequestError";
    this.status = status;
    this.conflict = conflict;
  }
}

async function viewFromResponse(response: Response): Promise<ForemanInstructionsView> {
  const body = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    const conflict = ForemanInstructionsConflictSchema.safeParse(body);
    const message = body && typeof body === "object" && "error" in body
      && typeof body.error === "string"
      ? body.error
      : `Foreman standing guidance request failed (${response.status})`;
    throw new ForemanProfileRequestError(
      message,
      response.status,
      conflict.success ? conflict.data : null,
    );
  }
  const parsed = ForemanInstructionsViewSchema.safeParse(body);
  if (!parsed.success) {
    throw new ForemanProfileRequestError(
      "The daemon returned an unreadable Foreman standing guidance document",
      response.status,
      null,
    );
  }
  return parsed.data;
}

/** Read the exact effective standing-guidance document only for the selected System profile. */
export async function fetchForemanProfile(): Promise<ForemanInstructionsView> {
  return viewFromResponse(await fetch("/api/foreman/instructions"));
}

/** Replace or reset the document through Phase 1's compare-and-swap contract. */
export async function updateForemanProfile(
  update: ForemanInstructionsUpdate,
): Promise<ForemanInstructionsView> {
  return viewFromResponse(await fetch("/api/foreman/instructions", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(update),
  }));
}

/** Exact Markdown bytes for Copy/Download parity with the editor draft. */
export function foremanMarkdownBlob(markdown: string): Blob {
  return new Blob([markdown], { type: "text/markdown;charset=utf-8" });
}
