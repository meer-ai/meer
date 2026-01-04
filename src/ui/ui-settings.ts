export type ScreenReaderMode = "auto" | "on" | "off";
export type VirtualizedHistoryMode = "auto" | "always" | "never";
export type ScrollMode = "auto" | "manual";

export interface UISettings {
  useAlternateBuffer: boolean;
  screenReaderMode: ScreenReaderMode;
  virtualizedHistory: VirtualizedHistoryMode;
  scrollMode: ScrollMode;
}

export type UISettingsInput = Partial<UISettings> | undefined;

export const DEFAULT_UI_SETTINGS: UISettings = {
  useAlternateBuffer: false, // Disabled by default to prevent blank screen issues
  screenReaderMode: "auto",
  virtualizedHistory: "auto",
  scrollMode: "auto",
};

export function resolveUISettings(input?: UISettingsInput): UISettings {
  return {
    useAlternateBuffer:
      input?.useAlternateBuffer ?? DEFAULT_UI_SETTINGS.useAlternateBuffer,
    screenReaderMode:
      input?.screenReaderMode ?? DEFAULT_UI_SETTINGS.screenReaderMode,
    virtualizedHistory:
      input?.virtualizedHistory ?? DEFAULT_UI_SETTINGS.virtualizedHistory,
    scrollMode: input?.scrollMode ?? DEFAULT_UI_SETTINGS.scrollMode,
  };
}

function parseBooleanFlag(value?: string): boolean | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

export function shouldUseAlternateBuffer(
  settings: UISettings,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (!process.stdout.isTTY) return false;
  const envOverride = parseBooleanFlag(env.MEER_UI_ALT_BUFFER);
  if (envOverride !== undefined) {
    return envOverride;
  }
  return settings.useAlternateBuffer;
}

export function shouldUseScreenReaderLayout(
  settings: UISettings,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (settings.screenReaderMode === "on") {
    return true;
  }
  if (settings.screenReaderMode === "off") {
    return false;
  }
  const envOverride =
    parseBooleanFlag(env.MEER_UI_SCREEN_READER) ??
    parseBooleanFlag(env.MEER_SCREEN_READER);
  return envOverride ?? false;
}

export function shouldVirtualizeHistory(
  settings: UISettings,
  terminalHeight: number
): boolean {
  if (settings.virtualizedHistory === "always") return true;
  if (settings.virtualizedHistory === "never") return false;
  // Auto: enable when the terminal is tall enough or history is likely large.
  return terminalHeight >= 40;
}
