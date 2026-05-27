import React, { useEffect, useMemo, useState } from "react";
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
}

export const WrappedComposerInput: React.FC<WrappedComposerInputProps> = ({
  value,
  onChange,
  onSubmit,
  placeholder,
  disabled = false,
  maxVisibleLines = 5,
  rightReserve = 0,
}) => {
  const [cursorOffset, setCursorOffset] = useState(value.length);
  const { stdout } = useStdout();
  const terminalWidth = stdout?.columns || process.stdout.columns || 100;
  const inputWidth = Math.max(12, terminalWidth - rightReserve - 6);

  useEffect(() => {
    setCursorOffset((current) => clampCursorOffset(value, current));
  }, [value]);

  useInput(
    (input, key) => {
      if (disabled) return;

      if (key.ctrl && input === "a") {
        setCursorOffset(0);
        return;
      }

      if (key.ctrl && input === "e") {
        setCursorOffset(value.length);
        return;
      }

      if (key.ctrl && input === "u") {
        const next = value.slice(cursorOffset);
        onChange(next);
        setCursorOffset(0);
        return;
      }

      if (key.ctrl && input === "k") {
        onChange(value.slice(0, cursorOffset));
        return;
      }

      if (key.leftArrow) {
        setCursorOffset((current) => Math.max(0, current - 1));
        return;
      }

      if (key.rightArrow) {
        setCursorOffset((current) => Math.min(value.length, current + 1));
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
          ? deleteAtCursor(value, cursorOffset)
          : deleteBeforeCursor(value, cursorOffset);
        onChange(next.value);
        setCursorOffset(next.cursorOffset);
        return;
      }

      if (key.return) {
        if (key.shift || key.meta) {
          const next = insertAtCursor(value, cursorOffset, "\n");
          onChange(next.value);
          setCursorOffset(next.cursorOffset);
          return;
        }

        onSubmit();
        return;
      }

      if (key.ctrl || key.meta || input.length === 0) {
        return;
      }

      const normalized = normalizePastedInput(input);
      const next = insertAtCursor(value, cursorOffset, normalized);
      onChange(next.value);
      setCursorOffset(next.cursorOffset);
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
