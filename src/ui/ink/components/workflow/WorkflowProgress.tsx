/**
 * WorkflowProgress - Agent workflow visualization with progress tracking
 * Shows overall progress, task breakdown, iteration count, and ETAs
 */

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { ProgressBar } from '../shared/ProgressBar.js';

export interface WorkflowStage {
    id?: string;
    name: string;
    status: 'pending' | 'running' | 'success' | 'error' | 'skipped' | 'complete';
    startTime?: number;
    endTime?: number;
}

export interface WorkflowProgressProps {
    stages: WorkflowStage[];
    currentIteration?: number;
    maxIterations?: number;
    startTime?: number;
    collapsed?: boolean;
    compact?: boolean;
}

export const WorkflowProgress: React.FC<WorkflowProgressProps> = React.memo(({
    stages,
    currentIteration = 1,
    maxIterations,
    startTime,
    collapsed = false,
    compact = false,
}) => {
    const [elapsed, setElapsed] = useState(0);

    // Update elapsed time
    useEffect(() => {
        if (!startTime) return;

        const interval = setInterval(() => {
            setElapsed(Date.now() - startTime);
        }, 1000);

        return () => clearInterval(interval);
    }, [startTime]);

    const completedStages = stages.filter(s => s.status === 'success' || s.status === 'skipped' || s.status === 'complete').length;
    const failedStages = stages.filter(s => s.status === 'error').length;
    const runningStages = stages.filter(s => s.status === 'running').length;
    const progressPercent = stages.length > 0 ? (completedStages / stages.length) * 100 : 0;

    const getIcon = (status: WorkflowStage['status']) => {
        switch (status) {
            case 'pending': return '○';
            case 'running': return '◉';
            case 'success': return '✓';
            case 'complete': return '✓';
            case 'error': return '✗';
            case 'skipped': return '⊘';
        }
    };

    const getColor = (status: WorkflowStage['status']): string => {
        switch (status) {
            case 'running': return 'cyan';
            case 'success': return 'green';
            case 'complete': return 'green';
            case 'error': return 'red';
            case 'skipped': return 'yellow';
            default: return 'dim';
        }
    };

    const formatDuration = (ms: number): string => {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;

        if (minutes > 0) {
            return `${minutes}m ${remainingSeconds}s`;
        }
        return `${seconds}s`;
    };

    const estimateRemaining = (): string => {
        if (completedStages === 0 || elapsed === 0) return '';

        const avgTimePerStage = elapsed / completedStages;
        const remainingStages = stages.length - completedStages;
        const estimatedRemaining = avgTimePerStage * remainingStages;

        if (estimatedRemaining < 1000) return 'almost done';
        return `~${formatDuration(estimatedRemaining)} remaining`;
    };

    if (stages.length === 0) return null;

    const activeStage =
        [...stages].reverse().find((stage) => stage.status === 'running') ??
        [...stages].reverse().find((stage) => stage.status === 'pending') ??
        stages[stages.length - 1];

    if (compact) {
        return (
            <Box flexDirection="column" marginY={1} paddingLeft={2}>
                <Box gap={1}>
                    <Text color="blue" bold>Workflow</Text>
                    <Text color="dim">
                        Turn {currentIteration}{maxIterations ? `/${maxIterations}` : ''}
                    </Text>
                    {runningStages > 0 && (
                        <Text color="cyan">
                            <Spinner type="dots" />
                        </Text>
                    )}
                </Box>
                <Box gap={1}>
                    <Text color={getColor(activeStage.status)}>
                        {activeStage.status === 'running' ? '◉' : getIcon(activeStage.status)}
                    </Text>
                    <Text color={getColor(activeStage.status)} dimColor={activeStage.status === 'pending'}>
                        {activeStage.name}
                    </Text>
                    <Text color="dim">
                        {completedStages} done · {failedStages} failed · {stages.length - completedStages - failedStages} pending
                    </Text>
                    {elapsed > 0 && <Text color="dim">{formatDuration(elapsed)}</Text>}
                </Box>
            </Box>
        );
    }

    // Collapsed view
    if (collapsed) {
        return (
            <Box paddingX={1} gap={2}>
                <Text color="cyan">Workflow:</Text>
                <Text color="dim">{completedStages}/{stages.length}</Text>
                <ProgressBar value={progressPercent} width={15} color="cyan" showPercentage={false} />
                {failedStages > 0 && <Text color="red">{failedStages} failed</Text>}
            </Box>
        );
    }

    return (
        <Box
            flexDirection="column"
            borderStyle="round"
            borderColor="blue"
            paddingX={1}
            paddingY={0}
            marginY={1}
        >
            {/* Header */}
            <Box justifyContent="space-between" paddingY={0}>
                <Box gap={1}>
                    <Text color="blue" bold>📊 Workflow Progress</Text>
                    {runningStages > 0 && (
                        <Text color="cyan">
                            <Spinner type="dots" />
                        </Text>
                    )}
                </Box>
                <Box gap={2}>
                    <Text color="dim">
                        Turn {currentIteration}{maxIterations ? `/${maxIterations}` : ''}
                    </Text>
                    {elapsed > 0 && (
                        <Text color="dim">{formatDuration(elapsed)}</Text>
                    )}
                </Box>
            </Box>

            {/* Progress bar */}
            <Box marginTop={1} flexDirection="column">
                <ProgressBar
                    value={progressPercent}
                    width={40}
                    color={failedStages > 0 ? 'yellow' : progressPercent === 100 ? 'green' : 'blue'}
                    showPercentage={true}
                />
            </Box>

            {/* Stage list */}
            <Box flexDirection="column" marginTop={1} gap={0}>
                {stages.map((stage, idx) => {
                    const showConnector = idx < stages.length - 1;

                    return (
                        <React.Fragment key={stage.id ?? `${stage.name}-${idx}`}>
                            <Box justifyContent="space-between">
                                <Box gap={1}>
                                    {stage.status === 'running' ? (
                                        <>
                                            <Text color={getColor(stage.status)}>
                                                <Spinner type="dots" />
                                            </Text>
                                            <Text color={getColor(stage.status)} bold>
                                                {stage.name}
                                            </Text>
                                        </>
                                    ) : (
                                        <>
                                            <Text color={getColor(stage.status)}>
                                                {getIcon(stage.status)}
                                            </Text>
                                            <Text color={getColor(stage.status)} dimColor={stage.status === 'pending'}>
                                                {stage.name}
                                            </Text>
                                        </>
                                    )}
                                </Box>
                                {stage.startTime && stage.endTime && (
                                    <Text color="dim" dimColor>
                                        {formatDuration(stage.endTime - stage.startTime)}
                                    </Text>
                                )}
                            </Box>

                            {showConnector && (
                                <Box paddingLeft={0}>
                                    <Text color={stage.status === 'success' ? 'green' : stage.status === 'error' ? 'red' : 'dim'}>
                                        │
                                    </Text>
                                </Box>
                            )}
                        </React.Fragment>
                    );
                })}
            </Box>

            {/* Footer with ETA */}
            <Box marginTop={1} justifyContent="space-between">
                <Text color="dim">
                    {completedStages} completed · {failedStages} failed · {stages.length - completedStages - failedStages} pending
                </Text>
                {estimateRemaining() && (
                    <Text color="yellow">{estimateRemaining()}</Text>
                )}
            </Box>

            {/* All done message */}
            {progressPercent === 100 && failedStages === 0 && (
                <Box marginTop={1}>
                    <Text color="green" bold>✨ Workflow completed successfully</Text>
                </Box>
            )}
        </Box>
    );
});

export default WorkflowProgress;
