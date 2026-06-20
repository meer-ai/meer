/**
 * Bounded accumulator for streaming command output.
 *
 * Inspired by the pi coding agent's OutputAccumulator (MIT, © 2025 Mario
 * Zechner, https://github.com/badlogic/pi), adapted for meer's runCommand.
 *
 * Keeps only a rolling tail in memory while preserving the complete output in
 * a lazily-created temp file once the in-memory cap is exceeded. This stops a
 * runaway command (build logs, watch mode, accidental binary dump) from
 * growing process memory without bound.
 */

import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface BoundedOutputBufferOptions {
  /** Max bytes kept in memory before spilling to a temp file (default 1MB) */
  maxTailBytes?: number;
  /** Prefix for the spill temp file name */
  tempFilePrefix?: string;
}

const DEFAULT_MAX_TAIL_BYTES = 1024 * 1024; // 1MB

export class BoundedOutputBuffer {
  private readonly maxTailBytes: number;
  private readonly tempFilePrefix: string;

  private tail = "";
  private tailBytes = 0;
  private totalBytesCount = 0;
  private totalNewlines = 0;
  private endsWithNewline = true;
  private spilled = false;
  private tempFilePath: string | undefined;
  private tempFileStream: WriteStream | undefined;

  constructor(options: BoundedOutputBufferOptions = {}) {
    this.maxTailBytes = options.maxTailBytes ?? DEFAULT_MAX_TAIL_BYTES;
    this.tempFilePrefix = options.tempFilePrefix ?? "meer-output";
  }

  append(text: string): void {
    if (text.length === 0) return;

    const bytes = Buffer.byteLength(text, "utf-8");
    this.totalBytesCount += bytes;
    for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
      this.totalNewlines++;
    }
    this.endsWithNewline = text.endsWith("\n");

    // Once spilled, every new chunk goes straight to the file. The spill file
    // is seeded with the full tail at creation time, so writing the current
    // chunk here AND seeding would duplicate it — hence write-before-append.
    if (this.spilled) {
      this.tempFileStream?.write(text);
    }

    this.tail += text;
    this.tailBytes += bytes;

    if (this.tailBytes > this.maxTailBytes) {
      if (!this.spilled) {
        // Preserve the full output on disk before trimming memory.
        this.ensureSpillFile();
      }
      this.trimTail();
    }
  }

  /**
   * Rolling tail of the output, trimmed to start at a line boundary.
   * This is the complete output when nothing has been trimmed yet.
   */
  get tailText(): string {
    return this.tail;
  }

  /** Whether any output has been received */
  get isEmpty(): boolean {
    return this.totalBytesCount === 0;
  }

  /** Total bytes received (not just what's in memory) */
  get totalBytes(): number {
    return this.totalBytesCount;
  }

  /** Total lines received (counting a trailing partial line) */
  get totalLines(): number {
    if (this.totalBytesCount === 0) return 0;
    return this.totalNewlines + (this.endsWithNewline ? 0 : 1);
  }

  /** Whether the in-memory tail no longer contains the full output */
  get isTrimmed(): boolean {
    return this.spilled;
  }

  /** Path of the spill file containing the complete output, if one was created */
  get fullOutputPath(): string | undefined {
    return this.tempFilePath;
  }

  /** Flush and close the spill file stream, if open. Safe to call multiple times. */
  close(): Promise<void> {
    const stream = this.tempFileStream;
    if (!stream) return Promise.resolve();
    this.tempFileStream = undefined;
    return new Promise((resolve) => {
      stream.end(() => resolve());
    });
  }

  private ensureSpillFile(): void {
    if (this.spilled) return;
    this.spilled = true;
    const id = randomBytes(8).toString("hex");
    this.tempFilePath = join(tmpdir(), `${this.tempFilePrefix}-${id}.log`);
    this.tempFileStream = createWriteStream(this.tempFilePath);
    // Everything received so far is still in the tail — write it out so the
    // spill file holds the complete output from byte 0.
    this.tempFileStream.write(this.tail);
  }

  private trimTail(): void {
    const buffer = Buffer.from(this.tail, "utf-8");
    if (buffer.length <= this.maxTailBytes) {
      this.tailBytes = buffer.length;
      return;
    }

    let start = buffer.length - this.maxTailBytes;
    // Respect UTF-8 character boundaries
    while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
      start++;
    }

    let trimmed = buffer.subarray(start).toString("utf-8");
    // Drop the leading partial line so the tail starts at a line boundary
    const firstNewline = trimmed.indexOf("\n");
    if (firstNewline !== -1 && firstNewline < trimmed.length - 1) {
      trimmed = trimmed.slice(firstNewline + 1);
    }

    this.tail = trimmed;
    this.tailBytes = Buffer.byteLength(trimmed, "utf-8");
  }
}
