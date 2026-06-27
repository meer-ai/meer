/**
 * Contextual tips shown under the working spinner during an agent turn.
 *
 * Pure data + selection logic so it can be unit-tested without timers or a
 * live renderer. The TUI component ({@link WorkTipComponent}) only adds the
 * Date.now() clock and styling on top of {@link tipForElapsed}.
 *
 * Every tip references a real meer slash command or keyboard shortcut — keep it
 * that way so the hint is never misleading. Cross-check against the slash
 * builtins (src/slash/builtins.ts) and the shortcuts overlay
 * (TuiChatAdapter.buildShortcutSections) when editing this list.
 */
export const WORK_TIPS: readonly string[] = [
  "Press Esc to stop the current turn without leaving meer",
  "Press Ctrl+O to cycle inline tool output: compact → auto → expanded",
  "Press Shift+Tab to cycle permission mode: normal → auto-accept → plan",
  "Press ? anytime to see every keyboard shortcut",
  "Paste an image straight from your clipboard with Ctrl+V",
  "Use /compact to summarize the conversation and reclaim context",
  "Use /tool to inspect the latest tool call's full output",
  "Use /model to switch models without restarting the session",
  "Use /provider to switch between AI providers on the fly",
  "Use /resume or /sessions to pick up an earlier conversation",
  "Use /memory to see and edit what meer remembers about this project",
  "Use /timeline to replay everything that happened this session",
  "Use /review to get a code review of your pending changes",
  "Use /init to generate a CLAUDE.md describing this codebase",
  "Use /skills to see which skills are available right now",
  "Use /stats to check token and cost usage for this session",
  "Use /budget to cap how much a session is allowed to spend",
  "Use /copy to copy meer's last response to your clipboard",
  "Scroll with your terminal's native scrollback — meer never grabs the mouse",
];

/** How long the turn must run before the first tip appears, in ms. */
export const TIP_INITIAL_DELAY_MS = 3_000;

/** How long each tip stays on screen before rotating to the next, in ms. */
export const TIP_ROTATE_MS = 15_000;

/**
 * The tip to show for a turn that has been running `elapsedMs`, given a
 * per-turn starting offset `baseIndex` (so different turns don't all open on
 * the same tip). Returns `null` while the turn is still inside the initial
 * delay — the spinner shows alone for quick turns, and the tip only joins it
 * once the work is clearly taking a moment.
 *
 * Pure and deterministic: the same inputs always yield the same tip, which is
 * what makes it testable without faking timers.
 */
export function tipForElapsed(
  elapsedMs: number,
  baseIndex: number,
  tips: readonly string[] = WORK_TIPS
): string | null {
  if (tips.length === 0) return null;
  if (elapsedMs < TIP_INITIAL_DELAY_MS) return null;
  const rotations = Math.floor((elapsedMs - TIP_INITIAL_DELAY_MS) / TIP_ROTATE_MS);
  const safeBase = Number.isFinite(baseIndex) ? Math.abs(Math.trunc(baseIndex)) : 0;
  const index = (safeBase + rotations) % tips.length;
  return tips[index] ?? null;
}

/** A random starting tip index for a fresh turn. */
export function randomTipIndex(
  tips: readonly string[] = WORK_TIPS,
  rand: () => number = Math.random
): number {
  if (tips.length === 0) return 0;
  return Math.floor(rand() * tips.length) % tips.length;
}
