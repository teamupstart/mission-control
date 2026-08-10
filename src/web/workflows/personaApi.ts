import { personaNameFromMarkdown } from "@shared/workflow.ts";
import type { PersonaDriftView, PersonaUpstreamState, PersonaView } from "@shared/workflow.ts";

interface PersonaErrorBody {
  error?: string;
  code?: string;
  current?: PersonaView | null;
}

export async function personaRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = (await response.json().catch(() => ({}))) as T & PersonaErrorBody;
  if (!response.ok) {
    const error = new Error(body.error ?? `Persona request failed (${response.status})`) as Error & {
      status: number;
      body: PersonaErrorBody;
    };
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

/**
 * The heading rule is shared with the built-in catalog, so importing a document by hand and
 * shipping the same document produce one name rather than two spellings of it.
 */
export function deriveImportedPersonaName(filename: string, markdown: string): string {
  return personaNameFromMarkdown(
    markdown,
    filename.replace(/\.md$/i, "").trim() || "Imported Persona",
  );
}

export function personaMarkdownBlob(markdown: string): Blob {
  return new Blob([markdown], { type: "text/markdown;charset=utf-8" });
}

/**
 * Import a Markdown role the DAEMON can read, by path.
 *
 * The name and description are derived on the daemon rather than here, unlike the browser's
 * **Import .md** beside it: the daemon is the only side that has the file, and deriving in two
 * places is how one document ends up under two names.
 */
export function importPersonaFromPath(path: string): Promise<PersonaView> {
  return personaRequest<PersonaView>("/api/personas/import", {
    method: "POST",
    body: JSON.stringify({ path }),
  });
}

/** Adopt the current contents of an imported Persona's source as a new revision. */
export function reimportPersona(id: string, expectedRevision: number): Promise<PersonaView> {
  return personaRequest<PersonaView>(`/api/personas/${id}/reimport`, {
    method: "POST",
    body: JSON.stringify({ expectedRevision }),
  });
}

/**
 * Every imported Persona's upstream verdict, as a map keyed by Persona id.
 *
 * A map rather than the wire array because every reader is a lookup for one row while
 * rendering it. `current` entries are kept rather than dropped so a caller can tell "checked,
 * and it matches" from "never checked", which is what an empty map means.
 */
export async function fetchPersonaDrift(): Promise<Map<string, PersonaUpstreamState>> {
  const body = await personaRequest<{ personas: PersonaDriftView[] }>("/api/personas/drift");
  return new Map(body.personas.map((entry) => [entry.id, entry.upstream]));
}
