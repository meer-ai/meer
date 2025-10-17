/**
 * Manual Agentic Loop - Provider-Agnostic Tool Calling
 *
 * This replaces LangChain's StructuredChatAgent which uses unreliable prompt-based tool calling.
 * Instead, we implement a clean agentic loop that:
 * 1. Calls the LLM with a system prompt describing available tools
 * 2. Parses tool calls from the response (XML-style tags or JSON)
 * 3. Executes tools and feeds results back to the LLM
 * 4. Repeats until the agent provides a final answer
 *
 * This approach is provider-agnostic and works reliably across all providers.
 */

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { HumanMessage, AIMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";

export interface ManualAgentConfig {
  llm: BaseChatModel;
  tools: StructuredToolInterface[];
  systemPrompt: string;
  maxIterations?: number;
  verbose?: boolean;
}

interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

interface AgentStep {
  action: ToolCall | null;
  observation: string | null;
}

export class ManualAgent {
  private llm: BaseChatModel;
  private tools: StructuredToolInterface[];
  private toolMap: Map<string, StructuredToolInterface>;
  private systemPrompt: string;
  private maxIterations: number;
  private verbose: boolean;

  constructor(config: ManualAgentConfig) {
    this.llm = config.llm;
    this.tools = config.tools;
    this.toolMap = new Map(config.tools.map(t => [t.name, t]));
    this.systemPrompt = config.systemPrompt;
    this.maxIterations = config.maxIterations ?? 6;
    this.verbose = config.verbose ?? false;
  }

  private formatToolsForPrompt(): string {
    const toolDescriptions = this.tools.map(tool => {
      const schemaStr = tool.schema ? JSON.stringify(tool.schema, null, 2) : '{}';
      return `## ${tool.name}\n${tool.description}\n\nInput schema:\n\`\`\`json\n${schemaStr}\n\`\`\``;
    }).join('\n\n');

    return `# Available Tools\n\n${toolDescriptions}\n\n` +
      `# Tool Calling Format\n\n` +
      `To use a tool, respond with XML-style tags:\n\n` +
      `<tool_call>\n` +
      `<tool_name>tool_name_here</tool_name>\n` +
      `<tool_input>\n` +
      `{\n` +
      `  "param1": "value1",\n` +
      `  "param2": "value2"\n` +
      `}\n` +
      `</tool_input>\n` +
      `</tool_call>\n\n` +
      `You can call multiple tools by using multiple <tool_call> blocks.\n\n` +
      `When you have enough information to provide a final answer, respond naturally without tool calls.`;
  }

  private parseToolCalls(text: string): ToolCall[] {
    const toolCalls: ToolCall[] = [];

    // Parse XML-style tool calls
    const toolCallRegex = /<tool_call>([\s\S]*?)<\/tool_call>/g;
    let match;

    while ((match = toolCallRegex.exec(text)) !== null) {
      const callContent = match[1];

      const nameMatch = callContent.match(/<tool_name>(.*?)<\/tool_name>/);
      const inputMatch = callContent.match(/<tool_input>([\s\S]*?)<\/tool_input>/);

      if (nameMatch && inputMatch) {
        const name = nameMatch[1].trim();
        let input: Record<string, unknown> = {};

        try {
          const inputStr = inputMatch[1].trim();
          input = JSON.parse(inputStr);
        } catch (e) {
          // If JSON parsing fails, try to extract simple key-value pairs
          input = { raw: inputMatch[1].trim() };
        }

        toolCalls.push({ name, input });
      }
    }

    // Fallback: Try to parse JSON-style tool calls (for models that prefer JSON)
    if (toolCalls.length === 0) {
      try {
        // Try to find JSON objects that look like tool calls
        const jsonMatch = text.match(/\{[\s\S]*?"action"[\s\S]*?:[\s\S]*?"([^"]+)"[\s\S]*?"action_input"[\s\S]*?:[\s\S]*?(\{[\s\S]*?\}|\[[\s\S]*?\]|\{[\s\S]*?\})[\s\S]*?\}/);
        if (jsonMatch) {
          const name = jsonMatch[1];
          const input = JSON.parse(jsonMatch[2]);
          toolCalls.push({ name, input: input as Record<string, unknown> });
        }
      } catch (e) {
        // Ignore parsing errors
      }
    }

    return toolCalls;
  }

  private async executeTool(toolCall: ToolCall): Promise<string> {
    const tool = this.toolMap.get(toolCall.name);

    if (!tool) {
      return `Error: Tool "${toolCall.name}" not found. Available tools: ${Array.from(this.toolMap.keys()).join(', ')}`;
    }

    try {
      if (this.verbose) {
        console.log(`\n🛠️  Executing tool: ${toolCall.name}`);
        console.log(`   Input: ${JSON.stringify(toolCall.input, null, 2)}`);
      }

      const result = await tool.call(toolCall.input);

      if (this.verbose) {
        const preview = typeof result === 'string' && result.length > 200
          ? result.slice(0, 200) + '...'
          : result;
        console.log(`   Result: ${preview}\n`);
      }

      return typeof result === 'string' ? result : JSON.stringify(result);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (this.verbose) {
        console.log(`   Error: ${errorMsg}\n`);
      }
      return `Error executing tool "${toolCall.name}": ${errorMsg}`;
    }
  }

  async invoke(input: {
    input: string;
    chat_history?: BaseMessage[];
  }): Promise<{ output: string }> {
    const messages: BaseMessage[] = [
      new SystemMessage(this.systemPrompt + '\n\n' + this.formatToolsForPrompt()),
      ...(input.chat_history || []),
      new HumanMessage(input.input)
    ];

    let iterationCount = 0;
    const steps: AgentStep[] = [];

    while (iterationCount < this.maxIterations) {
      iterationCount++;

      if (this.verbose) {
        console.log(`\n--- Iteration ${iterationCount}/${this.maxIterations} ---`);
      }

      // Call LLM
      const response = await this.llm.invoke(messages);
      const responseText = typeof response.content === 'string'
        ? response.content
        : JSON.stringify(response.content);

      // Parse tool calls
      const toolCalls = this.parseToolCalls(responseText);

      // If no tool calls, we have a final answer
      if (toolCalls.length === 0) {
        if (this.verbose) {
          console.log(`\n✅ Final answer received\n`);
        }
        return { output: responseText };
      }

      // Execute all tool calls
      const observations: string[] = [];
      for (const toolCall of toolCalls) {
        const observation = await this.executeTool(toolCall);
        observations.push(`Tool: ${toolCall.name}\nResult: ${observation}`);
        steps.push({ action: toolCall, observation });
      }

      // Add observations to message history
      messages.push(new AIMessage(responseText));
      messages.push(new HumanMessage(
        `Tool Results:\n\n${observations.join('\n\n')}\n\n` +
        `Based on these results, either:\n` +
        `1. Call more tools if you need additional information\n` +
        `2. Provide your final answer to the user`
      ));
    }

    // Max iterations reached
    const lastResponse = messages[messages.length - 2];
    const lastContent = typeof lastResponse?.content === 'string'
      ? lastResponse.content
      : 'Maximum iterations reached without final answer';

    return {
      output: `${lastContent}\n\n(Note: Reached maximum iteration limit of ${this.maxIterations})`
    };
  }
}
