import { useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Session } from "@shared/types.ts";
import type { TerminalBackendId, TerminalTargetView } from "@shared/terminal.ts";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import { agentLaunchAction, agentLaunchBlockedReason, shellLaunchBlockedReason } from "@shared/session-launch.ts";
import { useTerminalTargets } from "../lib/terminalTargets.ts";
import { api } from "../lib/api.ts";
import { Keycap } from "./Keycap.tsx";
import { Tooltip } from "./Tooltip.tsx";

interface LauncherHandle {
  trigger: () => void;
  close: () => void;
}

export interface SessionLaunchersHandle {
  openTerminal: () => void;
  openAgent: () => void;
}

/**
 * The conversation pane's two launchers: a terminal on this session's worktree, and this
 * session's own agent CLI on this conversation.
 *
 * Both buttons own the same popover vocabulary because both ask the operator which terminal
 * to use. The agent control is plain only when a live pane already exists to focus.
 * No control learns a backend's name: every row is folded out of what the daemon reports for
 * `TERMINAL_BACKEND_IDS`, so a fifth adapter is a file under `src/server/terminal/` and
 * changes nothing here and nothing in the stylesheet.
 *
 * The agent button changes SHAPE with the session, and that is the honest rendering of
 * `agentLaunchAction` rather than a flourish. A live pane is focused directly; every
 * resumable no-pane state opens the backend chooser.
 */

/**
 * The rows, split out from the popover so the interesting rendering rules - an unavailable
 * backend says WHY, an available one names what it will run - are reachable from a
 * `renderToStaticMarkup` test, which never runs an effect and so can never open the real
 * menu.
 */
export function LaunchList({
  targets,
  failed,
  verb,
  onChoose,
}: {
  targets: TerminalTargetView[] | null;
  failed: boolean;
  /** What the tooltip says will happen ("Open a shell in"). */
  verb: string;
  onChoose: (target: TerminalTargetView) => void;
}): React.JSX.Element {
  if (failed) {
    return <p className="launch-note is-error">Could not ask the daemon what is available.</p>;
  }
  if (!targets) return <p className="launch-note">Checking…</p>;
  if (targets.length === 0) {
    return <p className="launch-note">This build has no terminal it can open.</p>;
  }
  return (
    <>
      {targets.map((target) => (
        <Tooltip key={target.id} label={target.unavailable ?? `${verb} ${target.label}`}>
          <button
            type="button"
            role="menuitem"
            className="launch-row"
            disabled={Boolean(target.unavailable)}
            onClick={() => onChoose(target)}
          >
            <span className="launch-glyph" aria-hidden>{target.glyph}</span>
            <span className="launch-text">
              <span className="launch-label">
                {target.label}
                {target.detail && <em>{target.detail}</em>}
              </span>
              <span className="launch-note">{target.unavailable ?? target.blurb}</span>
            </span>
          </button>
        </Tooltip>
      ))}
    </>
  );
}

/** One launcher: a button, and the backend chooser it opens. */
function Launcher({
  label,
  glyph,
  action,
  blocked,
  heading,
  verb,
  onChoose,
  ref,
}: {
  label: string;
  glyph: string;
  action: "terminal" | "agent";
  /** Why this cannot be used, as a sentence, or null when it can. */
  blocked: string | null;
  heading: string;
  verb: string;
  onChoose: (backend: TerminalBackendId) => void;
  ref?: React.Ref<LauncherHandle>;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const { targets, failed } = useTerminalTargets();

  useImperativeHandle(
    ref,
    () => ({
      trigger: () => {
        if (!blocked) setOpen((value) => !value);
      },
      close: () => setOpen(false),
    }),
    [blocked],
  );

  useEffect(() => {
    if (blocked && open) setOpen(false);
  }, [blocked, open]);

  // Keys are taken in the CAPTURE phase on `window`, above every other listener in the app,
  // and stopped IMMEDIATELY. Escape has several claimants while this is up - this menu, any
  // open overlay, and App's grid handler - and only the topmost may act, or dismissing the
  // menu also collapses the card behind it. The arrows are here for the same reason: they
  // scroll the transcript this menu is drawn over.
  //
  // `stopImmediatePropagation`, not `stopPropagation`, and the difference is load-bearing.
  // The weaker call is enough against listeners later in the path, which is what the other
  // two happen to be today - so it would be correct by accident, and the next capture-phase
  // window listener anyone adds would silently take Escape alongside this menu.
  useEffect(() => {
    if (!open) return;
    function seize(event: KeyboardEvent): void {
      event.stopImmediatePropagation();
      event.preventDefault();
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        seize(event);
        setOpen(false);
        root.current?.querySelector<HTMLButtonElement>(".launch-btn")?.focus();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const rows = [
        ...(root.current?.querySelectorAll<HTMLButtonElement>(".launch-row") ?? []),
      ].filter((row) => !row.disabled);
      if (rows.length === 0) return;
      seize(event);
      const at = rows.indexOf(document.activeElement as HTMLButtonElement);
      const step = event.key === "ArrowDown" ? 1 : -1;
      rows[(at + step + rows.length) % rows.length]?.focus();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  // Pointerdown, not click: a mousedown that starts outside should dismiss before whatever
  // it lands on gets its own event, so a click on the toolbar behind the menu does one thing
  // rather than two.
  useEffect(() => {
    if (!open) return;
    function onDown(event: PointerEvent): void {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [open]);

  // Focus the first row the human can actually use, so the menu is operable from the
  // keyboard the moment it appears.
  useEffect(() => {
    if (!open) return;
    const rows = root.current?.querySelectorAll<HTMLButtonElement>(".launch-row");
    for (const row of rows ?? []) {
      if (!row.disabled) {
        row.focus();
        return;
      }
    }
  }, [open, targets]);

  return (
    <span className="launch" ref={root}>
      <Tooltip label={blocked ?? heading}>
        <button
          type="button"
          className="launch-btn"
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={Boolean(blocked)}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="launch-glyph-lead" aria-hidden>{glyph}</span>
          <Keycap action={action} />
          {label}
          <span className="launch-caret" aria-hidden>▾</span>
        </button>
      </Tooltip>
      {open && (
        <div
          className="launch-pop"
          role="menu"
          aria-label={heading}
        >
          <span className="launch-head">{heading}</span>
          <LaunchList
            targets={targets}
            failed={failed}
            verb={verb}
            onChoose={(target) => {
              setOpen(false);
              onChoose(target.id);
            }}
          />
        </div>
      )}
    </span>
  );
}

/**
 * The pair, plus the worktree they act on.
 *
 * Rendered by `TranscriptPanel`, which is the conversation pane itself - so this reaches
 * the expanded card, the console detail and the board drill-in from one mount rather than
 * from three placements kept in step by hand.
 */
export function SessionLaunchers({
  session,
  registerLaunchers,
}: {
  session: Session;
  registerLaunchers?: (id: string, handle: SessionLaunchersHandle | null) => void;
}): React.JSX.Element {
  const [flash, setFlash] = useState<{ text: string; error: boolean } | null>(null);
  const terminalRef = useRef<LauncherHandle>(null);
  const agentRef = useRef<LauncherHandle>(null);
  const agentLabel = AGENT_IDENTITY[session.agent].label;
  const action = agentLaunchAction(session);
  const agentBlocked = agentLaunchBlockedReason(session);
  const noCheckout = shellLaunchBlockedReason(session);

  // A flash clears itself; a failure lingers longer, because it has a sentence to read.
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), flash.error ? 6000 : 2600);
    return () => clearTimeout(timer);
  }, [flash]);

  async function launch(backend: TerminalBackendId, payload: "shell" | "agent"): Promise<void> {
    const result = await api.launchTerminal(session.id, backend, payload);
    setFlash(
      result.ok
        ? { text: `Opened in ${result.label ?? backend}`, error: false }
        : { text: result.error ?? "could not open a terminal", error: true },
    );
  }

  async function focusPane(): Promise<void> {
    const result = await api.focus(session.id);
    if (!result.ok) setFlash({ text: result.error ?? "could not focus", error: true });
  }

  // App drives these same controls for the customizable `t` / `a` shortcuts. Registering
  // the pair from the conversation pane is what lets a collapsed Card or Board tile reveal
  // this pane first, then trigger the exact menu the visible button owns.
  const latest = useRef({ action, agentBlocked, focusPane });
  latest.current = { action, agentBlocked, focusPane };
  useEffect(() => {
    if (!registerLaunchers) return;
    const handle: SessionLaunchersHandle = {
      openTerminal: () => {
        agentRef.current?.close();
        terminalRef.current?.trigger();
      },
      openAgent: () => {
        const current = latest.current;
        if (current.agentBlocked) return;
        terminalRef.current?.close();
        if (current.action === "focus") {
          void current.focusPane();
        } else {
          agentRef.current?.trigger();
        }
      },
    };
    registerLaunchers(session.id, handle);
    return () => registerLaunchers(session.id, null);
  }, [session.id, registerLaunchers]);

  return (
    <div className="conv-launch">
      <span className="conv-launch-where">
        <span className="conv-launch-lbl">worktree</span>
        {/* The path ellipsizes when the pane is narrow, so the full one has to be readable
            somewhere - through the shared Tooltip, never a native `title`, which renders in
            the OS style after a delay this app does not control. */}
        <Tooltip label={session.cwd ?? "this session has no checkout"}>
          <span className="conv-launch-path mono" dir="ltr">
            {session.cwd ?? "none"}
          </span>
        </Tooltip>
      </span>
      <span className="conv-launch-sp" />
      {flash && (
        <span className={`launch-flash${flash.error ? " is-error" : ""}`}>{flash.text}</span>
      )}
      <Launcher
        ref={terminalRef}
        label="Terminal"
        glyph="❯_"
        action="terminal"
        blocked={noCheckout}
        heading="Open a shell in the worktree with"
        verb="Open a shell in"
        onChoose={(backend) => void launch(backend, "shell")}
      />
      {/* The shape change described at the top of this file: with a pane there is nothing
          to choose, so this is a plain button and not a chooser. */}
      {action === "focus" ? (
        <Tooltip label={`Go to the terminal ${agentLabel} is running in`}>
          <button type="button" className="launch-btn launch-agent" onClick={() => void focusPane()}>
            <span className="launch-glyph-lead" aria-hidden>◆</span>
            <Keycap action="agent" />
            {agentLabel}
          </button>
        </Tooltip>
      ) : action === "handoff" || action === "resume" ? (
        <Launcher
          ref={agentRef}
          label={agentLabel}
          glyph="◆"
          action="agent"
          blocked={null}
          heading={`${agentLabel} · resume this conversation in`}
          verb="Resume this conversation in"
          onChoose={(backend) => void launch(backend, "agent")}
        />
      ) : (
        <Tooltip label={agentBlocked ?? "this session is unavailable"}>
          <button type="button" className="launch-btn launch-agent" disabled>
            <span className="launch-glyph-lead" aria-hidden>◆</span>
            <Keycap action="agent" />
            {agentLabel}
          </button>
        </Tooltip>
      )}
    </div>
  );
}
