import React, { useEffect, useMemo } from "react";
import ansiEscapes from "ansi-escapes";
import { MeerChat, type MeerChatProps } from "./MeerChat.js";
import {
  shouldUseAlternateBuffer,
  shouldUseScreenReaderLayout,
  shouldVirtualizeHistory,
  type UISettings,
} from "../ui-settings.js";

export interface AppContainerProps extends MeerChatProps {
  uiSettings: UISettings;
}

export const AppContainer: React.FC<AppContainerProps> = ({
  uiSettings,
  ...chatProps
}) => {
  const terminalHeight =
    process.stdout.isTTY && process.stdout.rows ? process.stdout.rows : 24;
  const layoutPreferences = useMemo(() => {
    const screenReader = shouldUseScreenReaderLayout(uiSettings);
    const alternateBuffer = shouldUseAlternateBuffer(uiSettings);
    const virtualizeHistory = shouldVirtualizeHistory(
      uiSettings,
      terminalHeight
    );
    return { screenReader, alternateBuffer, virtualizeHistory };
  }, [uiSettings, terminalHeight]);

  useAlternateBuffer(layoutPreferences.alternateBuffer);

  return (
    <MeerChat
      {...chatProps}
      virtualizeHistory={layoutPreferences.virtualizeHistory}
      screenReader={layoutPreferences.screenReader}
    />
  );
};

function useAlternateBuffer(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !process.stdout.isTTY) {
      return;
    }
    try {
      process.stdout.write(ansiEscapes.enterAlternativeScreen);
      process.stdout.write(ansiEscapes.cursorHide);
    } catch {
      // Ignore terminal capability errors; fall back to default buffer.
    }
    return () => {
      try {
        process.stdout.write(ansiEscapes.cursorShow);
        process.stdout.write(ansiEscapes.exitAlternativeScreen);
      } catch {
        // noop
      }
    };
  }, [enabled]);
}

export default AppContainer;
