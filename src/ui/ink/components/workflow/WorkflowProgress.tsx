/**
 * WorkflowProgress - Visual workflow stages and progress tracking
 */

import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { ProgressBar } from '../shared/ProgressBar.js';

export interface WorkflowStage {
  name: string;
  status: 'pending' | 'running' | 'complete' | 'error';
  startTime?: number;
  endTime?: number;
}

export interface WorkflowProgressProps {
  stages: WorkflowStage[];
  currentIteration?: number;
  maxIterations?: number;
}

export const WorkflowProgress: React.FC<WorkflowProgressProps> = ({
  stages,
  currentIteration,
  maxIterations,
}) => {
  const getStageIcon = (status: WorkflowStage['status']) => {
    switch (status) {
      case 'pending':
        return '⏸';
      case 'running':
        return '⏳';
      case 'complete':
        return '✓';
      case 'error':
        return '✗';
    }
  };

  const getStageColor = (status: WorkflowStage['status']): string => {
    switch (status) {
      case 'running':
        return 'yellow';
      case 'complete':
        return 'green';
      case 'error':
        return 'red';
      default:
        return 'gray';
    }
  };

  const getDuration = (stage: WorkflowStage): string => {
    if (!stage.startTime || !stage.endTime) return '';
    const duration = stage.endTime - stage.startTime;
    if (duration < 1000) {
      return `${duration}ms`;
    }
    return `${(duration / 1000).toFixed(2)}s`;
  };

  const completedStages = stages.filter(s => s.status === 'complete').length;
  const progress = stages.length > 0 ? (completedStages / stages.length) * 100 : 0;

  if (stages.length === 0) return null;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="blue"
      paddingX={1}
      marginY={1}
    >
      <Box justifyContent="space-between">
        <Box>
          <Text color="blue" bold>🔄 Workflow Progress</Text>
        </Box>
        {currentIteration !== undefined && maxIterations !== undefined && (
          <Text color="gray">
            Iteration {currentIteration}/{maxIterations}
          </Text>
        )}
      </Box>

      {/* Progress bar */}
      {stages.length > 0 && (
        <Box marginY={1}>
          <ProgressBar value={progress} width={50} color="blue" />
        </Box>
      )}

      {/* Stages */}
      <Box flexDirection="column">
        {stages.map((stage, idx) => (
          <Box key={idx} justifyContent="space-between">
            <Box>
              {stage.status === 'running' ? (
                <Text color={getStageColor(stage.status)}>
                  <Spinner type="dots" /> {stage.name}
                </Text>
              ) : (
                <Text color={getStageColor(stage.status)}>
                  {getStageIcon(stage.status)} {stage.name}
                </Text>
              )}
            </Box>
            {stage.endTime && stage.startTime && (
              <Text color="gray" dimColor>
                {getDuration(stage)}
              </Text>
            )}
          </Box>
        ))}
      </Box>

      <Box marginTop={1}>
        <Text color="gray" dimColor>
          {completedStages}/{stages.length} stages complete
        </Text>
      </Box>
    </Box>
  );
};

export default WorkflowProgress;
