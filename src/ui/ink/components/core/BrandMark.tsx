import React from "react";
import { Box, Text } from "ink";

export interface BrandMarkProps {
  provider?: string;
  model?: string;
  cwd?: string;
  version?: string;
}

const WAVE_ROWS: Array<Array<{ text: string; color: string }>> = [
  [
    { text: "        ", color: "#0B1020" },
    { text: "▄▄", color: "#B8F7FF" },
    { text: "      ", color: "#0B1020" },
    { text: "▄▄", color: "#6EE7F9" },
  ],
  [
    { text: "     ", color: "#0B1020" },
    { text: "▄████▄", color: "#67E8F9" },
    { text: "  ", color: "#0B1020" },
    { text: "▄████▄", color: "#2DD4BF" },
  ],
  [
    { text: "   ", color: "#0B1020" },
    { text: "▄██", color: "#22D3EE" },
    { text: "▀  ▀", color: "#155E75" },
    { text: "████", color: "#06B6D4" },
    { text: "▀  ▀", color: "#164E63" },
    { text: "██▄", color: "#0EA5E9" },
  ],
  [
    { text: " ", color: "#0B1020" },
    { text: "██", color: "#0891B2" },
    { text: "▀      ", color: "#0E7490" },
    { text: "▀▀", color: "#075985" },
    { text: "      ▀", color: "#0369A1" },
    { text: "██", color: "#2563EB" },
  ],
  [
    { text: "   ", color: "#0B1020" },
    { text: "≈≈≈", color: "#38BDF8" },
    { text: "   ", color: "#0B1020" },
    { text: "≈≈≈≈≈", color: "#0EA5E9" },
    { text: "   ", color: "#0B1020" },
    { text: "≈≈≈", color: "#1D4ED8" },
  ],
];

export const BrandMark: React.FC<BrandMarkProps> = React.memo(({
  provider,
  model,
  cwd,
  version,
}) => {
  const providerModel = [provider, model].filter(Boolean).join("/");
  const cwdLabel = basenamePath(cwd);

  return (
    <Box alignItems="center" justifyContent="center" paddingY={2}>
      <Box flexDirection="row" gap={4}>
        <Box flexDirection="column">
          {WAVE_ROWS.map((row, rowIndex) => (
            <Box key={rowIndex}>
              {row.map((part, partIndex) => (
                <Text key={`${rowIndex}-${partIndex}`} color={part.color}>
                  {part.text}
                </Text>
              ))}
            </Box>
          ))}
        </Box>
        <Box flexDirection="column" justifyContent="center">
          <Box gap={1}>
            <Text color="#67E8F9" bold>Meer</Text>
            <Text color="#2DD4BF" bold>CLI</Text>
            {version ? <Text color="#64748B">{version}</Text> : null}
          </Box>
          <Text color="#94A3B8">oceanic coding agent</Text>
          {providerModel ? <Text color="#64748B">{providerModel}</Text> : null}
          {cwdLabel ? <Text color="#64748B">{cwdLabel}</Text> : null}
        </Box>
      </Box>
    </Box>
  );
});

function basenamePath(value?: string): string {
  if (!value) return "";
  const normalized = value.replace(/\/+$/, "");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || normalized;
}

export default BrandMark;
