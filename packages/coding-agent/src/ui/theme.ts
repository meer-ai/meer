export interface ThemePalette {
  /** Overall chat background */
  background: string;
  /** Header/secondary surface background */
  surface: string;
  /** Panel background such as status bars/inputs */
  panel: string;
  /** Border and divider color */
  border: string;
  /** Primary accent for highlights and prompts */
  primary: string;
  /** Secondary accent for selections */
  accent: string;
  /** Success state color */
  success: string;
  /** Warning state color */
  warning: string;
  /** Danger/ error color */
  danger: string;
  /** Informational/neutral color */
  info: string;
  /** Default foreground text color */
  text: string;
  /** Muted/secondary text color */
  muted: string;
  /** Background used for inverse/selection states */
  inverseBackground: string;
}

const DEFAULT_THEME: ThemePalette = {
  background: "#011627",
  surface: "#02223a",
  panel: "#022c44",
  border: "#0ea5e9",
  primary: "#0ea5e9",
  accent: "#06b6d4",
  success: "#14b8a6",
  warning: "#fbbf24",
  danger: "#f87171",
  info: "#38bdf8",
  text: "#e0f2fe",
  muted: "#64748b",
  inverseBackground: "#0b1d2e",
};

let activeTheme: ThemePalette = { ...DEFAULT_THEME };

/**
 * Returns the active terminal theme palette. Stored centrally so UI components
 * can be styled consistently.
 */
export function getTheme(): ThemePalette {
  return activeTheme;
}

/**
 * Merge a partial palette onto the current theme. Helpful for experiments or
 * future light/dark switching without touching every consumer.
 */
export function setTheme(partial: Partial<ThemePalette>): void {
  activeTheme = { ...activeTheme, ...partial };
}

/**
 * Reset the palette back to the Meer default colors.
 */
export function resetTheme(): void {
  activeTheme = { ...DEFAULT_THEME };
}
