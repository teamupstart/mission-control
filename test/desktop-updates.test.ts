import assert from "node:assert/strict";
import { test } from "node:test";
import type { UpdateSnapshot } from "../src/shared/update.ts";

test("desktop update subscription does not let an older initial read replace a live update", async () => {
  type SubscribeToDesktopUpdates = (
    updates: {
      getState(): Promise<UpdateSnapshot>;
      onState(listener: (snapshot: UpdateSnapshot) => void): () => void;
    },
    receive: (snapshot: UpdateSnapshot) => void,
  ) => () => void;

  const modulePath = "../src/web/useDesktopUpdates.ts";
  const subscribeToDesktopUpdates = await import(modulePath)
    .then((module) => module.subscribeToDesktopUpdates as SubscribeToDesktopUpdates)
    .catch((): SubscribeToDesktopUpdates => () => () => {});
  const calls: string[] = [];
  const received: string[] = [];
  const idle: UpdateSnapshot = {
    phase: "idle",
    currentVersion: "0.1.0",
    lastCheckedAt: null,
    lastOutcome: null,
  };
  const available: UpdateSnapshot = {
    phase: "available",
    currentVersion: "0.1.0",
    newVersion: "0.2.0",
    releaseTag: "v0.2.0",
    releaseName: "Mission Control 0.2.0",
    releaseNotes: "A newer update arrived.",
    publishedAt: "2026-08-19T12:00:00.000Z",
    checkedAt: Date.parse("2026-08-19T12:00:00.000Z"),
    lastOutcome: null,
  };
  let resolveIdle!: (snapshot: UpdateSnapshot) => void;
  const pendingIdle = new Promise<UpdateSnapshot>((resolve) => {
    resolveIdle = resolve;
  });
  let listener: ((snapshot: UpdateSnapshot) => void) | undefined;
  const updates = {
    getState: () => {
      calls.push("getState");
      return pendingIdle;
    },
    onState: (next: (snapshot: UpdateSnapshot) => void) => {
      calls.push("onState");
      listener = next;
      return () => {
        calls.push("unsubscribe");
      };
    },
  };

  const unsubscribe = subscribeToDesktopUpdates(updates, (snapshot) => {
    received.push(snapshot.phase);
  });
  listener?.(available);
  resolveIdle(idle);
  await Promise.resolve();
  await Promise.resolve();
  unsubscribe();

  assert.deepEqual({ calls, received }, {
    calls: ["onState", "getState", "unsubscribe"],
    received: ["available"],
  });
});
