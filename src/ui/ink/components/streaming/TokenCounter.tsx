/**
 * TokenCounter - Real-time token and cost tracking during streaming
 */

import React from 'react';
import { Box, Text } from 'ink';

export interface TokenCounterProps {
  inputTokens: number;
  outputTokens: number;
  cost?: number;
  showDelta?: boolean;
}

export const TokenCounter: React.FC<TokenCounterProps> = ({
  inputTokens,
  outputTokens,
  cost,
  showDelta = true,
}) => {
  const total = inputTokens + outputTokens;
  const delta = outputTokens;

  return (
    <Box justifyContent="space-between" marginTop={1}>
      <Box>
        <Text color="gray" dimColor>
          Tokens: {inputTokens.toLocaleString()} → {total.toLocaleString()}
        </Text>
        {showDelta && delta > 0 && (
          <Text color="yellow"> [+{delta.toLocaleString()}]</Text>
        )}
      </Box>
      {cost !== undefined && cost > 0 && (
        <Text color="gray" dimColor>
          Cost: ${cost.toFixed(4)}
        </Text>
      )}
    </Box>
  );
};

export default TokenCounter;
