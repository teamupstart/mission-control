import { actionFetch } from "../lib/experience.ts";
import type { ResidentProfile, ResidentProfileRevision } from "@shared/residents.ts";

/** A refused profile write, carrying the current profile when the daemon sent one. */
export class ResidentRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly profile: ResidentProfile | null,
  ) {
    super(message);
  }
}

async function residentRequest<T>(path: string, init: RequestInit): Promise<T> {
  const response = await actionFetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
  const body = (await response.json().catch(() => ({}))) as T & {
    error?: string;
    profile?: ResidentProfile;
  };
  if (!response.ok) {
    throw new ResidentRequestError(
      body.error ?? `Resident request failed (${response.status})`,
      response.status,
      body.profile ?? null,
    );
  }
  return body;
}

export function createResidentProfile(settings: ResidentProfileRevision): Promise<ResidentProfile> {
  return residentRequest<ResidentProfile>("/api/residents/profiles", {
    method: "POST",
    body: JSON.stringify({ settings }),
  });
}

export function updateResidentProfile(
  id: string,
  expectedRevision: number,
  settings: ResidentProfileRevision,
): Promise<ResidentProfile> {
  return residentRequest<ResidentProfile>(`/api/residents/profiles/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ expectedRevision, settings }),
  });
}

export function archiveResidentProfile(id: string, expectedRevision: number): Promise<ResidentProfile> {
  return residentRequest<ResidentProfile>(`/api/residents/profiles/${encodeURIComponent(id)}`, {
    method: "DELETE",
    body: JSON.stringify({ expectedRevision }),
  });
}

export function controlResident(id: string, action: "pause" | "resume" | "run-now" | "restart"): Promise<unknown> {
  return residentRequest(`/api/residents/runs/${encodeURIComponent(id)}/${action}`, { method: "POST" });
}
