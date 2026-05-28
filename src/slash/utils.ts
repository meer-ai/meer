import type { SlashCommandListEntry } from "./registry.js";

export function getSlashCommandBadges(
  entry: SlashCommandListEntry,
): string[] {
  const badges: string[] = [];

  if (entry.source === "custom") {
    if (!entry.isOverride) {
      badges.push("custom");
    } else if (entry.overrideEnabled) {
      badges.push("override");
    } else {
      badges.push("custom metadata");
      if (entry.isProtected) {
        badges.push("reserved");
      }
    }
  }

  return badges;
}

// A slash command starts with `/` followed by a simple identifier (letters,
// digits, dashes, underscores, colons) and then either end-of-string or
// whitespace. Real commands look like `/help`, `/code-review`, `/mcp ls`.
//
// We deliberately reject inputs that *look* like file paths or URLs even
// though they technically start with `/` — e.g. `/var/folders/...png` from
// a macOS paste-image, or `/usr/local/bin/x`. Without this guard, pressing
// Enter on such a paste routes the path into the slash-command executor,
// which silently fails and looks like "Enter did nothing".
const SLASH_COMMAND_HEAD = /^\/[A-Za-z][A-Za-z0-9_:-]*(?:\s|$)/;

export function isSlashCommandInput(value: string): boolean {
  const trimmed = value.trimStart();
  if (!trimmed.startsWith("/")) {
    return false;
  }
  return SLASH_COMMAND_HEAD.test(trimmed);
}
