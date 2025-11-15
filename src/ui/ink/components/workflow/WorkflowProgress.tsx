/**
 * WorkflowProgress - Visual workflow stages and progress tracking
 * Enhanced with better animations, visual hierarchy, and timeline connectors
 */

import React, { useState, useEffect } from 'react';
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
  const [elapsedTime, setElapsedTime] = useState(0);

  // Update elapsed time for running stages
  useEffect(() => {
    const runningStage = stages.find(s => s.status === 'running');
    if (!runningStage?.startTime) return;

    const interval = setInterval(() => {
      setElapsedTime(Date.now() - runningStage.startTime!);
    }, 100);

    return () => clearInterval(interval);
  }, [stages]);

  const getStageIcon = (status: WorkflowStage['status'], isActive: boolean) => {
    switch (status) {
      case 'pending':
        return '○';
      case 'running':
        return isActive ? '◉' : '◉';
      case 'complete':
        return '✓';
      case 'error':
        return '✗';
    }
  };

  const getStageColor = (status: WorkflowStage['status']): string => {
    switch (status) {
      case 'running':
        return 'cyan';
      case 'complete':
        return 'green';
      case 'error':
        return 'red';
      default:
        return 'dim';
    }
  };

  const getConnectorColor = (prevStatus: WorkflowStage['status'], currentStatus: WorkflowStage['status']): string => {
    if (prevStatus === 'complete') return 'green';
    if (prevStatus === 'error') return 'red';
    if (prevStatus === 'running') return 'cyan';
    return 'dim';
  };

  const formatDuration = (ms: number): string => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  };

  const getDuration = (stage: WorkflowStage): string => {
    if (stage.status === 'running' && stage.startTime) {
      return formatDuration(Date.now() - stage.startTime);
    }
    if (!stage.startTime || !stage.endTime) return '';
    return formatDuration(stage.endTime - stage.startTime);
  };

  const getEstimatedTimeRemaining = (): string | null => {
    const completed = stages.filter(s => s.status === 'complete');
    if (completed.length === 0) return null;

    const totalCompletedTime = completed.reduce((sum, s) => {
      if (s.startTime && s.endTime) return sum + (s.endTime - s.startTime);
      return sum;
    }, 0);

    const avgTime = totalCompletedTime / completed.length;
    const remaining = stages.length - completed.length;
    const estimated = avgTime * remaining;

    return formatDuration(estimated);
  };

  const completedStages = stages.filter(s => s.status === 'complete').length;
  const errorStages = stages.filter(s => s.status === 'error').length;
  const progress = stages.length > 0 ? (completedStages / stages.length) * 100 : 0;
  const estimatedRemaining = getEstimatedTimeRemaining();

  if (stages.length === 0) return null;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      paddingY={0}
      marginY={1}
    >
      {/* Header */}
      <Box justifyContent="space-between" paddingY={0}>
        <Box gap={1}>
          <Text color="cyan" bold>⚡ Workflow</Text>
          {currentIteration !== undefined && maxIterations !== undefined && (
            <Text color="dim">
              [Iteration {currentIteration}/{maxIterations}]
            </Text>
          )}
        </Box>
        <Box gap={1}>
          {estimatedRemaining && (
            <Text color="dim">
              ~{estimatedRemaining} left
            </Text>
          )}
        </Box>
      </Box>

      {/* Progress bar with percentage */}
      {stages.length > 0 && (
        <Box marginTop={0} marginBottom={1} flexDirection="column">
          <ProgressBar
            value={progress}
            width={60}
            color={errorStages > 0 ? 'red' : 'cyan'}
          />
        </Box>
      )}

      {/* Stages with timeline connectors */}
      <Box flexDirection="column" gap={0}>
        {stages.map((stage: WorkflowStage, idx: number) => {
          const isRunning = stage.status === 'running';
          const isLast = idx === stages.length - 1;
          const showConnector = !isLast;

          return (
            <React.Fragment key={idx}>
              <Box justifyContent="space-between">
                <Box gap={1}>
                  {isRunning ? (
                    <>
                      <Text color={getStageColor(stage.status)}>
                        <Spinner type="dots" />
                      </Text>
                      <Text color={getStageColor(stage.status)} bold>
                        {stage.name}
                      </Text>
                    </>
                  ) : (
                    <>
                      <Text color={getStageColor(stage.status)}>
                        {getStageIcon(stage.status, false)}
                      </Text>
                      <Text
                        color={getStageColor(stage.status)}
                        dimColor={stage.status === 'pending'}
                      >
                        {stage.name}
                      </Text>
                    </>
                  )}
                </Box>
                <Text color={isRunning ? 'cyan' : 'dim'} dimColor={!isRunning}>
                  {getDuration(stage) || (stage.status === 'pending' ? 'pending' : '')}
                </Text>
              </Box>

              {/* Timeline connector */}
              {showConnector && (
                <Box paddingLeft={0}>
                  <Text color={getConnectorColor(stage.status, stages[idx + 1].status)}>
                    │
                  </Text>
                </Box>
              )}
            </React.Fragment>
          );
        })}
      </Box>

      {/* Footer stats */}
      <Box marginTop={1} justifyContent="space-between">
        <Text color="dim">
          {completedStages}/{stages.length} complete
          {errorStages > 0 && ` · ${errorStages} failed`}
        </Text>
        {progress === 100 && errorStages === 0 && (
          <Text color="green">
            ✨ All done!
          </Text>
        )}
      </Box>
    </Box>
  );
};

export default WorkflowProgress;
