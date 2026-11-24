/**
 * Which session holds the pane. A session claims it before its open is awaited, so an older
 * session's late open sees an owner and does not close the pane (the pane has one id, and its close
 * would take the replacement's too). A claim whose open then fails is given back here.
 */
export interface PaneOwnership {
  owner: number | null;
}

/**
 * Gives back `mine`'s claim, and only that: a replacement that has claimed the pane since keeps its
 * claim. Answers whether a claim was released.
 */
export function releaseClaim(holder: PaneOwnership, mine: number): boolean {
  if (holder.owner !== mine) return false;
  holder.owner = null;
  return true;
}
