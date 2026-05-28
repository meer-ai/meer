/**
 * Render error boundary for the work log.
 *
 * Ink doesn't ship error boundaries by default — a throw inside ANY render
 * function in the tree takes down the whole chat session. That's not
 * acceptable for a CLI users rely on for long-running work: a single
 * malformed tool result shouldn't lose your in-progress conversation.
 *
 * This component catches render-time errors below it, reports them via
 * `onError` (so the diagnostics ring buffer can capture them), and falls
 * back to a small "(render failed)" placeholder. The rest of the chat
 * continues running.
 *
 * NOTE: React error boundaries only catch errors during render, lifecycle
 * methods, and constructors. They DO NOT catch:
 *   - errors thrown inside async callbacks (setTimeout, promises, useInput)
 *   - errors in event handlers
 *   - errors during server-side rendering
 * Those still need plain try/catch at the call site. The boundary covers
 * the most common production crash class — bad data flowing into a
 * component prop.
 */

import React from "react";
import { Box, Text } from "ink";

interface ErrorBoundaryProps {
  /** Human-readable label that shows up in the fallback ("render failed: <label>"). */
  label: string;
  /** Reported once per unique error message. The boundary itself does not log. */
  onError?: (error: Error, info: { componentStack?: string }) => void;
  children?: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class RenderErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }): void {
    this.props.onError?.(error, info);
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    // Reset the boundary when the label changes — e.g. a different
    // message id flows in. Without this, a single bad row in the
    // transcript would permanently break that slot.
    if (prevProps.label !== this.props.label && this.state.error) {
      this.setState({ error: null });
    }
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <Box paddingX={1} marginBottom={1}>
          <Text color="red" dimColor>
            (render failed: {this.props.label} — {summarizeMessage(this.state.error.message)})
          </Text>
        </Box>
      );
    }
    return this.props.children as React.ReactNode;
  }
}

function summarizeMessage(message: string): string {
  const cleaned = message.replace(/\s+/g, " ").trim();
  return cleaned.length > 120 ? `${cleaned.slice(0, 117)}…` : cleaned;
}
