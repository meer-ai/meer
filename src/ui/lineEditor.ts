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
  private readonly rl: Interface;
  private readonly input?: NodeJS.ReadableStream;
  private readonly listeners = new Set<LineChangeListener>();
  private disposed = false;
  private syncTimer: NodeJS.Immediate | null = null;
  private pendingData: Buffer | string | null = null;
  private pendingSource: LineChangeSource = "user";
  private state: LineState;

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

  public setState(buffer: string, cursor?: number): void {
    if (this.disposed) {
      return;
    }

    const nextCursor =
      cursor !== undefined
        ? Math.min(Math.max(0, cursor), buffer.length)
        : buffer.length;

    if (
      buffer === this.state.buffer &&
      nextCursor === this.state.cursor
    ) {
      this.render();
      return;
    }

    const previous = this.getState();
    this.state = { buffer, cursor: nextCursor };
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

    this.pendingData = chunk;
    this.pendingSource = "user";
    this.scheduleSync();
  };

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

    anyRl.line = this.state.buffer;
    anyRl.cursor = this.state.cursor;

    const output = anyRl.output ?? process.stdout;
    const prompt =
      typeof this.rl.getPrompt === "function" ? this.rl.getPrompt() : "";

    if (!(output as NodeJS.WriteStream).isTTY) {
      output.write(`${prompt}${this.state.buffer}`);
      return;
    }

    cursorTo(output, 0);
    clearLine(output, 0);
    output.write(prompt);
    output.write(this.state.buffer);

    const moveLeft = this.state.buffer.length - this.state.cursor;
    if (moveLeft > 0) {
      moveCursor(output, -moveLeft, 0);
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
