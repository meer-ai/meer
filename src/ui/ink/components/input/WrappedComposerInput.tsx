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

      if (key.backspace || key.delete) {
        const next = key.delete
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
      <Text color="black" dimColor>
        {placeholder}
      </Text>
    );
  }

  const isPasteLike = value.includes("\n") || view.totalLines > 1;

  return (
    <Box flexDirection="column" flexGrow={1}>
      {view.hiddenAbove > 0 ? (
        <Text color="black" dimColor>
          ... {view.hiddenAbove} earlier input line{view.hiddenAbove === 1 ? "" : "s"}
        </Text>
      ) : null}
      {value.length === 0 ? (
        <Box>
          <Text inverse color="white"> </Text>
          <Text color="black" dimColor>
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
        <Text color="black" dimColor>
          ... {view.hiddenBelow} more input line{view.hiddenBelow === 1 ? "" : "s"}
        </Text>
      ) : null}
      {isPasteLike ? (
        <Text color="black" dimColor>
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
      <Text color="black">
        {text.length > 0 ? text : " "}
      </Text>
    );
  }

  const before = text.slice(0, cursorColumn);
  const cursorChar = text[cursorColumn] ?? " ";
  const after = text.slice(cursorColumn + (text[cursorColumn] ? 1 : 0));

  return (
    <Box>
      <Text color="black">{before}</Text>
      <Text inverse color="white">{cursorChar}</Text>
      <Text color="black">{after}</Text>
    </Box>
  );
};
