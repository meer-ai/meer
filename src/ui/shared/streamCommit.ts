/**
 * Progressive-commit planner for streaming assistant text.
 *
 * While a response streams, completed paragraphs are committed to terminal
 * scrollback (Ink <Static>) so the live region only ever holds the
 * in-progress tail. This is what keeps long responses from flickering: Ink
 * rewrites the whole live region every frame, and once it grows taller than
 * the terminal the redraw becomes visible jank.
 *
 * The planner is fence-aware: it never splits inside a ``` code block at a
 * paragraph boundary. If a single block (paragraph or code fence) grows
 * beyond `maxLiveLines`, it force-commits at a line boundary and reports the
 * open fence so the caller can re-open it in the live tail (the committed
 * part renders its unclosed fence as code via parseMarkdownBlocks).
 */

export interface StreamCommitPlan {
  /** Chars of `pending` consumed from the start; 0 means nothing to commit. */
  consumed: number;
  /**
   * Display text for the committed part. When the consumed region started
   * inside a code fence, this is prefixed with the re-opened fence header.
   */
  commitText: string;
  /** Fence header (e.g. "```ts") active at the new boundary, null if outside. */
  openFenceAfter: string | null;
}

export interface StreamCommitOptions {
  /** Force-commit once the live tail exceeds this many lines (default 40). */
  maxLiveLines?: number;
  /** Lines kept live after a force-commit (default 12). */
  keepLiveLines?: number;
}

const DEFAULT_MAX_LIVE_LINES = 40;
const DEFAULT_KEEP_LIVE_LINES = 12;

const FENCE_LINE = /^```([^\n`]*)\s*$/;

interface LineInfo {
  /** Offset of the line start within `pending` */
  start: number;
  /** Offset just past this line's newline (or end of string) */
  end: number;
  text: string;
  /** Fence state BEFORE this line */
  fenceBefore: string | null;
  /** Fence state AFTER this line */
  fenceAfter: string | null;
}

function scanLines(pending: string, openFenceBefore: string | null): LineInfo[] {
  const infos: LineInfo[] = [];
  let fence = openFenceBefore;
  let offset = 0;

  while (offset <= pending.length) {
    const newlineIdx = pending.indexOf("\n", offset);
    const end = newlineIdx === -1 ? pending.length : newlineIdx + 1;
    const text = pending.slice(offset, newlineIdx === -1 ? pending.length : newlineIdx);

    const fenceBefore = fence;
    const fenceMatch = FENCE_LINE.exec(text.trimEnd());
    if (fenceMatch) {
      if (fence === null) {
        fence = "```" + fenceMatch[1].trim();
      } else if (fenceMatch[1].trim() === "") {
        fence = null;
      }
    }

    infos.push({ start: offset, end, text, fenceBefore, fenceAfter: fence });

    if (newlineIdx === -1) {
      break;
    }
    offset = end;
  }

  return infos;
}

function buildCommitText(
  pending: string,
  consumed: number,
  openFenceBefore: string | null
): string {
  const raw = pending.slice(0, consumed).replace(/\n+$/, "");
  return openFenceBefore ? `${openFenceBefore}\n${raw}` : raw;
}

export function planStreamCommit(
  pending: string,
  openFenceBefore: string | null,
  options: StreamCommitOptions = {}
): StreamCommitPlan {
  const maxLiveLines = options.maxLiveLines ?? DEFAULT_MAX_LIVE_LINES;
  const keepLiveLines = options.keepLiveLines ?? DEFAULT_KEEP_LIVE_LINES;
  const none: StreamCommitPlan = {
    consumed: 0,
    commitText: "",
    openFenceAfter: openFenceBefore,
  };

  if (pending.length === 0) {
    return none;
  }

  const lines = scanLines(pending, openFenceBefore);

  // Preferred: the last paragraph boundary (blank line outside any fence)
  // that has real content before it. The final line of `pending` is still
  // being streamed, so boundaries are only considered before the last line.
  let boundary: number | null = null;
  let sawContent = false;
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    if (line.fenceBefore === null && line.fenceAfter === null) {
      if (line.text.trim().length === 0) {
        if (sawContent) {
          boundary = line.end;
        }
        continue;
      }
    }
    if (line.text.trim().length > 0) {
      sawContent = true;
    }
  }

  if (boundary !== null) {
    // Extend through any further consecutive blank lines so the live tail
    // starts at content.
    let consumed = boundary;
    for (const line of lines) {
      if (line.start < consumed) continue;
      if (line.start === consumed && line.text.trim().length === 0 && line.fenceBefore === null) {
        consumed = line.end;
      } else {
        break;
      }
    }
    return {
      consumed,
      commitText: buildCommitText(pending, consumed, openFenceBefore),
      openFenceAfter: null,
    };
  }

  // Fallback: a single block has grown beyond the live budget (giant
  // paragraph or long code fence). Force-commit at a line boundary, keeping
  // the last `keepLiveLines` complete lines live.
  if (lines.length > maxLiveLines) {
    const cutIndex = lines.length - 1 - keepLiveLines;
    if (cutIndex > 0) {
      const cutLine = lines[cutIndex];
      return {
        consumed: cutLine.end,
        commitText: buildCommitText(pending, cutLine.end, openFenceBefore),
        openFenceAfter: cutLine.fenceAfter,
      };
    }
  }

  return none;
}

/** Collapse whitespace for lenient stream-vs-settled comparisons. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** True when text reads as a finished thought (sentence end or newline). */
function endsCleanly(text: string): boolean {
  return /[\n.!?:;)\]}»”"'`…]\s*$/.test(text);
}

/**
 * Commit plan for when streaming STOPS (tool batch starting). Unlike the
 * paragraph planner this wants to flush as much as possible — committed text
 * must land in scrollback before tool widgets print — but it holds back
 * dangling fragments ("#", "Now I'll") that a model emits right before a
 * tool call. Those stay in the live draft: committing them would strand a
 * half-line in scrollback forever (the model never finishes that line —
 * post-tool text starts a new paragraph).
 */
export function planFinishCommit(
  pending: string,
  openFenceBefore: string | null
): StreamCommitPlan {
  const none: StreamCommitPlan = {
    consumed: 0,
    commitText: "",
    openFenceAfter: openFenceBefore,
  };

  if (!pending.trim()) {
    return none;
  }

  const hasNewline = pending.includes("\n");

  // Whole text reads complete (or is too long to be a dangling fragment):
  // flush everything.
  if (endsCleanly(pending) || (!hasNewline && pending.length >= 60)) {
    return {
      consumed: pending.length,
      commitText: buildCommitText(pending, pending.length, openFenceBefore),
      openFenceAfter: null,
    };
  }

  // Short, single-line, doesn't end cleanly — a dangling fragment. Hold it.
  if (!hasNewline) {
    return none;
  }

  // Multi-line with a dangling last line: flush the complete lines, hold the
  // trailing fragment.
  const lines = scanLines(pending, openFenceBefore);
  const lastLine = lines[lines.length - 1];
  return {
    consumed: lastLine.start,
    commitText: buildCommitText(pending, lastLine.start, openFenceBefore),
    openFenceAfter: lastLine.fenceBefore,
  };
}
