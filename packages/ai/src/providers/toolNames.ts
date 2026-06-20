import { createHash } from "crypto";
import type { AgentMessage, ToolDefinition } from "../base.js";

const MAX_PROVIDER_TOOL_NAME_LENGTH = 128;
const PROVIDER_TOOL_NAME_REGEX = /[^A-Za-z0-9_-]/g;

function hashToolName(name: string): string {
  return createHash("sha1").update(name).digest("hex").slice(0, 10);
}

function sanitizeToolName(name: string): string {
  const normalized = name.replace(PROVIDER_TOOL_NAME_REGEX, "_");
  const base = normalized.length > 0 ? normalized : "tool";
  const hash = hashToolName(name);
  const maxBaseLength =
    MAX_PROVIDER_TOOL_NAME_LENGTH - hash.length - 2;
  const truncated = base.slice(0, Math.max(1, maxBaseLength));
  return `${truncated}__${hash}`;
}

export interface ProviderToolNameRegistry {
  providerTools: ToolDefinition[];
  toProviderName(originalName: string): string;
  toOriginalName(providerName: string): string;
  convertAgentMessages(messages: AgentMessage[]): AgentMessage[];
}

export function createProviderToolNameRegistry(
  tools: ToolDefinition[]
): ProviderToolNameRegistry {
  const originalToProvider = new Map<string, string>();
  const providerToOriginal = new Map<string, string>();

  for (const tool of tools) {
    let providerName = sanitizeToolName(tool.name);
    let suffix = 1;
    while (
      providerToOriginal.has(providerName) &&
      providerToOriginal.get(providerName) !== tool.name
    ) {
      const collisionSuffix = `_${suffix}`;
      const baseMaxLength =
        MAX_PROVIDER_TOOL_NAME_LENGTH - collisionSuffix.length;
      providerName = `${sanitizeToolName(tool.name).slice(0, baseMaxLength)}${collisionSuffix}`;
      suffix += 1;
    }
    originalToProvider.set(tool.name, providerName);
    providerToOriginal.set(providerName, tool.name);
  }

  return {
    providerTools: tools.map((tool) => ({
      ...tool,
      name: originalToProvider.get(tool.name) ?? tool.name,
    })),
    toProviderName(originalName: string): string {
      return originalToProvider.get(originalName) ?? originalName;
    },
    toOriginalName(providerName: string): string {
      return providerToOriginal.get(providerName) ?? providerName;
    },
    convertAgentMessages(messages: AgentMessage[]): AgentMessage[] {
      return messages.map((message) => {
        if (message.role !== "assistant" || !message.toolCalls?.length) {
          return message;
        }

        return {
          ...message,
          toolCalls: message.toolCalls.map((toolCall) => ({
            ...toolCall,
            name: originalToProvider.get(toolCall.name) ?? toolCall.name,
          })),
        };
      });
    },
  };
}
