import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import {
  buildWrappedInputView,
  clampCursorOffset,
  deleteAtCursor,
  deleteBeforeCursor,
  insertAtCursor,
  normalizePastedInput,
} from "./wrapInput.js";

interface WrappedComposerInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  disabled?: boolean;
  maxVisibleLines?: number;
  rightReserve?: number;
  /**
   * Fired when the user presses Ctrl+V. Parent should attempt to read an
   * image from the clipboard and call back with attachment metadata. If
   * `onPasteImage` returns false (or is omitted), the keystroke falls
   * through to normal text-paste behavior so users don't lose the existing
   * Cmd+V text-paste flow.
   */
  onPasteImage?: () => boolean | Promise<boolean>;
}

export const WrappedComposerInput: React.FC<WrappedComposerInputProps> = ({
  value,
  onChange,
  onSubmit,
  placeholder,
  disabled = false,
  maxVisibleLines = 5,
  rightReserve = 0,
  onPasteImage,
}) => {
  const [cursorOffset, setCursorOffset] = useState(value.length);
  const { stdout } = useStdout();
  const terminalWidth = stdout?.columns || process.stdout.columns || 100;
  const inputWidth = Math.max(12, terminalWidth - rightReserve - 6);

  // Refs that always hold the latest in-flight value/cursor. Stdin events can
  // fire faster than React commits the parent's setInput, so reading `value`
  // straight from the closure causes consecutive events (e.g. held-down
  // Backspace) to see a stale string and collapse into a single deletion.
  // We mirror every change into refs so the next handler in the same tick
  // sees what the previous handler just produced.
  const valueRef = useRef(value);
  const cursorRef = useRef(cursorOffset);
  const onChangeRef = useRef(onChange);
  const onSubmitRef = useRef(onSubmit);
  const onPasteImageRef = useRef(onPasteImage);

  useEffect(() => {
    valueRef.current = value;
    cursorRef.current = clampCursorOffset(value, cursorRef.current);
    setCursorOffset(cursorRef.current);
  }, [value]);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onSubmitRef.current = onSubmit;
  }, [onSubmit]);

  useEffect(() => {
    onPasteImageRef.current = onPasteImage;
  }, [onPasteImage]);

  const commitValue = (nextValue: string, nextCursor: number) => {
    valueRef.current = nextValue;
    cursorRef.current = nextCursor;
    onChangeRef.current(nextValue);
    setCursorOffset(nextCursor);
  };

  const commitCursor = (nextCursor: number) => {
    cursorRef.current = nextCursor;
    setCursorOffset(nextCursor);
  };

  useInput(
    (input, key) => {
      if (disabled) return;
      const currentValue = valueRef.current;
      const currentCursor = cursorRef.current;

      // Ctrl+V → try to paste an image from the clipboard. If the parent
      // says no image was found (or no handler is wired), fall through so
      // the keystroke can still produce a literal `v` or trigger the
      // terminal's text-paste under Cmd+V on macOS.
      if (key.ctrl && input === "v" && onPasteImageRef.current) {
        const result = onPasteImageRef.current();
        if (result instanceof Promise) {
          // Fire-and-forget the async handler; we can't await inside the
          // useInput callback. The parent is responsible for inserting the
          // path token via onChange when its read finishes.
          void result;
          return;
        }
        if (result) {
          return;
        }
        // Handler said "no image" — fall through to other Ctrl+V handlers.
      }

      if (key.ctrl && input === "a") {
        commitCursor(0);
        return;
      }

      if (key.ctrl && input === "e") {
        commitCursor(currentValue.length);
        return;
      }

      if (key.ctrl && input === "u") {
        const next = currentValue.slice(currentCursor);
        commitValue(next, 0);
        return;
      }

      if (key.ctrl && input === "k") {
        commitValue(currentValue.slice(0, currentCursor), currentCursor);
        return;
      }

      if (key.leftArrow) {
        commitCursor(Math.max(0, currentCursor - 1));
        return;
      }

      if (key.rightArrow) {
        commitCursor(Math.min(currentValue.length, currentCursor + 1));
        return;
      }

      const keyName = String((key as { name?: string }).name ?? "").toLowerCase();
      const singleCharCode = input.length === 1 ? input.charCodeAt(0) : undefined;
      const isRawBackspace =
        keyName === "backspace" ||
        singleCharCode === 8 ||
        singleCharCode === 127 ||
        input === "\x7f" ||
        input === "\b";
      const isRawDelete =
        keyName === "delete" ||
        input === "\x1b[3~" ||
        input.startsWith("\x1b[3");
      if (key.backspace || key.delete || isRawBackspace || isRawDelete) {
        // Ink reports the common terminal Backspace byte (0x7f) as
        // `key.delete`, with an empty input string. Treat it as Backspace
        // unless we can positively identify a forward-delete escape sequence.
        const shouldDeleteAtCursor = isRawDelete && input.length > 0;
        const next = shouldDeleteAtCursor
          ? deleteAtCursor(currentValue, currentCursor)
          : deleteBeforeCursor(currentValue, currentCursor);
        if (next.value === currentValue && next.cursorOffset === currentCursor) {
          return;
        }
        commitValue(next.value, next.cursorOffset);
        return;
      }

      if (key.return) {
        if (key.shift || key.meta) {
          const next = insertAtCursor(currentValue, currentCursor, "\n");
          commitValue(next.value, next.cursorOffset);
          return;
        }

        onSubmitRef.current();
        return;
      }

      if (key.ctrl || key.meta || input.length === 0) {
        return;
      }

      const normalized = normalizePastedInput(input);
      const next = insertAtCursor(currentValue, currentCursor, normalized);
      commitValue(next.value, next.cursorOffset);
    },
    { isActive: !disabled }
  );

  const view = useMemo(
    () => buildWrappedInputView(value, cursorOffset, inputWidth, maxVisibleLines),
    [cursorOffset, inputWidth, maxVisibleLines, value]
  );

  if (disabled) {
    return (
      <Text color="white" dimColor>
        {placeholder}
      </Text>
    );
  }

  const isPasteLike = value.includes("\n") || view.totalLines > 1;

  return (
    <Box flexDirection="column" flexGrow={1}>
      {view.hiddenAbove > 0 ? (
        <Text color="white" dimColor>
          ... {view.hiddenAbove} earlier input line{view.hiddenAbove === 1 ? "" : "s"}
        </Text>
      ) : null}
      {value.length === 0 ? (
        <Box>
          <Text inverse color="white"> </Text>
          <Text color="white" dimColor>
            {placeholder}
          </Text>
        </Box>
      ) : (
        view.lines.map((line, index) => (
          <ComposerLine
            key={`${line.start}:${line.end}:${index}`}
            text={line.text}
            cursorColumn={line.cursorColumn}
          />
        ))
      )}
      {view.hiddenBelow > 0 ? (
        <Text color="white" dimColor>
          ... {view.hiddenBelow} more input line{view.hiddenBelow === 1 ? "" : "s"}
        </Text>
      ) : null}
      {isPasteLike ? (
        <Text color="white" dimColor>
          {view.totalLines} wrapped line{view.totalLines === 1 ? "" : "s"}
        </Text>
      ) : null}
    </Box>
  );
};

const ComposerLine: React.FC<{ text: string; cursorColumn: number | null }> = ({
  text,
  cursorColumn,
}) => {
  if (cursorColumn === null) {
    return (
      <Text color="white">
        {text.length > 0 ? text : " "}
      </Text>
    );
  }

  const before = text.slice(0, cursorColumn);
  const cursorChar = text[cursorColumn] ?? " ";
  const after = text.slice(cursorColumn + (text[cursorColumn] ? 1 : 0));

  return (
    <Box>
      <Text color="white">{before}</Text>
      <Text inverse color="white">{cursorChar}</Text>
      <Text color="white">{after}</Text>
    </Box>
  );
};
