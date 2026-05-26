export interface ErrorContext {
  source: "provider" | "tool" | "network" | "system";
  name: string;
  operation?: string;
  target?: string;
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const parts = [error.message];
    const cause = error.cause;
    if (cause instanceof Error && cause.message && cause.message !== error.message) {
      parts.push(`cause: ${cause.message}`);
    } else if (typeof cause === "string" && cause && cause !== error.message) {
      parts.push(`cause: ${cause}`);
    }
    return parts.join(" · ");
  }

  return String(error);
}

export function formatErrorWithContext(error: unknown, context: ErrorContext): string {
  const headerParts = [
    context.source,
    context.name,
    context.operation,
  ].filter(Boolean);
  const target = context.target ? `\nTarget: ${context.target}` : "";
  return `${headerParts.join(" ")} failed${target}\nReason: ${describeError(error)}`;
}

export function contextualError(error: unknown, context: ErrorContext): Error {
  const message = formatErrorWithContext(error, context);
  return new Error(message, { cause: error instanceof Error ? error : undefined });
}
