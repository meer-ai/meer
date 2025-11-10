/**
 * StreamingResponse - Real-time response feedback with token tracking
 */

import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { TokenCounter } from './TokenCounter.js';

export interface StreamingResponseProps {
  content: string;
  isStreaming: boolean;
  inputTokens: number;
  outputTokens: number;
  cost?: number;
  elapsed?: number;
}

export const StreamingResponse: React.FC<StreamingResponseProps> = ({
  content,
  isStreaming,
  inputTokens,
  outputTokens,
  cost,
  elapsed,
}) => {
  const [dots, setDots] = useState(0);

  useEffect(() => {
    if (!isStreaming) return;

    const interval = setInterval(() => {
      setDots((prev) => (prev + 1) % 4);
    }, 300);

    return () => clearInterval(interval);
  }, [isStreaming]);

  return (
    <Box flexDirection="column">
      {/* Streaming indicator */}
      {isStreaming && (
        <Box marginBottom={1}>
          <Text color="yellow">
            <Spinner type="dots" />
          </Text>
          <Text color="yellow">
            {' '}Generating{'.'.repeat(dots)}
          </Text>
          {elapsed !== undefined && (
            <Text color="gray" dimColor> ({elapsed.toFixed(1)}s)</Text>
          )}
        </Box>
      )}

      {/* Content */}
      {content && (
        <Box>
          <Text>{content}</Text>
        </Box>
      )}

      {/* Token counter - shown during and after streaming */}
      {(isStreaming || outputTokens > 0) && (
        <TokenCounter
          inputTokens={inputTokens}
          outputTokens={outputTokens}
          cost={cost}
          showDelta={isStreaming}
        />
      )}
    </Box>
  );
};

export default StreamingResponse;
