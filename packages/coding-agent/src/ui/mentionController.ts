import { LineChangeEvent, LineEditor, LineState } from "./lineEditor.js";

interface MentionCandidate {
  fragment: string;
  start: number;
  state: LineState;
}

export interface MentionTriggerContext {
  fragment: string;
  start: number;
  state: LineState;
}

export interface MentionControllerOptions {
  minChars?: number;
  debounceMs?: number;
  onTrigger: (context: MentionTriggerContext) => Promise<void>;
}

const DEFAULT_OPTIONS = {
  minChars: 2,
  debounceMs: 300,
} satisfies Required<Omit<MentionControllerOptions, "onTrigger">>;

export class MentionController {
  private readonly editor: LineEditor;
  private readonly options: Required<MentionControllerOptions>;
  private readonly unsubscribe: () => void;

  private disposed = false;
  private enabled = true;
  private pending: MentionCandidate | null = null;
  private pendingTimer: NodeJS.Timeout | null = null;
  private active = false;

  constructor(editor: LineEditor, options: MentionControllerOptions) {
    if (!options.onTrigger) {
      throw new Error("MentionController requires an onTrigger callback.");
    }

    this.editor = editor;
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
      onTrigger: options.onTrigger,
    } as Required<MentionControllerOptions>;

    this.unsubscribe = this.editor.onChange(this.handleChange);
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }

    this.unsubscribe();
    this.clearPending();
    this.disposed = true;
  }

  public setEnabled(enabled: boolean): void {
    if (this.disposed || this.enabled === enabled) {
      return;
    }

    this.enabled = enabled;

    if (!enabled) {
      this.clearPending();
    } else {
      const currentState = this.editor.getState();
      const candidate = this.extractCandidate(currentState);
      if (candidate) {
        this.schedule(candidate);
      }
    }
  }

  private handleChange = (event: LineChangeEvent): void => {
    // Ignore changes when disposed or disabled
    if (this.disposed || !this.enabled) {
      return;
    }

    // Don't schedule new triggers when menu is already active
    // But don't block the input processing itself
    if (this.active) {
      // Clear any pending triggers since user is already in a menu
      this.clearPending();
      return;
    }

    // Don't trigger mentions during rapid paste operations
    if (this.editor.isPasting()) {
      this.clearPending();
      return;
    }

    // Extract potential mention candidate from current state
    const candidate = this.extractCandidate(event.state);

    // Clear pending trigger if no candidate found
    if (!candidate) {
      this.clearPending();
      return;
    }

    // Schedule a debounced trigger
    this.schedule(candidate);
  };

  private schedule(candidate: MentionCandidate): void {
    this.clearPending();
    this.pending = candidate;
    this.pendingTimer = setTimeout(() => {
      void this.maybeTrigger();
    }, this.options.debounceMs);
  }

  private async maybeTrigger(): Promise<void> {
    // Safety checks
    if (!this.pending || this.disposed || !this.enabled) {
      return;
    }

    const candidate = this.pending;
    this.clearPending();

    // Re-check current state to ensure candidate is still valid
    const currentState = this.editor.getState();
    const currentCandidate = this.extractCandidate(currentState);

    // If candidate changed or disappeared, reschedule if there's a new one
    if (
      !currentCandidate ||
      currentCandidate.start !== candidate.start ||
      currentCandidate.fragment !== candidate.fragment
    ) {
      // Reschedule with new candidate if still valid and not active
      if (currentCandidate && this.enabled && !this.active) {
        this.schedule(currentCandidate);
      }
      return;
    }

    // Set active flag to prevent concurrent triggers
    this.active = true;
    try {
      await this.options.onTrigger({
        fragment: currentCandidate.fragment,
        start: currentCandidate.start,
        state: currentState,
      });
    } catch (error) {
      // Silently handle errors to prevent crashes
      console.error("Mention trigger error:", error);
    } finally {
      // Always reset active flag
      this.active = false;
    }
  }

  private clearPending(): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
    }
    this.pendingTimer = null;
    this.pending = null;
  }

  private extractCandidate(state: LineState): MentionCandidate | null {
    const cursor = state.cursor;
    if (cursor <= 0) {
      return null;
    }

    const beforeCursor = state.buffer.slice(0, cursor);
    const lastAt = beforeCursor.lastIndexOf("@");
    if (lastAt === -1) {
      return null;
    }

    const prevChar = lastAt > 0 ? beforeCursor[lastAt - 1] : "";
    if (prevChar && !/\s/.test(prevChar)) {
      return null;
    }

    const fragment = beforeCursor.slice(lastAt + 1);
    if (!fragment || /\s/.test(fragment[fragment.length - 1])) {
      return null;
    }

    const segments = fragment.split(/[\\/]/);
    const lastSegment = segments.pop() ?? fragment;
    const cleaned = lastSegment.replace(/[^A-Za-z0-9._-]/g, "");

    if (cleaned.length < this.options.minChars) {
      return null;
    }

    return {
      fragment,
      start: lastAt,
      state,
    };
  }
}
