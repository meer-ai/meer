/**
 * Robust text-edit engine for targeted file edits.
 *
 * Ported from the pi coding agent's edit-diff module (MIT, © 2025 Mario Zechner,
 * https://github.com/badlogic/pi) and adapted for meer.
 *
 * Handles the failure modes that break naive `content.includes(oldText)` matching:
 * - CRLF vs LF line endings (everything is matched in LF space, original endings restored on write)
 * - UTF-8 BOM (stripped before matching, restored on write)
 * - Trailing whitespace, smart quotes, Unicode dashes/spaces (progressive fuzzy matching)
 * - Multiple edits in one call (matched against the original content, applied in reverse offset order)
 */

export interface TextEdit {
  oldText: string;
  newText: string;
}

export interface AppliedTextEdits {
  /** Raw original file content (as read from disk) */
  oldContent: string;
  /** New file content with original BOM and line endings restored — write this to disk */
  newContent: string;
  /** Whether any edit needed fuzzy (normalized) matching instead of an exact match */
  usedFuzzyMatch: boolean;
}

export function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1) return "\n";
  if (crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/** Strip UTF-8 BOM if present, return both the BOM (if any) and the text without it */
export function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content };
}

/**
 * Normalize text for fuzzy matching. Applies progressive transformations:
 * - Strip trailing whitespace from each line
 * - Normalize smart quotes to ASCII equivalents
 * - Normalize Unicode dashes/hyphens to ASCII hyphen
 * - Normalize special Unicode spaces to regular space
 */
export function normalizeForFuzzyMatch(text: string): string {
  return (
    text
      .normalize("NFKC")
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      // Smart single quotes → '
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      // Smart double quotes → "
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
      // Various dashes/hyphens → -
      .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
      // Special spaces → regular space
      .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
  );
}

export interface FuzzyMatchResult {
  found: boolean;
  index: number;
  matchLength: number;
  usedFuzzyMatch: boolean;
  /** Content space the match index refers to (original, or fuzzy-normalized when fuzzy matched) */
  contentForReplacement: string;
}

/**
 * Find oldText in content, trying exact match first, then fuzzy match.
 */
export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) {
    return {
      found: true,
      index: exactIndex,
      matchLength: oldText.length,
      usedFuzzyMatch: false,
      contentForReplacement: content,
    };
  }

  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);

  if (fuzzyIndex === -1) {
    return {
      found: false,
      index: -1,
      matchLength: 0,
      usedFuzzyMatch: false,
      contentForReplacement: content,
    };
  }

  // When fuzzy matching, the replacement happens in normalized space. The output
  // gets normalized whitespace/quotes/dashes, which is acceptable since we're
  // already fixing minor formatting differences.
  return {
    found: true,
    index: fuzzyIndex,
    matchLength: fuzzyOldText.length,
    usedFuzzyMatch: true,
    contentForReplacement: fuzzyContent,
  };
}

function countOccurrences(content: string, oldText: string): number {
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  return fuzzyContent.split(fuzzyOldText).length - 1;
}

function notFoundError(path: string, editIndex: number, totalEdits: number): Error {
  if (totalEdits === 1) {
    return new Error(
      `Could not find the exact text in ${path}. The oldText must match exactly including all whitespace and newlines. Use read_file to get the current content before editing.`
    );
  }
  return new Error(
    `Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`
  );
}

function duplicateError(
  path: string,
  editIndex: number,
  totalEdits: number,
  occurrences: number
): Error {
  if (totalEdits === 1) {
    return new Error(
      `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Provide more surrounding context to make it unique.`
    );
  }
  return new Error(
    `Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Provide more surrounding context to make it unique.`
  );
}

interface MatchedEdit {
  editIndex: number;
  matchIndex: number;
  matchLength: number;
  newText: string;
}

/**
 * Apply one or more exact-text replacements to LF-normalized content.
 *
 * All edits are matched against the same original content. Replacements are
 * then applied in reverse offset order so indices remain stable. If any edit
 * needs fuzzy matching, the whole operation runs in fuzzy-normalized space.
 */
export function applyEditsToNormalizedContent(
  normalizedContent: string,
  edits: TextEdit[],
  path: string
): { baseContent: string; newContent: string; usedFuzzyMatch: boolean } {
  const normalizedEdits = edits.map((edit) => ({
    oldText: normalizeToLF(edit.oldText),
    newText: normalizeToLF(edit.newText),
  }));

  for (let i = 0; i < normalizedEdits.length; i++) {
    if (normalizedEdits[i].oldText.length === 0) {
      throw new Error(
        normalizedEdits.length === 1
          ? `oldText must not be empty in ${path}.`
          : `edits[${i}].oldText must not be empty in ${path}.`
      );
    }
  }

  const initialMatches = normalizedEdits.map((edit) =>
    fuzzyFindText(normalizedContent, edit.oldText)
  );
  const usedFuzzyMatch = initialMatches.some((match) => match.usedFuzzyMatch);
  const baseContent = usedFuzzyMatch
    ? normalizeForFuzzyMatch(normalizedContent)
    : normalizedContent;

  const matchedEdits: MatchedEdit[] = [];
  for (let i = 0; i < normalizedEdits.length; i++) {
    const edit = normalizedEdits[i];
    const matchResult = fuzzyFindText(baseContent, edit.oldText);
    if (!matchResult.found) {
      throw notFoundError(path, i, normalizedEdits.length);
    }

    const occurrences = countOccurrences(baseContent, edit.oldText);
    if (occurrences > 1) {
      throw duplicateError(path, i, normalizedEdits.length, occurrences);
    }

    matchedEdits.push({
      editIndex: i,
      matchIndex: matchResult.index,
      matchLength: matchResult.matchLength,
      newText: edit.newText,
    });
  }

  matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = 1; i < matchedEdits.length; i++) {
    const previous = matchedEdits[i - 1];
    const current = matchedEdits[i];
    if (previous.matchIndex + previous.matchLength > current.matchIndex) {
      throw new Error(
        `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`
      );
    }
  }

  let newContent = baseContent;
  for (let i = matchedEdits.length - 1; i >= 0; i--) {
    const edit = matchedEdits[i];
    newContent =
      newContent.substring(0, edit.matchIndex) +
      edit.newText +
      newContent.substring(edit.matchIndex + edit.matchLength);
  }

  if (baseContent === newContent) {
    throw new Error(
      `No changes made to ${path}. The replacement produced identical content. The newText may already be present, or oldText and newText are the same.`
    );
  }

  return { baseContent, newContent, usedFuzzyMatch };
}

/**
 * Apply edits to raw file content (as read from disk).
 * Handles BOM and line-ending round-tripping so the written file keeps its
 * original encoding conventions.
 */
export function applyTextEdits(
  rawContent: string,
  edits: TextEdit[],
  path: string
): AppliedTextEdits {
  const { bom, text } = stripBom(rawContent);
  const lineEnding = detectLineEnding(text);
  const normalizedContent = normalizeToLF(text);

  const { newContent, usedFuzzyMatch } = applyEditsToNormalizedContent(
    normalizedContent,
    edits,
    path
  );

  return {
    oldContent: rawContent,
    newContent: bom + restoreLineEndings(newContent, lineEnding),
    usedFuzzyMatch,
  };
}
