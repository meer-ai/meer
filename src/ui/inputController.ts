import type blessed from "blessed";

export type InputMode = "slash" | "mention" | null;

interface InputControllerOptions {
  textbox: blessed.Widgets.TextboxElement;
  screen: blessed.Widgets.Screen;
  onSubmit: (value: string) => void;
  onCancel?: () => void;
  onChange?: (value: string) => void;
  onModeChange?: (mode: InputMode) => void;
  onKeypress?: (
    value: string,
    key: blessed.Widgets.Events.IKeyEventArg
  ) => void;
}

/**
 * Centralizes all textbox wiring so we only run a single blessed input loop.
 * This avoids double key handling and keeps focus management predictable.
 */
export class InputController {
  private readonly textbox: blessed.Widgets.TextboxElement;
  private readonly screen: blessed.Widgets.Screen;
  private readonly onSubmit: (value: string) => void;
  private readonly onCancel?: () => void;
  private readonly onChange?: (value: string) => void;
  private readonly onModeChange?: (mode: InputMode) => void;
  private readonly onKeypress?: (
    value: string,
    key: blessed.Widgets.Events.IKeyEventArg
  ) => void;

  private isReading = false;
  private currentMode: InputMode = null;
  private suppressChange = false;

  constructor(options: InputControllerOptions) {
    this.textbox = options.textbox;
    this.screen = options.screen;
    this.onSubmit = options.onSubmit;
    this.onCancel = options.onCancel;
    this.onChange = options.onChange;
    this.onModeChange = options.onModeChange;
    this.onKeypress = options.onKeypress;

    this.textbox.on("submit", this.handleSubmit);
    this.textbox.on("cancel", this.handleCancel);
    this.textbox.on("keypress", this.handleKeypress);
    this.textbox.on("change", this.handleChange);
    this.textbox.key(["escape"], this.handleEscape);
  }

  focus(): void {
    this.textbox.focus();
    this.ensureReading();
    this.screen.program.showCursor();
  }

  clear(options: { silent?: boolean } = {}): void {
    const shouldSuppress = Boolean(options.silent);
    if (shouldSuppress) {
      this.suppressChange = true;
    }
    this.textbox.clearValue();
    if (shouldSuppress) {
      this.suppressChange = false;
      return;
    }
    this.emitChange("");
  }

  setValue(value: string, options: { silent?: boolean } = {}): void {
    const shouldSuppress = Boolean(options.silent);
    if (shouldSuppress) {
      this.suppressChange = true;
    }
    this.textbox.setValue(value);
    if (shouldSuppress) {
      this.suppressChange = false;
      return;
    }
    this.emitChange(value);
  }

  getValue(): string {
    return this.textbox.getValue();
  }

  appendValue(value: string, options: { silent?: boolean } = {}): void {
    const next = this.getValue() + value;
    this.setValue(next, options);
  }

  private ensureReading(): void {
    if (this.isReading) return;

    this.isReading = true;
    this.textbox.readInput(() => {
      this.isReading = false;
    });
  }

  private handleSubmit = (): void => {
    const raw = this.getValue();
    this.clear({ silent: true });
    this.onSubmit(raw);
    this.ensureReading();
  };

  private handleCancel = (): void => {
    if (this.onCancel) {
      this.onCancel();
    }
    this.ensureReading();
  };

  private handleEscape = (): void => {
    if (this.onCancel) {
      this.onCancel();
    } else {
      this.clear();
    }
    this.ensureReading();
  };

  private handleKeypress = (
    _ch: string,
    key: blessed.Widgets.Events.IKeyEventArg
  ): void => {
    if (this.onKeypress) {
      const value = this.getValue();
      this.onKeypress(value, key);
    }
  };

  private emitChange(value: string): void {
    if (this.onChange) {
      this.onChange(value);
    }
  }

  private updateMode(value: string): void {
    let nextMode: InputMode = null;
    if (value.startsWith("/")) {
      nextMode = "slash";
    } else if (value.includes("@")) {
      nextMode = "mention";
    }

    if (nextMode !== this.currentMode) {
      this.currentMode = nextMode;
      if (this.onModeChange) {
        this.onModeChange(nextMode);
      }
    }
  }

  private handleChange = (): void => {
    if (this.suppressChange) {
      return;
    }
    const value = this.getValue();
    this.emitChange(value);
    this.updateMode(value);
  };
}
