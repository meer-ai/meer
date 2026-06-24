import type { ChatMessage } from "@meer-ai/ai/base.js";
import type { AgentMessage } from "@meer-ai/agent/types.js";

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

  // The message history is canonical: the user's question is simply appended.
  // We no longer synthesize a "Recent Evidence" system block here — the tool
  // results it summarized are already present as `tool_result` messages, so
  // re-stating them was redundant (and, as a mid-conversation system message,
  // actively harmful on Anthropic-family backends). Any host-specific context
  // shaping now belongs behind the loop's `transformContext` seam.
  return [
    ...providerCompatibleHistory,
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
  if (["propose_edit", "write_file", "delete_file", "move_file", "create_directory", "format_code", "organize_imports", "fix_lint"].includes(name)) {
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
