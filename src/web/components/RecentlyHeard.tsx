import { useEffect, useRef, useState } from "react";
import { VOICE_MODE_LABEL, type VoiceMode } from "@shared/voice.ts";
import type { HeardEntry } from "@shared/voice-routing.ts";
import { quotedReferenceName, type SpokenName } from "@shared/voice-names.ts";
import { fetchRecentlyHeard } from "../lib/api.ts";
import { clearVoiceHistory, useVoiceSettingsActions } from "../lib/voice-settings-actions.ts";
import { residentAccentStyle } from "../residents/marker.ts";
import { Tooltip } from "./Tooltip.tsx";

const HISTORY_REQUEST_TIMEOUT_MS = 5000;

const ruleLabels: Record<string, string> = {
  exact: "exact first word", phonetic: "sounds like", "near-miss": "near miss rejected",
  "no-name": "no opening name", "no-message": "name without a message",
  "capture-limit": "duration limit", "nothing-pending": "nothing to cancel", "ambiguous-name": "ambiguous name",
  "second-name": "second name", cancel: "spoken cancel", pick: "spoken selection",
  "separator-only": "separator word only",
  "recovered-prefix": "name after a filler", "suggested-prefix": "possible name after another word",
};
const outcomes: Record<HeardEntry["outcome"], string> = {
  pending: "Pending", resolving: "Resolving", unsure: "Unsure", cancelled: "Cancelled", sent: "Routed",
  queued: "Queued", held: "Held", "not-running": "Not running", failed: "Failed", control: "Control", ignored: "Not routed",
};

export function HeardRow({ entry, roster, now, compact }: { entry: HeardEntry; roster: readonly SpokenName[]; now: number; compact?: boolean }) {
  const { text, matchedName, outcome, rule, detail, suggested } = entry;
  const miss = rule === "near-miss";
  const openingName = rule === "exact" || rule === "phonetic" || rule === "recovered-prefix" ? matchedName : null;
  const count = miss ? 1 : (openingName ?? suggested?.[0])?.trim().split(/\s+/u).length ?? 0;
  const wordPattern = /[\p{L}\p{N}][\p{L}\p{M}\p{N}'’-]*/gu;
  const words = Array.from(text.matchAll(wordPattern));
  // Recovery's skipped words stay unmarked: the mark shows the name that was matched.
  const skipped = entry.prefix ? Array.from(entry.prefix.matchAll(wordPattern)).length : 0;
  const last = count ? words[skipped + count - 1] : undefined;
  const start = words[skipped]?.index ?? 0;
  const end = last ? last.index + last[0].length : 0;
  const seconds = Math.max(0, Math.floor((now - entry.time) / 1000));
  const ago = seconds < 60 ? seconds + "s" : seconds < 3600 ? Math.floor(seconds / 60) + "m" : Math.floor(seconds / 3600) + "h";
  const color = roster.find(agent => agent.name === matchedName && agent.isReferenceName === entry.matchedReferenceName)?.colorId;
  const name = <strong className={color ? "agent-name-resident" : undefined} style={color ? residentAccentStyle(color) : undefined}>{entry.matchedReferenceName && matchedName ? quotedReferenceName(matchedName) : matchedName}</strong>;
  const tone = outcome === "sent" || outcome === "queued" ? "routed" : outcome === "cancelled" || outcome === "failed" ? "cancel" : "not";
  if (compact) return <li className="rh-pop-row">
    <span className={`rh-pop-icon is-${tone}`} aria-label={outcomes[outcome]}>{tone === "routed" ? "✓" : tone === "cancel" || outcome === "ignored" ? "×" : "·"}</span>
    <q>{text}</q><time>{ago}</time>
    <span className="rh-pop-reason">{tone === "routed" && matchedName ? <>To {name}</> : outcomes[outcome]} · {miss && matchedName
      ? <>near miss: {name} is only a weak match</> : rule === "phonetic" ? <>{words[0]?.[0]} sounds like {name}</>
      : detail || (outcome === "cancelled" ? "cancelled before delivery" : ruleLabels[rule] ?? rule)}</span>
  </li>;
  return <tr>
    <td className="rh-mono">{ago}</td>
    <td>{end ? <>{text.slice(0, start)}<mark className={miss ? "is-miss" : undefined}>{text.slice(start, end)}</mark>{text.slice(end)}</> : text}</td>
    <td>{miss ? <>None{matchedName && <>. Closest is {name}, a weak match</>}</> : matchedName ? <>{name}{rule === "exact" ? ", exactly" : rule === "phonetic" ? ", by sound" : rule === "recovered-prefix" ? `, after “${entry.prefix?.replace(/[\p{P}\s]+$/u, "") ?? ""}”` : ""}</>
      : suggested?.length ? <>Asked: {suggested.join(" or ")}</> : "None"}</td>
    <td className="rh-mono">{ruleLabels[rule] ?? rule}{detail === "picked" && " · operator selection"}</td>
    <td><span className={`rh-out is-${tone}`}>{outcomes[outcome]}{outcome === "sent" && matchedName && <> to {name}</>}</span>
      {detail && outcome !== "control" && detail !== "picked" && <div>{detail}</div>}
    </td>
  </tr>;
}

export function RecentlyHeard({ roster, mode }: { roster: readonly SpokenName[]; mode?: VoiceMode }) {
  const [entries, setEntries] = useState<HeardEntry[] | null>(null);
  const [readError, setReadError] = useState("");
  const { clearing, clearError } = useVoiceSettingsActions();
  const generation = useRef(0);
  useEffect(() => {
    if (clearing) return;
    const lifecycle = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const current = generation.current;
      const read = await fetchRecentlyHeard(AbortSignal.any([lifecycle.signal, AbortSignal.timeout(HISTORY_REQUEST_TIMEOUT_MS)]));
      if (lifecycle.signal.aborted || current !== generation.current) return;
      if (read) setEntries(read.entries);
      setReadError(read ? "" : "Could not read recent utterances.");
      timer = setTimeout(() => void poll(), 1500);
    }
    void poll();
    return () => { lifecycle.abort(); clearTimeout(timer); };
  }, [clearing]);
  async function clear() {
    generation.current++;
    if (await clearVoiceHistory()) {
      setEntries([]);
      setReadError("");
    }
  }
  const now = Date.now();
  const knownEmpty = !readError && entries?.length === 0;
  const readStatus = readError ? "History unavailable." : "Loading…";
  if (mode) return <section aria-label="Recently heard" className="rh-pop">
    <header>Recently heard <span className="rh-pop-mode"><i data-mode={mode} />{VOICE_MODE_LABEL[mode]}</span></header>
    {clearError && <p role="alert">{clearError}</p>}{readError && <p role="alert">{readError}</p>}
    {entries?.length ? <ul>{entries.map(entry => <HeardRow key={entry.id} entry={entry} roster={roster} now={now} compact />)}</ul>
      : <div className="rh-pop-empty">{knownEmpty ? <p className="rh-empty"><b>Nothing heard yet.</b>Start with an agent's name, then say your message. Nothing is heard while voice is muted.</p> : readStatus}</div>}
    <footer><p className="rh-privacy">In memory only. Cleared on quit. Audio is never stored.</p>
      <Tooltip label="Clear recently heard utterances"><button type="button" className="btn rh-btn-sm" disabled={clearing || knownEmpty}
        onClick={() => void clear()}>Clear</button></Tooltip></footer>
  </section>;
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
