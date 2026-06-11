/**
 * Pure markdown helpers for terminal rendering.
 *
 * Lives outside the React components so the parsing rules can be unit-tested
 * without standing up an Ink render.
 */

export interface MarkdownBlock {
  type: "text" | "code";
  content: string;
  language?: string;
  /** False when a trailing code fence never closed (mid-stream). */
  closed: boolean;
}

/**
 * Split content into text and fenced-code blocks.
 *
 * Unlike a strict parser, a trailing unclosed fence is returned as a code
 * block with `closed: false` — while a response is streaming we want the
 * partial code to render as code immediately instead of flashing as raw text
 * with a visible ``` until the closing fence arrives.
 */
export function parseMarkdownBlocks(content: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const fenceRegex = /^```([^\n`]*)$/;
  const lines = content.split("\n");

  let textLines: string[] = [];
  let codeLines: string[] = [];
  let inFence = false;
  let language: string | undefined;

  const flushText = () => {
    if (textLines.length > 0) {
      const text = textLines.join("\n");
      if (text.trim().length > 0) {
        blocks.push({ type: "text", content: text, closed: true });
      }
      textLines = [];
    }
  };

  for (const line of lines) {
    const fenceMatch = fenceRegex.exec(line.trimEnd());
    if (fenceMatch && !inFence) {
      flushText();
      inFence = true;
      language = fenceMatch[1].trim() || undefined;
      codeLines = [];
      continue;
    }
    if (fenceMatch && inFence && fenceMatch[1].trim() === "") {
      blocks.push({
        type: "code",
        content: codeLines.join("\n"),
        language,
        closed: true,
      });
      inFence = false;
      language = undefined;
      codeLines = [];
      continue;
    }
    if (inFence) {
      codeLines.push(line);
    } else {
      textLines.push(line);
    }
  }

  if (inFence) {
    blocks.push({
      type: "code",
      content: codeLines.join("\n"),
      language,
      closed: false,
    });
  } else {
    flushText();
  }

  return blocks.length > 0
    ? blocks
    : [{ type: "text", content, closed: true }];
}

export interface InlineToken {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
  /** Set for links; `text` holds the label. */
  url?: string;
}

// Order matters: longer/safer delimiters first. Underscore emphasis is
// deliberately NOT supported — snake_case identifiers are too common in
// coding output and false positives look worse than literal underscores.
const INLINE_PATTERN =
  /(`+)([^`]+?)\1|\*\*([^*\n]+?)\*\*|\*([^*\n]+?)\*|~~([^~\n]+?)~~|\[([^\]\n]+?)\]\(([^)\s]+?)\)/g;

/**
 * Tokenize a single line into styled inline spans.
 * Handles `code`, **bold**, *italic*, ~~strike~~, and [label](url).
 */
export function tokenizeInline(line: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let lastIndex = 0;

  INLINE_PATTERN.lastIndex = 0;
  for (
    let match = INLINE_PATTERN.exec(line);
    match !== null;
    match = INLINE_PATTERN.exec(line)
  ) {
    if (match.index > lastIndex) {
      tokens.push({ text: line.slice(lastIndex, match.index) });
    }
    if (match[2] !== undefined) {
      tokens.push({ text: match[2], code: true });
    } else if (match[3] !== undefined) {
      tokens.push({ text: match[3], bold: true });
    } else if (match[4] !== undefined) {
      tokens.push({ text: match[4], italic: true });
    } else if (match[5] !== undefined) {
      tokens.push({ text: match[5], strike: true });
    } else if (match[6] !== undefined) {
      tokens.push({ text: match[6], url: match[7] });
    }
    lastIndex = INLINE_PATTERN.lastIndex;
  }

  if (lastIndex < line.length) {
    tokens.push({ text: line.slice(lastIndex) });
  }

  return tokens.length > 0 ? tokens : [{ text: line }];
}

export type MarkdownLine =
  | { kind: "blank" }
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "bullet"; indent: string; marker: string; text: string }
  | { kind: "ordered"; indent: string; marker: string; text: string }
  | { kind: "quote"; text: string }
  | { kind: "hr" }
  | { kind: "plain"; text: string };

/**
 * Classify a single line of (non-code) markdown.
 * Preserves leading indentation for nested lists.
 */
export function classifyMarkdownLine(line: string): MarkdownLine {
  if (line.trim().length === 0) {
    return { kind: "blank" };
  }

  const headingMatch = /^(#{1,3})\s+(.*)$/.exec(line.trim());
  if (headingMatch) {
    return {
      kind: "heading",
      level: headingMatch[1].length as 1 | 2 | 3,
      text: headingMatch[2],
    };
  }

  if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
    return { kind: "hr" };
  }

  const quoteMatch = /^\s*>\s?(.*)$/.exec(line);
  if (quoteMatch) {
    return { kind: "quote", text: quoteMatch[1] };
  }

  const bulletMatch = /^(\s*)([-*+])\s+(.*)$/.exec(line);
  if (bulletMatch) {
    return {
      kind: "bullet",
      indent: bulletMatch[1],
      marker: "•",
      text: bulletMatch[3],
    };
  }

  const orderedMatch = /^(\s*)(\d+[.)])\s+(.*)$/.exec(line);
  if (orderedMatch) {
    return {
      kind: "ordered",
      indent: orderedMatch[1],
      marker: orderedMatch[2],
      text: orderedMatch[3],
    };
  }

  return { kind: "plain", text: line.trimEnd() };
}
