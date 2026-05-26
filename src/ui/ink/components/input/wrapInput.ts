export interface WrappedInputLine {
  text: string;
  start: number;
  end: number;
  cursorColumn: number | null;
}

export interface WrappedInputView {
  lines: WrappedInputLine[];
  hiddenAbove: number;
  hiddenBelow: number;
  totalLines: number;
}

export function normalizePastedInput(input: string): string {
  return input
    .replace(/\x1b\[200~/g, "")
    .replace(/\x1b\[201~/g, "")
    .replace(/\x1b\[[IO]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

export function clampCursorOffset(value: string, cursorOffset: number): number {
  return Math.max(0, Math.min(cursorOffset, value.length));
}

export function insertAtCursor(
  value: string,
  cursorOffset: number,
  text: string
): { value: string; cursorOffset: number } {
  const offset = clampCursorOffset(value, cursorOffset);
  const normalized = normalizePastedInput(text);
  return {
    value: value.slice(0, offset) + normalized + value.slice(offset),
    cursorOffset: offset + normalized.length,
  };
}

export function deleteBeforeCursor(
  value: string,
  cursorOffset: number
): { value: string; cursorOffset: number } {
  const offset = clampCursorOffset(value, cursorOffset);
  if (offset === 0) {
    return { value, cursorOffset: offset };
  }

  return {
    value: value.slice(0, offset - 1) + value.slice(offset),
    cursorOffset: offset - 1,
  };
}

export function deleteAtCursor(
  value: string,
  cursorOffset: number
): { value: string; cursorOffset: number } {
  const offset = clampCursorOffset(value, cursorOffset);
  if (offset >= value.length) {
    return { value, cursorOffset: offset };
  }

  return {
    value: value.slice(0, offset) + value.slice(offset + 1),
    cursorOffset: offset,
  };
}

export function buildWrappedInputView(
  value: string,
  cursorOffset: number,
  width: number,
  maxVisibleLines: number
): WrappedInputView {
  const wrapWidth = Math.max(1, width);
  const cursor = clampCursorOffset(value, cursorOffset);
  const lines = wrapInput(value, wrapWidth);
  const cursorLineIndex = findCursorLine(lines, cursor);
  const visibleLimit = Math.max(1, maxVisibleLines);

  let start = 0;
  if (lines.length > visibleLimit) {
    start = Math.max(0, cursorLineIndex - visibleLimit + 1);
    start = Math.min(start, Math.max(0, lines.length - visibleLimit));
  }

  const visible = lines.slice(start, start + visibleLimit).map((line) => ({
    ...line,
    cursorColumn:
      cursor >= line.start && cursor <= line.end ? cursor - line.start : null,
  }));

  return {
    lines: visible,
    hiddenAbove: start,
    hiddenBelow: Math.max(0, lines.length - start - visible.length),
    totalLines: lines.length,
  };
}

function wrapInput(value: string, width: number): WrappedInputLine[] {
  if (value.length === 0) {
    return [{ text: "", start: 0, end: 0, cursorColumn: 0 }];
  }

  const lines: WrappedInputLine[] = [];
  let start = 0;
  let text = "";

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? "";

    if (char === "\n") {
      lines.push({ text, start, end: index, cursorColumn: null });
      start = index + 1;
      text = "";
      continue;
    }

    if (text.length >= width) {
      lines.push({ text, start, end: index, cursorColumn: null });
      start = index;
      text = "";
    }

    text += char;
  }

  lines.push({ text, start, end: value.length, cursorColumn: null });
  return lines;
}

function findCursorLine(lines: WrappedInputLine[], cursorOffset: number): number {
  const exact = lines.findIndex(
    (line) => cursorOffset >= line.start && cursorOffset <= line.end
  );
  if (exact >= 0) {
    return exact;
  }

  return Math.max(0, lines.length - 1);
}
