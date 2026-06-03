import { fetch } from "undici";

const STREAM_TIMEOUT_MS = 5 * 60 * 1000; // 5 min — covers slow initial connection
const REQUEST_TIMEOUT_MS = 30 * 1000;    // 30 s — for non-streaming requests

/**
 * fetch wrapper that aborts after `timeoutMs` milliseconds.
 * For streaming responses, use STREAM_TIMEOUT_MS to allow long completions.
 * For short API calls (metadata, listings), use REQUEST_TIMEOUT_MS.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetchWithTimeout(
  url: string | URL,
  // undici and Node built-in RequestInit types diverge at Blob/ReadableStream;
  // accepting any here keeps callers from fighting that type gap.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  init: any = {},
  timeoutMs = REQUEST_TIMEOUT_MS
): ReturnType<typeof fetch> {
  const controller = new AbortController();

  // Chain with any caller-supplied signal (RequestInit.signal can be null)
  const callerSignal = init.signal ?? undefined;
  const onCallerAbort = callerSignal
    ? () => controller.abort(callerSignal.reason)
    : null;
  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort(callerSignal.reason);
    } else {
      callerSignal.addEventListener("abort", onCallerAbort!, { once: true });
    }
  }

  const timer = setTimeout(() => controller.abort(new Error("Request timed out")), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    if (callerSignal && onCallerAbort) {
      callerSignal.removeEventListener("abort", onCallerAbort);
    }
  }
}

export { STREAM_TIMEOUT_MS, REQUEST_TIMEOUT_MS };
