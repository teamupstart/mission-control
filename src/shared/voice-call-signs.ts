// Automatic call signs (`voice` preview flag): the name a task dispatched without one is given.
//
// Browser-safe: no `node:` import may reach this module. The dictionary and the choice are said
// once here, so the daemon's allocation, its tests and any surface that explains the rule read
// one list. The choice asks `validateSpokenName`, the rule the dispatch form's meter and the
// router already share, so an assigned name is one the operator would see as distinctive.

import { normalizeSpokenName, validateSpokenName } from "./voice-names.ts";

/**
 * The names an automatic call sign is drawn from: a few dozen everyday nouns of two syllables or
 * more that start with many different sounds, so few pairs can be heard as each other. Every
 * entry passes `validateSpokenName` on its own and no two sound alike (`namesSoundAlike`);
 * `test/voice-call-sign-allocation.test.ts` holds both. Extend by appending a name that keeps
 * both true; order carries no meaning.
 */
export const AUTO_CALL_SIGN_DICTIONARY = [
  "Atlas", "Badger", "Banjo", "Bramble", "Cactus", "Cobalt", "Comet", "Delta", "Dynamo", "Echo",
  "Ember", "Falcon", "Gemini", "Granite", "Harbor", "Indigo", "Juniper", "Kestrel", "Koala",
  "Lantern", "Lotus", "Mango", "Maple", "Marlin", "Mosaic", "Nimbus", "Nova", "Onyx", "Orchid",
  "Phoenix", "Pixel", "Quasar", "Raven", "Rocket", "Saffron", "Sequoia", "Tango", "Topaz",
  "Tundra", "Velvet", "Voyager", "Walrus", "Yukon",
] as const;

/** A name another agent answers to, as the choice weighs it. */
export interface CallSignClaim {
  name: string;
  isReferenceName?: true;
  /**
   * Whether a new agent may take this exact name from its holder: true only for a finished
   * task's name still on the roster. The roster drops a stopped task's name as soon as a running
   * agent answers to the same one (`computeVoiceRoster`), so reusing it leaves one agent on it.
   */
  displaceable: boolean;
}

/** FNV-1a over the seed, so one task always starts its walk of the dictionary at one place. */
function startIndex(seed: string, size: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % size;
}

/**
 * The call sign to give a task that has none, or null when every dictionary name is unsafe.
 *
 * The walk starts at a place fixed by `seed` (the task id), so different tasks spread over the
 * dictionary and one task asked twice gets the same answer. It takes, in order:
 *
 *  1. the first name with no `validateSpokenName` warning against every claim: free, and heard as
 *     no other agent;
 *  2. otherwise, the first name whose only conflicts are finished tasks holding that exact name:
 *     reusing it displaces them, so it is still the one agent on that name;
 *  3. otherwise null. The task is dispatched without a call sign rather than with one that can be
 *     heard as another agent's; the operator can still give it one.
 */
export function chooseAutoCallSign(
  claims: readonly CallSignClaim[],
  seed: string,
  dictionary: readonly string[] = AUTO_CALL_SIGN_DICTIONARY,
): string | null {
  if (dictionary.length === 0) return null;
  const start = startIndex(seed, dictionary.length);
  const order = dictionary.map((_, i) => dictionary[(start + i) % dictionary.length]!);
  const held = claims.filter((claim) => !claim.displaceable);
  const free = order.find((name) => validateSpokenName(name, claims).length === 0);
  if (free) return free;
  return order.find((name) => {
    if (validateSpokenName(name, held).length > 0) return false;
    const normalized = normalizeSpokenName(name);
    const conflicts = claims.filter((claim) => claim.displaceable && validateSpokenName(name, [claim]).length > 0);
    return conflicts.length > 0 && conflicts.every((claim) => normalizeSpokenName(claim.name) === normalized);
  }) ?? null;
}
