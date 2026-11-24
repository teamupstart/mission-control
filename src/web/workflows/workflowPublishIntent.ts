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

// Web Locks are unavailable on plain HTTP LAN dashboards. A read/write IndexedDB
// transaction also serializes the synchronous localStorage compare-and-set across tabs.
async function withPublishLock<T>(key: string, change: () => T): Promise<T> {
  if (navigator.locks) return navigator.locks.request(key, change);
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("mission-workflow-publish-locks", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("intents");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction("intents", "readwrite");
      let result: T;
      tx.oncomplete = () => { db.close(); resolve(result); };
      tx.onabort = () => { db.close(); reject(tx.error ?? new Error("Publish reservation interrupted")); };
      tx.objectStore("intents").get(key).onsuccess = () => {
        try { result = change(); }
        catch (error) { reject(error); tx.abort(); }
      };
    };
  });
}

export function discardUnreadablePublish(workflowId: string, displayed: string) {
  const key = keyFor(workflowId);
  return withPublishLock(key, () => {
    if (localStorage.getItem(key) !== displayed) throw new Error("The pending publish changed in another window.");
    localStorage.removeItem(key);
    window.dispatchEvent(new Event(changedEvent));
  });
}

export function reservePublish(workflowId: string, expectedDraftRevision: number, displayed: string | null) {
  const key = keyFor(workflowId);
  return withPublishLock(key, () => {
    const pending = localStorage.getItem(key);
    if (pending !== displayed) throw new Error("The pending publish changed in another window. Check the current publish action.");
    if (pending !== null) return intentSchema.parse(JSON.parse(pending));
    const intent = { expectedDraftRevision, requestId: Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("") };
    localStorage.setItem(key, JSON.stringify(intent));
    window.dispatchEvent(new Event(changedEvent));
    return intent;
  });
}

export function settlePublish(workflowId: string, requestId: string) {
  const key = keyFor(workflowId);
  return withPublishLock(key, () => {
    const pending = localStorage.getItem(key);
    // A late receipt from another window must not erase a newer publish.
    if (pending !== null && intentSchema.parse(JSON.parse(pending)).requestId === requestId) {
      localStorage.removeItem(key);
      window.dispatchEvent(new Event(changedEvent));
    }
  });
}
