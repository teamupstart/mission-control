import { useEffect, useRef, useState } from "react";
import type { HeardEntry } from "@shared/voice-routing.ts";
import type { SpokenName } from "@shared/voice-names.ts";
import { api, fetchRecentlyHeard } from "../lib/api.ts";
import { residentAccentStyle } from "../residents/marker.ts";
import { Tooltip } from "./Tooltip.tsx";

const ruleLabels: Record<string, string> = {
  exact: "exact first word", phonetic: "sounds like", "near-miss": "near miss rejected",
  "no-name": "no opening name", "no-message": "name without a message",
  "nothing-pending": "nothing to cancel", "ambiguous-name": "ambiguous name",
  "second-name": "second name", cancel: "spoken cancel", pick: "spoken selection",
};
const outcomes: Record<HeardEntry["outcome"], string> = {
  pending: "Pending", resolving: "Resolving", unsure: "Unsure", cancelled: "Cancelled", sent: "Routed",
  queued: "Queued", held: "Held", "not-running": "Not running", failed: "Failed", control: "Control", ignored: "Not routed",
};

export function HeardRow({ entry, roster, now }: { entry: HeardEntry; roster: readonly SpokenName[]; now: number }) {
  const { text, matchedName, outcome, rule, detail } = entry;
  const miss = rule === "near-miss";
  const count = miss ? 1 : matchedName?.trim().split(/\s+/u).length ?? 0;
  const words = Array.from(text.matchAll(/[\p{L}\p{N}][\p{L}\p{M}\p{N}'’-]*/gu));
  const last = words[count - 1];
  const start = words[0]?.index ?? 0;
  const end = last ? last.index + last[0].length : 0;
  const seconds = Math.max(0, Math.floor((now - entry.time) / 1000));
  const ago = seconds < 60 ? seconds + "s" : seconds < 3600 ? Math.floor(seconds / 60) + "m" : Math.floor(seconds / 3600) + "h";
  const color = roster.find(agent => agent.name === matchedName)?.colorId;
  const name = <strong className={color ? "agent-name-resident" : undefined} style={color ? residentAccentStyle(color) : undefined}>{matchedName}</strong>;
  const tone = outcome === "sent" || outcome === "queued" ? "routed" : outcome === "cancelled" || outcome === "failed" ? "cancel" : "not";
  return <tr>
    <td className="rh-mono">{ago}</td>
    <td>{end ? <>{text.slice(0, start)}<mark className={miss ? "is-miss" : undefined}>{text.slice(start, end)}</mark>{text.slice(end)}</> : text}</td>
    <td>{miss ? <>None{matchedName && <>. Closest is {name}, a weak match</>}</> : matchedName ? <>{name}{rule === "exact" ? ", exactly" : rule === "phonetic" ? ", by sound" : ""}</> : "None"}</td>
    <td className="rh-mono">{ruleLabels[rule] ?? rule}{detail === "picked" && " · operator selection"}</td>
    <td><span className={`rh-out is-${tone}`}>{outcomes[outcome]}{outcome === "sent" && matchedName && <> to {name}</>}</span>
      {detail && outcome !== "control" && detail !== "picked" && <div>{detail}</div>}
    </td>
  </tr>;
}

export function RecentlyHeard({ roster }: { roster: readonly SpokenName[] }) {
  const [entries, setEntries] = useState<HeardEntry[] | null>(null);
  const [readError, setReadError] = useState("");
  const [clearError, setClearError] = useState("");
  const [clearing, setClearing] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    if (clearing) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const current = generation.current;
      const read = await fetchRecentlyHeard();
      if (!alive || current !== generation.current) return;
      if (read) setEntries(read.entries);
      setReadError(read ? "" : "Could not read recent utterances.");
      timer = setTimeout(() => void poll(), 1500);
    }
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [clearing]);
  async function clear() {
    generation.current++;
    setClearing(true);
    const result = await api.clearRecentlyHeard();
    if (result.ok) {
      setEntries([]);
      setReadError("");
      setClearError("");
    } else {
      setClearError(result.error ?? "Could not clear recent utterances.");
    }
    setClearing(false);
  }
  const now = Date.now();
  const knownEmpty = !readError && entries?.length === 0;
  const readStatus = readError ? "History unavailable." : "Loading…";
  return <section aria-label="Recently heard" className="rh-dialog" data-anchor="voice/heard">
    <header className="rh-dialog-head"><strong>Recently heard</strong><span className="dim">{entries && !readError && `${entries.length} recent`}</span>
      <Tooltip label="Clear recently heard utterances"><button type="button" className="btn rh-btn-sm" disabled={clearing} onClick={() => void clear()}>Clear</button></Tooltip>
    </header>
    {clearError && <p role="alert" className="settings-error">{clearError}</p>}
    {readError && <p role="alert" className="settings-error">{readError}</p>}
    <div className="rh-scroll"><table className="rh-table" aria-label="Recently heard utterances">
      <thead><tr>{["Ago", "Heard", "Matched", "Decided by", "Outcome"].map(title => <th scope="col" key={title}>{title}</th>)}</tr></thead>
      <tbody>{entries?.length ? entries.map(entry => <HeardRow key={entry.id} entry={entry} now={now} roster={roster} />) :
        <tr><td colSpan={5} className="rh-empty-cell">{knownEmpty ? <p className="rh-empty"><b>Nothing heard yet.</b>Start with an agent's name, then say your message. Nothing is heard while voice is muted.</p> : readStatus}</td></tr>}</tbody>
    </table></div>
    <footer className="rh-dialog-foot"><p className="rh-privacy">Kept in memory, cleared when Mission Control quits. Audio is not stored.</p></footer>
  </section>;
}
