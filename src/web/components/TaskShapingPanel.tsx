import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SHAPER_SIGN_IN_FLAG_ID } from "@shared/feature-flag-registry.ts";
import {
  canonicalJson,
  type DiscoveredShaper,
  type ShapingFolderStatus,
  type ShapingIntent,
  type ShapingReferenceStatus,
  type ShapingSignInView,
} from "@shared/shaping.ts";
import {
  signInConnectionKey,
  signInControlConnection,
  signInControlSubject,
  signInLinkFor,
  signInLinkHeld,
  signInLinksAfter,
  signInMovedSince,
  signInMovesAfter,
  signInMovesSince,
  signInRefusalsAfter,
  signInSubject,
  signInUrlOpenable,
  type ShaperSignInLink,
  type ShaperSignInRefusal,
  type SignInMoves,
  type ShapingWriteOutcome,
} from "../lib/shaping-settings.ts";
import { api, fetchRepos } from "../lib/api.ts";
import { openExternalChecked } from "../lib/open-external.ts";
import { NO_SHAPING_SIGN_INS } from "../lib/shaping-sign-ins.ts";
import { useFeatureFlag } from "../useFeatureFlag.ts";
import type { ShapingSettings } from "../useShapingSettings.ts";
import type { ShapingTestRunner } from "./TaskShapingDialogs.tsx";
import { TaskShapingView, type ShaperSignInProps } from "./TaskShapingView.tsx";

/** What a row says when the daemon's sign-in link is not one the dashboard may open. */
export const SIGN_IN_URL_REFUSED = "The daemon's sign-in link is not https or this machine's loopback, so it was not opened. Start again, or check the shaper's server.";

/** What a row says when the sign-in page could not be opened: a blocked tab, or a desktop bridge that failed. */
export const SIGN_IN_TAB_NOT_OPENED = "The sign-in page did not open. Use Open the sign-in page to try again, or Copy link to open it in another browser.";

/** A refusal's sentence: the daemon's fixed reason, or what the request met when it had none. */
function refusalText(reply: { reason?: string; error?: string }, what: string): string {
  return reply.reason ?? `The ${what} did not go through: ${reply.error ?? "no answer"}.`;
}

/**
 * Settings > Task shaping. The config is the event stream's, through `useShapingSettings`, so
 * every window shows a change the moment it commits. The one read here is of facts about the
 * daemon's machine rather than the config: whether each named environment variable is set, never
 * a value, and what the shapers folder holds. It is asked again whenever the config changes.
 */
export function TaskShapingPanel({ state, signIns = NO_SHAPING_SIGN_INS }: {
  state?: ShapingSettings;
  /** The daemon's sign-in list, the event stream's: empty while `shaper-sign-in` is off. */
  signIns?: readonly ShapingSignInView[];
}): React.JSX.Element {
  const config = state?.config ?? null;
  const ready = state?.ready ?? false;
  const [references, setReferences] = useState<ShapingReferenceStatus>({});
  // The shapers folder, as the daemon's scan reported it. Read when Settings opens and again
  // whenever the config changes, since a stored choice changes what each row shows.
  const [discovered, setDiscovered] = useState<readonly DiscoveredShaper[]>([]);
  const [folder, setFolder] = useState<ShapingFolderStatus | null>(null);
  // Keyed on the config the stream confirmed, not the optimistic one: an import is drawn before
  // it commits, and a read taken then knows nothing of the variables it names. The confirming
  // frame changes this key, so the status is read again once the daemon holds the import.
  const confirmed = state?.confirmed ?? null;
  const configKey = confirmed ? canonicalJson(confirmed) : null;
  // A refused write changes no config, yet a folder shaper's refusal says its manifest changed on
  // disk. So every write that settles, whatever its outcome, counts one more folder read: the row
  // then shows what is on disk now, and the operator's next click names that manifest.
  const [settledWrites, setSettledWrites] = useState(0);
  const set = useCallback(async (intent: ShapingIntent, key: string): Promise<ShapingWriteOutcome> => {
    if (!state) return "not_sent";
    const outcome = await state.set(intent, key);
    if (outcome !== "not_sent") setSettledWrites((count) => count + 1);
    return outcome;
  }, [state]);
  useEffect(() => {
    if (!ready || configKey === null) return;
    let current = true;
    void api.getShaping().then((reply) => {
      if (!current || !reply.ok) return;
      if (reply.references) setReferences(reply.references);
      setDiscovered(Array.isArray(reply.discovered) ? reply.discovered : []);
      setFolder(reply.folder ?? null);
    });
    return () => { current = false; };
  }, [ready, configKey, settledWrites]);
  // The folder's shapers, read when a removal is confirmed, so the confirmation can say a folder
  // shaper with the same id stays switched off. Null when the read fails.
  const readFolderIds = useCallback(async (): Promise<string[] | null> => {
    const reply = await api.getShaping();
    return reply.ok && Array.isArray(reply.discovered) ? reply.discovered.map((entry) => entry.id) : null;
  }, []);
  const onTest = useCallback<ShapingTestRunner>((request, signal) => api.testShaper(request, signal), []);
  const signIn = useShaperSignIn(signIns);
  const repositories = useCallback(() => fetchRepos(), []);
  return (
    <TaskShapingView
      config={config}
      references={references}
      pending={state?.pending ?? null}
      errors={state?.errors ?? {}}
      earlier={state?.earlier ?? {}}
      outcomeArrivals={state?.outcomeArrivals ?? {}}
      outcomeSubjects={state?.outcomeSubjects ?? {}}
      locked={state?.locked}
      awaitingRevision={state?.awaitingRevision}
      onDismiss={state?.dismiss}
      ready={ready}
      onSet={set}
      onTest={onTest}
      repositories={repositories}
      readFolderIds={readFolderIds}
      discovered={discovered}
      folder={folder}
      signIn={signIn}
    />
  );
}

/**
 * Shaper sign-in as this window holds it. The list is the daemon's; what is this window's own is
 * the authorization link of each sign-in it started, kept until the list shows that sign-in in
 * another state, which a reload drops too, and each control's request in flight and refusal. The
 * dashboard opens the link; the daemon never starts a browser.
 */
function useShaperSignIn(signIns: readonly ShapingSignInView[]): ShaperSignInProps {
  const enabled = useFeatureFlag(SHAPER_SIGN_IN_FLAG_ID);
  const [held, setHeld] = useState<Readonly<Record<string, ShaperSignInLink>>>({});
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [refusals, setRefusals] = useState<Readonly<Record<string, ShaperSignInRefusal>>>({});
  // A link lives only while its sign-in is pending, so each new list may end some.
  const shown = enabled ? signIns : NO_SHAPING_SIGN_INS;
  // The list as it is now, for a reply that lands after the event it follows.
  const latest = useRef(shown);
  latest.current = shown;
  // Each connection's state changes, counted over every list this window has drawn, so a reply
  // can tell what happened while its request was in flight. Advanced once per new list, so a
  // second render of the same list counts nothing.
  const moves = useRef<{ list: readonly ShapingSignInView[]; moves: SignInMoves }>({ list: shown, moves: {} });
  if (moves.current.list !== shown) moves.current = { list: shown, moves: signInMovesAfter(moves.current.moves, moves.current.list, shown) };
  // Counts each time the flag changes. A reply that lands with the flag off, or after it went off
  // and on again, belongs to controls that are gone: it keeps no link and opens nothing.
  const activation = useRef({ enabled, count: 0 });
  if (activation.current.enabled !== enabled) activation.current = { enabled, count: activation.current.count + 1 };
  const stillActive = useCallback((sentIn: number): boolean => activation.current.enabled && activation.current.count === sentIn, []);
  useEffect(() => { setHeld((current) => signInLinksAfter(current, shown)); }, [shown]);
  // A refusal describes its connection as it was: once another window, a refresh or an expiry
  // moves that connection on, the row shows the new state without the old refusal beside it.
  useEffect(() => { setRefusals((current) => signInRefusalsAfter(current, shown)); }, [shown]);
  /**
   * Starts a control's request. `busyKey` is what the request holds: a row's Sign in holds its
   * row, while Cancel sign-in and Sign out hold the connection, so every row and entry on that
   * connection waits for the one in flight. `key` is where the control's refusal is shown.
   */
  const begin = useCallback((busyKey: string, key: string): void => {
    setBusy((current) => new Set(current).add(busyKey));
    setRefusals((current) => { const next = { ...current }; delete next[key]; return next; });
  }, []);
  /** Shows a refusal under `key` against `subject`, outside any request. */
  const refuse = useCallback((key: string, text: string, subject: string): void => {
    setRefusals((current) => ({ ...current, [key]: { text, subject } }));
  }, []);
  /**
   * Ends a control's request, sent when the counts were `sent`. A refusal is shown against the
   * connection's state now, or against `subject` when the refusal expects a state the list has
   * yet to show. A refusal whose connection changed state while the request was in flight, such
   * as a sign-out another window made meanwhile, no longer describes the row and is not shown.
   */
  const settle = useCallback((busyKey: string, key: string, error: string | null, sent: SignInMoves, subject?: string): void => {
    setBusy((current) => { const next = new Set(current); next.delete(busyKey); return next; });
    if (error === null) return;
    if (subject === undefined && signInMovedSince(sent, moves.current.moves, signInControlConnection(latest.current, key))) return;
    const refusal: ShaperSignInRefusal = { text: error, subject: subject ?? signInControlSubject(latest.current, key) };
    setRefusals((current) => ({ ...current, [key]: refusal }));
  }, []);
  /**
   * Opens a held sign-in link. One that did not open leaves a refusal on the row, shown while
   * that sign-in is pending, pointing at the two controls that offer the link again.
   */
  const open = useCallback((connection: string, url: string, key: string): void => {
    // The desktop bridge may answer late. A failure that lands after the sign-in moved on, such
    // as one another window cancelled or finished meanwhile, or after the flag changed, no
    // longer describes the row and is not shown.
    const sent = moves.current.moves;
    const sentIn = activation.current.count;
    void openExternalChecked(url).then((opened) => {
      if (opened || !stillActive(sentIn) || signInMovedSince(sent, moves.current.moves, connection)) return;
      refuse(key, SIGN_IN_TAB_NOT_OPENED, signInSubject(connection, "pending"));
    });
  }, [refuse, stillActive]);
  const onSignIn = useCallback((shaper: string, key: string): void => {
    begin(key, key);
    // The counts as the request went out, so the reply can tell whether the sign-in moved on,
    // and perhaps back, while it was in flight.
    const sent = moves.current.moves;
    const sentIn = activation.current.count;
    void api.signInShaper(shaper).then((reply) => {
      if (!reply.ok || !reply.authorizationUrl || !reply.connection) {
        settle(key, key, refusalText(reply, "sign-in"), sent);
        return;
      }
      if (!stillActive(sentIn)) {
        // The flag went off while the request was in flight: the row offers no sign-in now, so
        // there is no link to hold and no page to open.
        settle(key, key, null, sent);
        return;
      }
      const { authorizationUrl, connection } = reply;
      const link = signInLinkFor(latest.current, connection, authorizationUrl, signInMovesSince(sent, moves.current.moves, connection));
      if (!signInUrlOpenable(authorizationUrl)) {
        // The daemon did start this sign-in, so the refusal stands while it is pending and goes
        // once it lapses or is cancelled, whichever of its event and this reply came first. One
        // already over when the reply lands has nothing left to refuse.
        settle(key, key, link ? SIGN_IN_URL_REFUSED : null, sent, signInSubject(connection, "pending"));
        return;
      }
      setHeld((current) => signInLinkHeld(current, connection, link));
      settle(key, key, null, sent);
      // A sign-in that is already over has no page worth opening.
      if (link) open(connection, authorizationUrl, key);
    });
  }, [begin, settle, open, stillActive]);
  const onSignOut = useCallback((connection: string, key: string): void => {
    const busyKey = signInConnectionKey(connection);
    begin(busyKey, key);
    const sent = moves.current.moves;
    void api.signOutShaper(connection).then((reply) => {
      if (reply.ok) setHeld((current) => { const next = { ...current }; delete next[connection]; return next; });
      settle(busyKey, key, reply.ok ? null : refusalText(reply, "sign-out"), sent);
    });
  }, [begin, settle]);
  const onOpen = useCallback((connection: string, url: string, key: string): void => {
    setRefusals((current) => { const next = { ...current }; delete next[key]; return next; });
    if (signInUrlOpenable(url)) open(connection, url, key);
  }, [open]);
  const links = useMemo(() => Object.fromEntries(Object.entries(held).map(([connection, link]) => [connection, link.url])), [held]);
  const errors = useMemo(() => Object.fromEntries(Object.entries(refusals).map(([key, refusal]) => [key, refusal.text])), [refusals]);
  return useMemo(() => ({
    enabled, signIns: enabled ? signIns : NO_SHAPING_SIGN_INS, links, busy, errors, onSignIn, onSignOut, onOpen,
  }), [enabled, signIns, links, busy, errors, onSignIn, onSignOut, onOpen]);
}
