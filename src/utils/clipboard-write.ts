/**
 * Write text to the system clipboard. Cross-platform with no native
 * dependencies — we shell out to OS utilities, same pattern as the
 * clipboard-image reader.
 *
 *   darwin  → pbcopy
 *   linux   → wl-copy (wayland) or xclip
 *   windows → clip
 *
 * Returns `true` on success, `false` on any failure (missing binary,
 * permission denied, etc.). Never throws — callers can fall back to
 * "the text is here, copy it manually" UX.
 */

import { spawnSync } from "node:child_process";

const TIMEOUT_MS = 1500;
const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024; // 5MB — well past anything sane.

export function writeClipboardText(text: string): boolean {
  if (!text) return false;
  if (Buffer.byteLength(text, "utf8") > MAX_PAYLOAD_BYTES) {
    return false;
  }

  try {
    switch (process.platform) {
      case "darwin":
        return run("pbcopy", [], text);
      case "linux":
        if (process.env.WAYLAND_DISPLAY) {
          return run("wl-copy", [], text);
        }
        return run("xclip", ["-selection", "clipboard"], text);
      case "win32":
        return run("clip", [], text);
      default:
        return false;
    }
  } catch {
    return false;
  }
}

function run(command: string, args: string[], input: string): boolean {
  const result = spawnSync(command, args, {
    input,
    timeout: TIMEOUT_MS,
  });
  return result.status === 0;
}
