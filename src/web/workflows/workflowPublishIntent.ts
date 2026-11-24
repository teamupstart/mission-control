import { useSyncExternalStore } from "react";
import { PublishWorkflowSchema } from "@shared/protocol.ts";

const changedEvent = "mission-workflow-publish-intent";
const intentSchema = PublishWorkflowSchema.required();
const keyFor = (workflowId: string) => `mission.workflow.publish.${workflowId}`;

function subscribe(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener(changedEvent, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(changedEvent, listener);
  };
}

export function usePendingPublish(workflowId: string | null) {
  // A primitive snapshot stays stable across renders and observes other dashboard windows.
  const raw = useSyncExternalStore(subscribe, () => {
    try { return workflowId ? localStorage.getItem(keyFor(workflowId)) : null; }
    catch { return null; } // Storage failures are surfaced before sending a publish.
  }, () => null);
  let revision: number | null = null;
  if (raw !== null) {
    try { revision = intentSchema.parse(JSON.parse(raw)).expectedDraftRevision; }
    catch { /* An unreadable record is refused by reservePublish. */ }
  }
  return { raw, revision };
}

export function reservePublish(workflowId: string, expectedDraftRevision: number, displayed: string | null) {
  const key = keyFor(workflowId);
  return navigator.locks.request(key, () => {
    const pending = localStorage.getItem(key);
    if (pending !== displayed) throw new Error("The pending publish changed in another window. Check the current publish action.");
    if (pending !== null) return intentSchema.parse(JSON.parse(pending));
    const intent = { expectedDraftRevision, requestId: crypto.randomUUID() };
    localStorage.setItem(key, JSON.stringify(intent));
    window.dispatchEvent(new Event(changedEvent));
    return intent;
  });
}

export function settlePublish(workflowId: string, requestId: string) {
  const key = keyFor(workflowId);
  return navigator.locks.request(key, () => {
    const pending = localStorage.getItem(key);
    // A late receipt from another window must not erase a newer publish.
    if (pending !== null && intentSchema.parse(JSON.parse(pending)).requestId === requestId) {
      localStorage.removeItem(key);
      window.dispatchEvent(new Event(changedEvent));
    }
  });
}
