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
