import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { SubagentSummary } from "@shared/types.ts";
import { ConversationActivity, useRailTab } from "../../src/web/components/ConversationActivity.tsx";

/**
 * Mounts the REAL conversation rail with the REAL `useRailTab` its owner (`TranscriptPanel`)
 * holds the selected tab in, so a tab chosen by a click survives - or does not - across the
 * Agents tab being withdrawn and offered again. `renderToStaticMarkup` cannot see that: it
 * renders once and runs no effects.
 */

declare global {
  interface Window {
    __railTabResult?: {
      errors: string[];
      steps: Record<string, { selected: string | null; tabs: string[] }>;
      clock: { before: string; after: string } | null;
    };
  }
}

const errors: string[] = [];
window.addEventListener("error", (event) => {
  errors.push(event.error instanceof Error ? event.error.message : event.message);
});

const SAMPLE: SubagentSummary = {
  agents: [
    {
      id: "a1",
      type: "Explore",
      description: "Map every offset-pagination call site",
      state: "running",
      startedAt: Date.now() - 60_000,
      endedAt: null,
      toolUses: 18,
      tokens: 41_000,
      lastTool: "Grep",
      summary: null,
      launchTurnId: null,
    },
  ],
  finishedFolded: 0,
};

let offer: (offered: boolean) => void = () => {};

function Harness(): React.JSX.Element {
  const [offered, setOffered] = useState(true);
  offer = setOffered;
  const [tab, setTab] = useRailTab(offered);
  return (
    <ConversationActivity
      messages={[]}
      open
      onToggle={() => {}}
      tab={tab}
      onTab={setTab}
      selectedTurnId={null}
      onSelectTurn={() => {}}
      collapsed={false}
      onCollapsed={() => {}}
      subagents={offered ? SAMPLE : null}
    />
  );
}

/** The tab names and which one reads selected, as a person would find them. */
function read(): { selected: string | null; tabs: string[] } {
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('#root [role="tab"]')];
  const name = (el: HTMLElement): string => (el.textContent ?? "").replace(/\d+\+?$/, "").trim();
  const selected = tabs.find((el) => el.getAttribute("aria-selected") === "true");
  return { selected: selected ? name(selected) : null, tabs: tabs.map(name) };
}

/** Effects run after commit; a macrotask later every state update they queued has landed. */
const settle = (): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, 30));

/**
 * The rail folded wide (`collapsed`) on the Agents tab with an agent running - the state a pane
 * narrowed after folding shows as a visible list. Its elapsed time must keep counting.
 */
function FoldedAgents(): React.JSX.Element {
  return (
    <ConversationActivity
      messages={[]}
      open
      onToggle={() => {}}
      tab="agents"
      onTab={() => {}}
      selectedTurnId={null}
      onSelectTurn={() => {}}
      collapsed
      onCollapsed={() => {}}
      subagents={SAMPLE}
    />
  );
}

const host = document.querySelector<HTMLDivElement>("#root");
if (!host) throw new Error("Missing rail root");
flushSync(() => createRoot(host).render(<Harness />));
const foldedHost = document.querySelector<HTMLDivElement>("#folded");
if (!foldedHost) throw new Error("Missing folded rail root");
flushSync(() => createRoot(foldedHost).render(<FoldedAgents />));
const elapsed = (): string => foldedHost.querySelector(".agents-detail")?.textContent ?? "";

void (async () => {
  const steps: Record<string, { selected: string | null; tabs: string[] }> = {};
  let clock: { before: string; after: string } | null = null;
  try {
    // One elapsed reading, then another past the next one-second tick.
    const before = elapsed();
    await new Promise((resolve) => window.setTimeout(resolve, 1_300));
    clock = { before, after: elapsed() };
    await settle();
    steps.mounted = read();
    const agents = [...document.querySelectorAll<HTMLButtonElement>('#root [role="tab"]')].find((el) =>
      (el.textContent ?? "").startsWith("Agents"),
    );
    if (!agents) throw new Error("the Agents tab was not offered");
    agents.click();
    await settle();
    steps.chosen = read();
    // Withdrawn: the operator switched to Nested sub-cards, or the agents went.
    offer(false);
    await settle();
    steps.withdrawn = read();
    // Offered again: switched back, or a new launch. The rail must not return to Agents.
    offer(true);
    await settle();
    steps.reoffered = read();
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  window.__railTabResult = { errors, steps, clock };
})();
