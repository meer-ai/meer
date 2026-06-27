/**
 * Whimsical, sea-themed status words shown in place of a plain "Thinking"
 * while meer works. "Meer" is German for "sea", so the agent's idle-work
 * vocabulary leans nautical — and several of these double as work verbs
 * (Fathoming, Sounding, Charting, Navigating, Plumbing the depths), so the
 * word stays evocative without being purely decorative.
 *
 * Pure data + a deterministic selector so rotation can be unit-tested without
 * timers. The adapter adds the Date.now() clock and the trailing "…".
 */
export const SEA_PHRASES: readonly string[] = [
  "Fathoming",
  "Sounding the depths",
  "Charting a course",
  "Navigating",
  "Plumbing the depths",
  "Diving in",
  "Surfacing",
  "Trawling",
  "Dredging",
  "Cresting",
  "Drifting",
  "Snorkeling",
  "Beachcombing",
  "Wading in",
  "Churning",
  "Swirling",
  "Surging",
  "Swelling",
  "Schooling",
  "Pearl-diving",
  "Chasing the tide",
  "Riding the swell",
  "Weathering it",
  "Sifting the seabed",
];

/** How long each status word stays up before the next one rolls in, in ms. */
export const PHRASE_ROTATE_MS = 4_000;

/**
 * The status word for a turn that has been working `elapsedMs`, given a
 * per-turn starting offset `baseIndex` (so turns don't all open on the same
 * word). Pure and deterministic: same inputs → same word, which is what makes
 * the rotation testable without faking timers. Unlike the tip line, there is
 * no initial delay — a word shows from the first frame.
 */
export function phraseForElapsed(
  elapsedMs: number,
  baseIndex: number,
  phrases: readonly string[] = SEA_PHRASES
): string {
  if (phrases.length === 0) return "Working";
  const elapsed = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  const rotations = Math.floor(elapsed / PHRASE_ROTATE_MS);
  const safeBase = Number.isFinite(baseIndex) ? Math.abs(Math.trunc(baseIndex)) : 0;
  const index = (safeBase + rotations) % phrases.length;
  return phrases[index] ?? phrases[0]!;
}

/** A random starting word index for a fresh turn. */
export function randomPhraseIndex(
  phrases: readonly string[] = SEA_PHRASES,
  rand: () => number = Math.random
): number {
  if (phrases.length === 0) return 0;
  return Math.floor(rand() * phrases.length) % phrases.length;
}
