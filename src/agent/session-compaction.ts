import type { Provider, ChatMessage } from "../providers/base.js";
import type { CompactionSummaryInput } from "../session/store.js";

export async function generateCompactionSummaryWithProvider(
  provider: Provider,
  input: CompactionSummaryInput
): Promise<string> {
  const fallback = buildFallbackCompactionSummary(input);
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "You are generating a durable session compaction summary for a coding agent.",
        "Return only markdown.",
        "Use exactly these sections and keep them concise:",
        "## Task State",
        "## Findings",
        "## Files Touched",
        "## Next Steps",
        "Rules:",
        "- Preserve unresolved work and concrete evidence.",
        "- Mention file paths when they were edited, inspected, or discussed materially.",
        "- Mention security findings, bugs, failures, approvals, and user intent changes.",
        "- Do not invent files or results.",
        "- If a section has nothing material, write '- None yet.'",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "Create a structured summary for the compacted conversation.",
        "",
        "Previous summary:",
        input.previousSummary?.trim() || "None",
        "",
        "Messages to summarize:",
        formatMessagesForSummary(input.messagesToSummarize) || "None",
        "",
        "Recent kept messages for immediate context:",
        formatMessagesForSummary(input.keptMessages.slice(-6)) || "None",
      ].join("\n"),
    },
  ];

  try {
    const response = await provider.chat(messages, {
      temperature: 0.1,
      maxTokens: 700,
    });
    const summary = response.trim();
    return summary || fallback;
  } catch {
    return fallback;
  }
}

export function buildFallbackCompactionSummary(
  input: CompactionSummaryInput
): string {
  const files = new Set<string>();
  const findings: string[] = [];
  const nextSteps: string[] = [];
  const recentUserIntents: string[] = [];

  const filePattern =
    /\b(?:src|app|lib|tests?|docs|scripts|packages|components|pages|memory|session|agent|ui|providers|mcp|chat|commands|tools|slash|telemetry|context|plan|search|token|auth|pricing|lsp|utils|config)\/[A-Za-z0-9._/-]+\b/g;

  for (const message of input.messagesToSummarize) {
    for (const match of message.content.matchAll(filePattern)) {
      files.add(match[0]);
    }

    if (message.role === "user") {
      recentUserIntents.push(message.content.trim());
    }

    const lower = message.content.toLowerCase();
    if (
      lower.includes("error") ||
      lower.includes("failed") ||
      lower.includes("warning") ||
      lower.includes("issue") ||
      lower.includes("verified") ||
      lower.includes("fixed")
    ) {
      findings.push(message.content.trim());
    }
  }

  let latestKeptUserIntent: string | undefined;
  for (let index = input.keptMessages.length - 1; index >= 0; index--) {
    const message = input.keptMessages[index];
    if (message?.role === "user") {
      latestKeptUserIntent = message.content;
      break;
    }
  }

  const latestUserIntent =
    recentUserIntents[recentUserIntents.length - 1] ||
    latestKeptUserIntent ||
    "Continue the current task.";

  const recentAssistant =
    input.keptMessages
      .filter((message) => message.role === "assistant")
      .slice(-2)
      .map((message) => message.content.trim()) ?? [];

  if (recentAssistant.length > 0) {
    nextSteps.push(...recentAssistant);
  } else {
    nextSteps.push(latestUserIntent);
  }

  const taskStateParts: string[] = [];
  if (input.previousSummary?.trim()) {
    taskStateParts.push("Previous summary context preserved.");
    taskStateParts.push(`Prior summary: ${input.previousSummary.trim()}`);
  }
  taskStateParts.push(
    `Summarized ${input.messagesToSummarize.length} messages and kept ${input.keptMessages.length} recent messages active.`
  );
  taskStateParts.push(`Latest user direction: ${latestUserIntent}`);

  const uniqueFindings = [...new Set(findings)].slice(-5);
  const uniqueNextSteps = [...new Set(nextSteps)].slice(-4);
  const touchedFiles = [...files].slice(0, 12);

  return [
    "## Task State",
    ...taskStateParts.map((line) => `- ${line}`),
    "",
    "## Findings",
    ...(uniqueFindings.length > 0
      ? uniqueFindings.map((line) => `- ${line}`)
      : ["- None yet."]),
    "",
    "## Files Touched",
    ...(touchedFiles.length > 0
      ? touchedFiles.map((file) => `- ${file}`)
      : ["- None yet."]),
    "",
    "## Next Steps",
    ...(uniqueNextSteps.length > 0
      ? uniqueNextSteps.map((line) => `- ${line}`)
      : ["- Continue from the latest active user request."]),
  ].join("\n");
}

function formatMessagesForSummary(
  messages: Array<{
    role: string;
    content: string;
    metadata?: {
      toolName?: string;
      queueAction?: "queued" | "delivered";
      queueMode?: "steer" | "followUp";
      summaryKind?: "branch_summary" | "compaction";
    };
  }>
): string {
  return messages
    .map((message) => {
      const meta: string[] = [];
      if (message.metadata?.toolName) {
        meta.push(`tool=${message.metadata.toolName}`);
      }
      if (message.metadata?.queueAction) {
        meta.push(`queue=${message.metadata.queueAction}:${message.metadata.queueMode}`);
      }
      if (message.metadata?.summaryKind) {
        meta.push(`summary=${message.metadata.summaryKind}`);
      }
      const metaText = meta.length > 0 ? ` [${meta.join(", ")}]` : "";
      return `${message.role}${metaText}: ${message.content}`;
    })
    .join("\n\n");
}
