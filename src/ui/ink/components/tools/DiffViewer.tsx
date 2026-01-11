/**
 * DiffViewer - Enhanced diff display with line numbers, navigation, and actions
 * Professional diff viewing experience matching production CLIs
 */

import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';

export interface DiffHunk {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: DiffLine[];
}

export interface DiffLine {
    type: 'context' | 'add' | 'remove';
    content: string;
    oldLineNumber?: number;
    newLineNumber?: number;
}

export interface DiffViewerProps {
    filePath: string;
    hunks: DiffHunk[];
    onAccept?: () => void;
    onReject?: () => void;
    onAcceptHunk?: (hunkIndex: number) => void;
    onRejectHunk?: (hunkIndex: number) => void;
    showActions?: boolean;
}

export const DiffViewer: React.FC<DiffViewerProps> = React.memo(({
    filePath,
    hunks,
    onAccept,
    onReject,
    onAcceptHunk,
    onRejectHunk,
    showActions = true,
}) => {
    const [currentHunk, setCurrentHunk] = useState(0);
    const [viewMode, setViewMode] = useState<'unified' | 'split'>('unified');
    const [expanded, setExpanded] = useState(true);

    const navigateHunk = useCallback((delta: number) => {
        setCurrentHunk(prev => {
            const next = prev + delta;
            return Math.max(0, Math.min(hunks.length - 1, next));
        });
    }, [hunks.length]);

    useInput((input, key) => {
        if (key.upArrow || input === 'k') {
            navigateHunk(-1);
        }
        if (key.downArrow || input === 'j') {
            navigateHunk(1);
        }
        if (input === 'a' && onAccept) {
            onAccept();
        }
        if (input === 'r' && onReject) {
            onReject();
        }
        if (input === 'v') {
            setViewMode(prev => prev === 'unified' ? 'split' : 'unified');
        }
        if (input === 'e' || input === ' ') {
            setExpanded(prev => !prev);
        }
        if (input === 'y' && onAcceptHunk) {
            onAcceptHunk(currentHunk);
        }
        if (input === 'n' && onRejectHunk) {
            onRejectHunk(currentHunk);
        }
    });

    const getLineColor = (type: DiffLine['type']): string => {
        switch (type) {
            case 'add': return 'green';
            case 'remove': return 'red';
            default: return 'dim';
        }
    };

    const getLinePrefix = (type: DiffLine['type']): string => {
        switch (type) {
            case 'add': return '+';
            case 'remove': return '-';
            default: return ' ';
        }
    };

    const formatLineNumber = (num: number | undefined, width: number = 4): string => {
        if (num === undefined) return ' '.repeat(width);
        return num.toString().padStart(width, ' ');
    };

    const addedLines = hunks.reduce((sum, h) =>
        sum + h.lines.filter(l => l.type === 'add').length, 0);
    const removedLines = hunks.reduce((sum, h) =>
        sum + h.lines.filter(l => l.type === 'remove').length, 0);

    if (hunks.length === 0) return null;

    const hunk = hunks[currentHunk];

    return (
        <Box
            flexDirection="column"
            borderStyle="round"
            borderColor="yellow"
            paddingX={1}
            paddingY={0}
            marginY={1}
        >
            {/* Header */}
            <Box justifyContent="space-between" paddingY={0}>
                <Box gap={1}>
                    <Text color="yellow" bold>📝 {filePath}</Text>
                    <Text color="green">+{addedLines}</Text>
                    <Text color="red">-{removedLines}</Text>
                </Box>
                <Box gap={1}>
                    <Text color="dim">
                        Hunk {currentHunk + 1}/{hunks.length}
                    </Text>
                    <Text color="dim">({viewMode})</Text>
                </Box>
            </Box>

            {/* Hunk header */}
            {expanded && hunk && (
                <Box marginTop={1}>
                    <Text color="cyan">
                        @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
                    </Text>
                </Box>
            )}

            {/* Diff content */}
            {expanded && hunk && (
                <Box flexDirection="column" marginTop={1}>
                    {viewMode === 'unified' ? (
                        // Unified view
                        hunk.lines.map((line, idx) => (
                            <Box key={idx}>
                                <Text color="dim" dimColor>
                                    {formatLineNumber(line.oldLineNumber)}
                                </Text>
                                <Text color="dim" dimColor> </Text>
                                <Text color="dim" dimColor>
                                    {formatLineNumber(line.newLineNumber)}
                                </Text>
                                <Text color={getLineColor(line.type)}>
                                    {' '}{getLinePrefix(line.type)} {line.content}
                                </Text>
                            </Box>
                        ))
                    ) : (
                        // Split view - side by side
                        <Box>
                            <Box flexDirection="column" width="50%">
                                {hunk.lines.filter(l => l.type !== 'add').map((line, idx) => (
                                    <Box key={idx}>
                                        <Text color="dim" dimColor>
                                            {formatLineNumber(line.oldLineNumber)}
                                        </Text>
                                        <Text color={line.type === 'remove' ? 'red' : 'dim'}>
                                            {' '}{line.content}
                                        </Text>
                                    </Box>
                                ))}
                            </Box>
                            <Text color="dim">│</Text>
                            <Box flexDirection="column" width="50%">
                                {hunk.lines.filter(l => l.type !== 'remove').map((line, idx) => (
                                    <Box key={idx}>
                                        <Text color="dim" dimColor>
                                            {formatLineNumber(line.newLineNumber)}
                                        </Text>
                                        <Text color={line.type === 'add' ? 'green' : 'dim'}>
                                            {' '}{line.content}
                                        </Text>
                                    </Box>
                                ))}
                            </Box>
                        </Box>
                    )}
                </Box>
            )}

            {/* Collapsed indicator */}
            {!expanded && (
                <Box marginTop={1}>
                    <Text color="dim" italic>
                        {hunks.reduce((sum, h) => sum + h.lines.length, 0)} lines hidden. Press space to expand.
                    </Text>
                </Box>
            )}

            {/* Actions */}
            {showActions && (
                <Box marginTop={1} borderStyle="single" borderColor="dim" paddingX={1}>
                    <Text color="dim">
                        <Text color="green" bold>a</Text>
                        <Text color="dim">ccept </Text>
                        <Text color="red" bold>r</Text>
                        <Text color="dim">eject </Text>
                        <Text color="yellow" bold>v</Text>
                        <Text color="dim">iew </Text>
                        <Text color="cyan" bold>↑↓</Text>
                        <Text color="dim"> navigate </Text>
                        <Text color="blue" bold>space</Text>
                        <Text color="dim"> toggle</Text>
                    </Text>
                </Box>
            )}
        </Box>
    );
});

// Helper function to parse diff output into hunks
export function parseDiff(diffOutput: string): DiffHunk[] {
    const hunks: DiffHunk[] = [];
    const lines = diffOutput.split('\n');

    let currentHunk: DiffHunk | null = null;
    let oldLineNum = 0;
    let newLineNum = 0;

    for (const line of lines) {
        // Parse hunk header: @@ -start,count +start,count @@
        const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
        if (hunkMatch) {
            if (currentHunk) {
                hunks.push(currentHunk);
            }
            oldLineNum = parseInt(hunkMatch[1], 10);
            newLineNum = parseInt(hunkMatch[3], 10);
            currentHunk = {
                oldStart: oldLineNum,
                oldLines: parseInt(hunkMatch[2] || '1', 10),
                newStart: newLineNum,
                newLines: parseInt(hunkMatch[4] || '1', 10),
                lines: [],
            };
            continue;
        }

        if (!currentHunk) continue;

        if (line.startsWith('+') && !line.startsWith('+++')) {
            currentHunk.lines.push({
                type: 'add',
                content: line.slice(1),
                newLineNumber: newLineNum++,
            });
        } else if (line.startsWith('-') && !line.startsWith('---')) {
            currentHunk.lines.push({
                type: 'remove',
                content: line.slice(1),
                oldLineNumber: oldLineNum++,
            });
        } else if (line.startsWith(' ') || line === '') {
            currentHunk.lines.push({
                type: 'context',
                content: line.slice(1) || '',
                oldLineNumber: oldLineNum++,
                newLineNumber: newLineNum++,
            });
        }
    }

    if (currentHunk) {
        hunks.push(currentHunk);
    }

    return hunks;
}

export default DiffViewer;
