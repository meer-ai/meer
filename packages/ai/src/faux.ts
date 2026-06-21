/**
 * Faux provider — a scripted, deterministic {@link Provider} for tests.
 *
 * Real providers make network calls and behave nondeterministically, which is
 * why meer's agent paths were historically tested by shelling out to real
 * binaries (slow, and broken on Windows). The faux provider replaces that: you
 * hand it a queue of turns and it replays them as `ProviderEvent`s, so an agent
 * loop or session can be driven end-to-end with zero I/O.
 *
 * It also records every `streamWithTools` invocation in {@link calls}, so a test
 * can assert on exactly what message list reached the model — the assertion that
 * pins conversation-history regressions (e.g. a previous answer being re-fed
 * before the next question).
 *
 * This lives in `src/providers/` for now; it moves into `@meer-ai/ai` when the
 * provider layer is extracted (see docs/ARCHITECTURE.md).
 */

import type {
  AgentMessage,
  ChatMessage,
  ChatOptions,
  Provider,
  ProviderEvent,
  ProviderMetadata,
  ProviderToolCall,
  ProviderUsage,
  ToolDefinition,
} from "./base.js";

/** One scripted assistant turn the faux provider will replay. */
export interface FauxTurn {
  /** Assistant text, streamed as small deltas to mimic real streaming. */
  text?: string;
  /** Reasoning/thinking content surfaced via the `done` event. */
  reasoning?: string;
  /** Tool calls emitted this turn (the loop will execute them and re-enter). */
  toolCalls?: ProviderToolCall[];
  /** Token usage reported for this turn. */
  usage?: ProviderUsage;
}

/** Split text into a few chunks so streaming consumers see more than one delta. */
function chunkText(text: string, parts = 3): string[] {
  if (!text) return [];
  if (text.length <= parts) return [text];
  const size = Math.ceil(text.length / parts);
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

export class FauxProvider implements Provider {
  private readonly queue: FauxTurn[];
  /**
   * Snapshot of the message list passed to every `streamWithTools` call, in
   * order. Tests assert on this to verify what actually reached the model.
   */
  readonly calls: AgentMessage[][] = [];

  constructor(turns: FauxTurn[] = []) {
    this.queue = [...turns];
  }

  /** Queue additional turns after construction. */
  enqueue(...turns: FauxTurn[]): void {
    this.queue.push(...turns);
  }

  /** Next scripted turn, or an empty turn once the script is exhausted. */
  private take(): FauxTurn {
    return this.queue.shift() ?? {};
  }

  async chat(_messages: ChatMessage[], _options?: ChatOptions): Promise<string> {
    return this.take().text ?? "";
  }

  async *stream(
    _messages: ChatMessage[],
    _options?: ChatOptions
  ): AsyncIterable<string> {
    const turn = this.take();
    for (const chunk of chunkText(turn.text ?? "")) {
      yield chunk;
    }
  }

  async metadata(): Promise<ProviderMetadata> {
    return { name: "faux", capabilities: ["streamWithTools"] };
  }

  async *streamWithTools(
    messages: AgentMessage[],
    _tools: ToolDefinition[],
    signal?: AbortSignal
  ): AsyncIterable<ProviderEvent> {
    // Deep-enough snapshot for assertions without holding references to the
    // caller's mutable array.
    this.calls.push(messages.map((message) => ({ ...message })));

    const turn = this.take();
    const text = turn.text ?? "";

    for (const chunk of chunkText(text)) {
      if (signal?.aborted) return;
      yield { type: "text-delta", text: chunk };
    }

    for (const toolCall of turn.toolCalls ?? []) {
      if (signal?.aborted) return;
      yield { type: "tool-call", toolCall };
    }

    yield {
      type: "done",
      rawText: text,
      turn: {
        assistantMessage: text,
        toolCalls: turn.toolCalls ?? [],
        rawText: text,
        reasoningContent: turn.reasoning,
      },
      reasoningContent: turn.reasoning,
      usage: turn.usage,
    };
  }
}

export default FauxProvider;
