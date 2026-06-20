import type { ChatMessage } from "../providers/base.js";
import type { AgentMessage } from "./core/types.js";

export function buildInitialConversationHistory(
  options?: string | { contextPrompt?: string; priorMessages?: ChatMessage[] }
): AgentMessage[] {
  const normalized =
    typeof options === "string" ? { contextPrompt: options } : options ?? {};
  const history: AgentMessage[] = [];

  if (normalized.contextPrompt?.trim()) {
    history.push({
      role: "user",
      content: `[Context from previous sessions]\n${normalized.contextPrompt}`,
      timestamp: Date.now(),
    });
  }

  if (normalized.priorMessages?.length) {
    for (const msg of normalized.priorMessages) {
      if (msg.role === "user" || msg.role === "assistant" || msg.role === "system") {
        history.push({
          role: msg.role,
          content: msg.content,
          timestamp: Date.now(),
        });
      }
    }
  }

  return history;
}

export function trimConversationHistory(
  history: AgentMessage[],
  maxMessages = 48
): AgentMessage[] {
  if (history.length <= maxMessages) {
    return [...history];
  }
  return history.slice(history.length - maxMessages);
}

export function prepareTurnInput(
  history: AgentMessage[],
  userMessage: string,
  providerType: string,
  model: string
): AgentMessage[] {
  const providerCompatibleHistory = buildProviderCompatibleHistory(
    history,
    providerType,
    model
  );
  const recentEvidenceSummary = buildRecentEvidenceSummary(history, userMessage);

  return [
    ...providerCompatibleHistory,
    ...(recentEvidenceSummary
      ? [
          {
            role: "system" as const,
            content: recentEvidenceSummary,
            timestamp: Date.now(),
          },
        ]
      : []),
    {
      role: "user" as const,
      content: userMessage,
      timestamp: Date.now(),
    },
  ];
}

export function describeInitialWorkflowStage(userMessage: string): string {
  const prompt = userMessage.toLowerCase();

  if (/\bsecurity\b|\baudit\b|\bvulnerab|\bscan\b/.test(prompt)) {
    return "Inspect project for security review";
  }
  if (/\btest\b|\bfail(?:ing|ed)?\b|\bbug\b|\berror\b/.test(prompt)) {
    return "Inspect failing area";
  }
  if (/\brefactor\b|\bedit\b|\bchange\b|\bimplement\b|\bfix\b/.test(prompt)) {
    return "Inspect code to change";
  }
  if (/\bexplain\b|\bunderstand\b|\bwhat is\b|\bcurrent project\b/.test(prompt)) {
    return "Inspect repository";
  }

  return "Inspect repository";
}

export function describeToolWorkflowStage(toolName: string): string {
  const name = toolName.toLowerCase();

  if (["analyze_project", "list_files", "find_files", "read_folder"].includes(name)) {
    return "Inspect repository layout";
  }
  if (["read_file", "read_many_files", "grep", "search_text", "semantic_search", "find_references", "get_file_outline", "find_symbol_definition", "explain_code"].includes(name)) {
    return "Inspect source code";
  }
  if (["dependency_audit", "package_list", "package_install"].includes(name)) {
    return "Audit dependencies";
  }
  if (["security_scan", "validate_project", "check_syntax", "code_review", "check_complexity", "detect_smells", "analyze_coverage", "run_tests"].includes(name)) {
    return "Scan project health";
  }
  if (["propose_edit", "edit_line", "write_file", "delete_file", "move_file", "create_directory", "format_code", "organize_imports", "fix_lint"].includes(name)) {
    return "Apply code changes";
  }
  if (name.startsWith("git_")) {
    return "Inspect git state";
  }
  if (["run_command", "package_run_script"].includes(name)) {
    return "Run project command";
  }

  return humanizeToolName(toolName);
}

export function buildRecentEvidenceSummary(
  history: AgentMessage[],
  userMessage: string
): string | null {
  if (history.length === 0) {
    return null;
  }

  const recentToolResults = history
    .filter(
      (message): message is Extract<AgentMessage, { role: "tool_result" }> =>
        message.role === "tool_result"
    )
    .slice(-4);

  // Only inject this block when the recent history actually involved tool
  // calls. Its entire purpose is to stop the model repeating broad inspection
  // tools and to nudge it toward turning gathered evidence into findings —
  // none of which applies to a plain conversational follow-up.
  //
  // It used to also re-feed the previous assistant answer here (a "Latest
  // assistant conclusions" section). That made a follow-up question look like a
  // continuation of the previous one — on Anthropic the mid-conversation system
  // message is replayed as a *user* message (see anthropic.ts), so the prior
  // answer landed right before the new question and the model would re-answer
  // the previous question first. The assistant reply is already present as a
  // proper assistant turn in the history, so restating it here is both
  // redundant and harmful; it has been removed.
  if (recentToolResults.length === 0) {
    return null;
  }

  const toolSummaryLines = recentToolResults.map((result) => {
    const preview = truncateForSummary(result.content, 220);
    const errorTag = result.isError ? " (error)" : "";
    return `- ${result.toolName}${errorTag}: ${preview}`;
  });

  const lowerUserMessage = userMessage.toLowerCase();
  const focusHint =
    /\bsecurity\b|\baudit\b|\breview\b|\bscan\b/.test(lowerUserMessage)
      ? "Focus on turning the gathered evidence into concrete findings and only gather more context if a specific gap remains."
      : /\bfix\b|\bedit\b|\bchange\b|\bimplement\b|\brefactor\b/.test(
            lowerUserMessage
          )
        ? "Use the gathered evidence to make the smallest coherent change, then verify it."
        : "Use the gathered evidence to choose the next most specific action instead of repeating broad inspection tools.";

  const sections: string[] = [
    "## Recent Evidence",
    "Use this as a compact memory of the latest verified context. Do not repeat the same broad tool calls unless the latest evidence clearly requires it.",
    "Latest tool results:",
    toolSummaryLines.join("\n"),
    `Next-step guidance: ${focusHint}`,
  ];

  return sections.join("\n\n");
}

export function buildProviderCompatibleHistory(
  history: AgentMessage[],
  providerType: string,
  model: string
): AgentMessage[] {
  if (!requiresReasoningReplayCompatibility(providerType, model)) {
    return history;
  }

  return history.map((message) => {
    if (
      message.role === "assistant" &&
      !message.reasoningContent &&
      !message.toolCalls?.length
    ) {
      return {
        role: "system" as const,
        content: `Previous assistant response:\n${message.content}`,
        timestamp: message.timestamp,
      };
    }
    return message;
  });
}

function requiresReasoningReplayCompatibility(
  providerType: string,
  model: string
): boolean {
  const provider = providerType.toLowerCase();
  const normalizedModel = model.toLowerCase();
  return (
    (provider.includes("opencode") || provider.includes("openai")) &&
    normalizedModel.includes("deepseek")
  );
}

function humanizeToolName(toolName: string): string {
  return toolName
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function truncateForSummary(content: string, maxLength: number): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}
