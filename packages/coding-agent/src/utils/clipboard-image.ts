/**
 * Read an image from the system clipboard, write it to a temp file, and
 * return a path to it. Cross-platform with no native dependencies — we
 * shell out to OS-provided utilities.
 *
 *   darwin  → osascript queries the clipboard, dumps PNG bytes to a file
 *   linux   → wl-paste (wayland) or xclip (x11)
 *   windows → PowerShell System.Windows.Forms.Clipboard.GetImage()
 *
 * Returns null when the clipboard has no image. Never throws on a missing
 * helper binary — the user just gets a no-op Ctrl+V (and we fall through
 * to text paste).
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ClipboardImageResult {
  /** Absolute path to a temp file containing the image. */
  path: string;
  mimeType: string;
}

const READ_TIMEOUT_MS = 3000;
const LIST_TIMEOUT_MS = 1000;
const POWERSHELL_TIMEOUT_MS = 5000;

function which(bin: string): boolean {
  const result = spawnSync(process.platform === "win32" ? "where" : "which", [bin], {
    timeout: LIST_TIMEOUT_MS,
  });
  return result.status === 0;
}

function tempFile(ext: string): string {
  return join(tmpdir(), `meer-clipboard-${randomUUID()}.${ext}`);
}

function fileHasBytes(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).size > 0;
  } catch {
    return false;
  }
}

function cleanup(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Best-effort.
  }
}

/* -------------------------------------------------------------------------- *
 *  macOS
 * -------------------------------------------------------------------------- */

function readDarwinClipboard(): ClipboardImageResult | null {
  // Prefer pngpaste if available — it's the cleanest path.
  const out = tempFile("png");
  if (which("pngpaste")) {
    const result = spawnSync("pngpaste", [out], { timeout: READ_TIMEOUT_MS });
    if (result.status === 0 && fileHasBytes(out)) {
      return { path: out, mimeType: "image/png" };
    }
    cleanup(out);
  }

  // Fallback: AppleScript. Works on a stock macOS, no third-party install.
  // The clipboard's «class PNGf» variant gives us PNG bytes that we write
  // to disk via `do shell script` + base64.
  const script = `
    try
      set png to (the clipboard as «class PNGf»)
      set tempPath to "${out.replaceAll(`"`, `\\"`)}"
      set fp to open for access POSIX file tempPath with write permission
      set eof of fp to 0
      write png to fp
      close access fp
      return "ok"
    on error errMsg
      try
        close access POSIX file "${out.replaceAll(`"`, `\\"`)}"
      end try
      return "noimage"
    end try
  `;
  const result = spawnSync("osascript", ["-e", script], { timeout: READ_TIMEOUT_MS });
  if (result.status === 0 && fileHasBytes(out)) {
    return { path: out, mimeType: "image/png" };
  }
  cleanup(out);
  return null;
}

/* -------------------------------------------------------------------------- *
 *  Linux
 * -------------------------------------------------------------------------- */

function readLinuxClipboardViaWlPaste(): ClipboardImageResult | null {
  if (!which("wl-paste")) return null;

  const listing = spawnSync("wl-paste", ["--list-types"], { timeout: LIST_TIMEOUT_MS });
  if (listing.status !== 0) return null;
  const types = String(listing.stdout)
    .split(/\r?\n/)
    .map((t) => t.trim())
    .filter(Boolean);
  const imageType = pickPreferredMime(types);
  if (!imageType) return null;

  const ext = extensionForMime(imageType) ?? "png";
  const out = tempFile(ext);
  const result = spawnSync("sh", [
    "-c",
    `wl-paste --type ${imageType} --no-newline > ${shellQuote(out)}`,
  ], { timeout: READ_TIMEOUT_MS });
  if (result.status === 0 && fileHasBytes(out)) {
    return { path: out, mimeType: imageType };
  }
  cleanup(out);
  return null;
}

function readLinuxClipboardViaXclip(): ClipboardImageResult | null {
  if (!which("xclip")) return null;

  const targets = spawnSync(
    "xclip",
    ["-selection", "clipboard", "-t", "TARGETS", "-o"],
    { timeout: LIST_TIMEOUT_MS }
  );
  const types =
    targets.status === 0
      ? String(targets.stdout)
          .split(/\r?\n/)
          .map((t) => t.trim())
          .filter(Boolean)
      : [];
  const preferred = pickPreferredMime(types) ?? "image/png";
  const ext = extensionForMime(preferred) ?? "png";
  const out = tempFile(ext);
  const result = spawnSync("sh", [
    "-c",
    `xclip -selection clipboard -t ${preferred} -o > ${shellQuote(out)}`,
  ], { timeout: READ_TIMEOUT_MS });
  if (result.status === 0 && fileHasBytes(out)) {
    return { path: out, mimeType: preferred };
  }
  cleanup(out);
  return null;
}

function readLinuxClipboard(): ClipboardImageResult | null {
  const wayland = Boolean(process.env.WAYLAND_DISPLAY) || process.env.XDG_SESSION_TYPE === "wayland";
  if (wayland) {
    return readLinuxClipboardViaWlPaste() ?? readLinuxClipboardViaXclip();
  }
  return readLinuxClipboardViaXclip() ?? readLinuxClipboardViaWlPaste();
}

/* -------------------------------------------------------------------------- *
 *  Windows
 * -------------------------------------------------------------------------- */

function readWindowsClipboard(): ClipboardImageResult | null {
  const out = tempFile("png");
  const psPath = out.replaceAll("\\", "\\\\").replaceAll("'", "''");
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    `$path = '${psPath}'`,
    "$img = [System.Windows.Forms.Clipboard]::GetImage()",
    "if ($img) { $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); Write-Output 'ok' } else { Write-Output 'empty' }",
  ].join("; ");

  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], {
    timeout: POWERSHELL_TIMEOUT_MS,
  });
  if (result.status === 0 && String(result.stdout).trim() === "ok" && fileHasBytes(out)) {
    return { path: out, mimeType: "image/png" };
  }
  cleanup(out);
  return null;
}

/* -------------------------------------------------------------------------- *
 *  Shared helpers
 * -------------------------------------------------------------------------- */

const SUPPORTED = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

function pickPreferredMime(types: string[]): string | null {
  const lowered = types.map((t) => t.split(";")[0]?.trim().toLowerCase() ?? "");
  for (const preferred of SUPPORTED) {
    if (lowered.includes(preferred)) return preferred;
  }
  const anyImage = lowered.find((t) => t.startsWith("image/"));
  return anyImage ?? null;
}

function extensionForMime(mime: string): string | null {
  const base = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  switch (base) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return null;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/* -------------------------------------------------------------------------- *
 *  Entry point
 * -------------------------------------------------------------------------- */

export function readClipboardImage(): ClipboardImageResult | null {
  try {
    switch (process.platform) {
      case "darwin":
        return readDarwinClipboard();
      case "linux":
        return readLinuxClipboard();
      case "win32":
        return readWindowsClipboard();
      default:
        return null;
    }
  } catch {
    return null;
  }
}
