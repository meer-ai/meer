import { clearLine, cursorTo, Interface, moveCursor } from "readline";

export type LineChangeSource = "user" | "programmatic";

export interface LineState {
  buffer: string;
  cursor: number;
}

export interface LineChangeEvent {
  state: LineState;
  previous: LineState;
  source: LineChangeSource;
  data?: Buffer | string | null;
}

type LineChangeListener = (event: LineChangeEvent) => void;

export class LineEditor {
  private static readonly MAX_BUFFER_LENGTH = 100000; // 100KB limit

  private readonly rl: Interface;
  private readonly input?: NodeJS.ReadableStream;
  private readonly listeners = new Set<LineChangeListener>();
  private disposed = false;
  private syncTimer: NodeJS.Immediate | null = null;
  private pendingData: Buffer | string | null = null;
  private pendingSource: LineChangeSource = "user";
  private state: LineState;
  private lastInputTime = 0;
  private rapidInputCount = 0;

  constructor(rl: Interface) {
    this.rl = rl;
    this.state = {
      buffer: rl.line ?? "",
      cursor: this.readCursor(),
    };
    this.input = (rl as Interface & { input?: NodeJS.ReadableStream }).input;

    if (this.input) {
      this.input.on("data", this.handleInput);
    }
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }

    if (this.input) {
      this.input.removeListener("data", this.handleInput);
    }

    if (this.syncTimer) {
      clearImmediate(this.syncTimer);
      this.syncTimer = null;
    }

    this.listeners.clear();
    this.disposed = true;
  }

  public onChange(listener: LineChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public getState(): LineState {
    return { ...this.state };
  }

  public isPasting(): boolean {
    // Consider it a paste if we've had 3+ rapid inputs
    return this.rapidInputCount >= 3;
  }

  public setState(buffer: string, cursor?: number): void {
    if (this.disposed) {
      return;
    }

    // Protect against buffer overflow
    let safeBuffer = buffer;
    if (buffer.length > LineEditor.MAX_BUFFER_LENGTH) {
      safeBuffer = buffer.slice(0, LineEditor.MAX_BUFFER_LENGTH);
      console.warn(
        `\nWarning: Input truncated to ${LineEditor.MAX_BUFFER_LENGTH} characters`
      );
    }

    const nextCursor =
      cursor !== undefined
        ? Math.min(Math.max(0, cursor), safeBuffer.length)
        : safeBuffer.length;

    if (
      safeBuffer === this.state.buffer &&
      nextCursor === this.state.cursor
    ) {
      this.render();
      return;
    }

    const previous = this.getState();
    this.state = { buffer: safeBuffer, cursor: nextCursor };
    this.render();
    this.emitChange({
      state: this.getState(),
      previous,
      source: "programmatic",
      data: null,
    });
  }

  public refresh(): void {
    if (!this.disposed) {
      this.render();
    }
  }

  private handleInput = (chunk: Buffer | string) => {
    if (this.disposed) {
      return;
    }

    // Detect paste events by tracking rapid input
    const now = Date.now();
    const timeSinceLastInput = now - this.lastInputTime;
    this.lastInputTime = now;

    // If inputs come very rapidly (< 10ms apart), likely a paste
    if (timeSinceLastInput < 10) {
      this.rapidInputCount++;
    } else {
      this.rapidInputCount = 0;
    }

    // Detect and process file drag-and-drop
    const processedChunk = this.processFileDrop(chunk);

    // Store the chunk and mark source
    this.pendingData = processedChunk;
    this.pendingSource = "user";
    this.scheduleSync();
  };

  private processFileDrop(chunk: Buffer | string): Buffer | string {
    const value = typeof chunk === "string" ? chunk : chunk.toString("utf8");

    // Detect file:// URLs (common in terminal drag-and-drop)
    if (value.includes("file://")) {
      // Convert file:// URLs to relative paths
      const converted = value.replace(/file:\/\/([^\s]+)/g, (match, path) => {
        try {
          // Decode URI components and remove leading slash if on Windows
          const decoded = decodeURIComponent(path);
          // Make relative to cwd if possible
          const cwd = process.cwd();
          if (decoded.startsWith(cwd)) {
            return decoded.slice(cwd.length + 1);
          }
          return decoded;
        } catch {
          return path;
        }
      });
      return typeof chunk === "string" ? converted : Buffer.from(converted);
    }

    return chunk;
  }

  private scheduleSync(): void {
    if (this.syncTimer || this.disposed) {
      return;
    }
    this.syncTimer = setImmediate(this.syncState);
  }

  private syncState = () => {
    if (this.disposed) {
      return;
    }

    this.syncTimer = null;

    const buffer = this.rl.line ?? "";
    const cursor = this.readCursor();

    if (buffer === this.state.buffer && cursor === this.state.cursor) {
      this.pendingData = null;
      this.pendingSource = "user";
      return;
    }

    const previous = this.getState();
    this.state = { buffer, cursor };

    const event: LineChangeEvent = {
      state: this.getState(),
      previous,
      source: this.pendingSource,
      data: this.pendingData,
    };

    this.pendingData = null;
    this.pendingSource = "user";

    this.emitChange(event);
  };

  private emitChange(event: LineChangeEvent): void {
    if (this.listeners.size === 0) {
      return;
    }

    for (const listener of Array.from(this.listeners)) {
      listener(event);
    }
  }

  private render(): void {
    const anyRl = this.rl as Interface & {
      output?: NodeJS.WritableStream;
      line: string;
      cursor: number;
    };

    // Update readline's internal state
    anyRl.line = this.state.buffer;
    anyRl.cursor = this.state.cursor;

    const output = anyRl.output ?? process.stdout;
    const prompt =
      typeof this.rl.getPrompt === "function" ? this.rl.getPrompt() : "";

    // Non-TTY mode: simple write
    if (!(output as NodeJS.WriteStream).isTTY) {
      output.write(`${prompt}${this.state.buffer}`);
      return;
    }

    // TTY mode: precise cursor positioning
    try {
      // Move to start of line
      cursorTo(output, 0);
      // Clear entire line
      clearLine(output, 0);
      // Write prompt
      output.write(prompt);
      // Write buffer content
      output.write(this.state.buffer);

      // Position cursor correctly
      const moveLeft = this.state.buffer.length - this.state.cursor;
      if (moveLeft > 0) {
        moveCursor(output, -moveLeft, 0);
      }
    } catch (error) {
      // Fallback: just write the content if cursor control fails
      output.write(`\r${prompt}${this.state.buffer}`);
    }
  }

  private readCursor(): number {
    const cursor = (this.rl as Interface & { cursor?: number }).cursor;
    if (typeof cursor === "number" && Number.isFinite(cursor)) {
      return Math.max(0, cursor);
    }
    return this.rl.line.length;
  }
}
