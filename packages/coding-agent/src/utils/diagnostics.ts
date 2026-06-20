/**
 * Tiny in-memory ring buffer for runtime diagnostics.
 *
 * The work-log render layer, the abort path, provider exceptions, and the
 * agent loop all push entries here. The `/diagnose` slash command (added
 * in a follow-up) reads it back so users can attach a real diagnostic
 * payload to bug reports instead of "it crashed."
 *
 * Intentionally lightweight: no persistence, no formatting, no
 * cross-process state. If we ever need more, swap the backing array for
 * a real circular buffer or pipe to disk.
 */

export type DiagnosticEntry = {
  timestamp: number;
  scope: string;
  message: string;
  stack?: string;
  context?: Record<string, unknown>;
};

const MAX_ENTRIES = 200;
const entries: DiagnosticEntry[] = [];

export function recordDiagnostic(
  scope: string,
  error: unknown,
  context?: Record<string, unknown>
): void {
  const isError = error instanceof Error;
  const entry: DiagnosticEntry = {
    timestamp: Date.now(),
    scope,
    message: isError ? error.message : String(error),
    stack: isError ? error.stack : undefined,
    context,
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }
}

export function getDiagnostics(limit?: number): DiagnosticEntry[] {
  if (typeof limit === "number" && limit > 0) {
    return entries.slice(-limit);
  }
  return entries.slice();
}

export function clearDiagnostics(): void {
  entries.length = 0;
}
