/**
 * The `meer run` headless event protocol — single source of truth.
 *
 * This JSONL stream (emitted on stdout by `meer run --json`) is a LIVE
 * integration contract with multiple consumers, the most important being
 * meer-code's provider adapter (`apps/server/.../MeerAdapter.ts`), which
 * switches on each event's `type` and reads the fields named below. The
 * meer-api cloud agent consumes the plain-text stream instead, so it is
 * unaffected by this module — but the JSON shape here must stay stable.
 *
 * RULES (locked by scripts/verify-run-protocol.ts):
 *   - Never rename a `type` or a field that a consumer reads.
 *   - Adding a new optional field, or a brand-new event `type`, is safe:
 *     consumers ignore unknown events and unknown fields.
 *   - Bump RUN_PROTOCOL_VERSION only for a breaking change, and coordinate
 *     it with meer-code / meer-api before shipping.
 *
 * The version is stamped on `run.started` so a consumer can detect the
 * protocol revision from the first line of the stream.
 */

export const RUN_PROTOCOL_VERSION = 1;

/** Optional metadata a tool attaches to its result line. */
export interface RunToolMetadata {
  readonly isError?: boolean;
  readonly toolCallId?: string;
  readonly details?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

/**
 * Every event the headless runner can emit. The field names are the contract —
 * see the consumer notes in the file header before changing any of them.
 */
export type RunEvent =
  | {
      type: "run.started";
      protocolVersion: number;
      provider?: string;
      model?: string;
      cwd?: string;
      maxSteps?: number;
    }
  | { type: "run.error"; message: string }
  | { type: "run.completed"; exitCode: number }
  | { type: "assistant.started" }
  | { type: "assistant.delta"; delta: string }
  | { type: "assistant.completed" }
  | { type: "assistant.message"; content: string }
  | { type: "reasoning.message"; content: string }
  | { type: "tool.started"; tool: string; args?: unknown }
  | { type: "tool.message"; tool: string; result?: string; metadata?: RunToolMetadata };

export interface RunEventEmitter {
  /** Serialize one event as a single NDJSON line (timestamp-stamped). */
  emit(event: RunEvent): void;
}

/**
 * Build an emitter over an arbitrary sink. Production passes
 * `process.stdout.write`; tests pass a capturing function. Each event is
 * written as `{"timestamp": <iso>, ...event}\n`, matching the wire format the
 * existing consumers already parse.
 */
export function createRunEventEmitter(write: (chunk: string) => void): RunEventEmitter {
  return {
    emit(event: RunEvent): void {
      write(`${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`);
    },
  };
}
