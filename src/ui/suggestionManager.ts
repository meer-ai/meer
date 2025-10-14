export type SuggestionSource = "slash" | "mention";

export interface SuggestionItem {
  source: SuggestionSource;
  label: string;
  apply: (currentValue: string) => string;
}

interface SuggestionManagerOptions {
  getProjectFiles: () => Promise<string[]>;
  slashCommands: string[];
  maxSlashItems?: number;
  maxMentionItems?: number;
  minMentionChars?: number;
}

export class SuggestionManager {
  private readonly getProjectFiles: () => Promise<string[]>;
  private readonly slashCommands: string[];
  private readonly maxSlashItems: number;
  private readonly maxMentionItems: number;
  private readonly minMentionChars: number;

  constructor(options: SuggestionManagerOptions) {
    this.getProjectFiles = options.getProjectFiles;
    this.slashCommands = options.slashCommands;
    this.maxSlashItems = options.maxSlashItems ?? 8;
    this.maxMentionItems = options.maxMentionItems ?? 10;
    this.minMentionChars = options.minMentionChars ?? 2;
  }

  async getSuggestions(input: string): Promise<SuggestionItem[]> {
    if (!input) {
      return [];
    }

    if (input.startsWith("/")) {
      return this.getSlashSuggestions(input);
    }

    if (input.includes("@")) {
      return this.getMentionSuggestions(input);
    }

    return [];
  }

  private async getSlashSuggestions(input: string): Promise<SuggestionItem[]> {
    const command = input.split(" ")[0];
    if (command.length <= 1) {
      return [];
    }

    const needle = command.toLowerCase();

    return this.slashCommands
      .filter((cmd) => cmd.toLowerCase().startsWith(needle))
      .slice(0, this.maxSlashItems)
      .map((cmd) => ({
        source: "slash" as const,
        label: cmd,
        apply: () => cmd,
      }));
  }

  private async getMentionSuggestions(input: string): Promise<SuggestionItem[]> {
    const atIndex = input.lastIndexOf("@");
    if (atIndex === -1) {
      return [];
    }

    const fragment = input.slice(atIndex + 1).split(/\s/)[0];
    if (!fragment || fragment.length < this.minMentionChars) {
      return [];
    }

    const files = await this.getProjectFiles();
    const needle = fragment.toLowerCase();

    return files
      .filter((file) => file.toLowerCase().includes(needle))
      .slice(0, this.maxMentionItems)
      .map((file) => ({
        source: "mention" as const,
        label: file,
        apply: (currentValue: string) => {
          const currentAtIndex = currentValue.lastIndexOf("@");
          if (currentAtIndex === -1) {
            return currentValue;
          }

          const beforeAt = currentValue.slice(0, currentAtIndex + 1);
          const afterAt = currentValue.slice(currentAtIndex + 1);
          const spaceIndex = afterAt.search(/\s/);
          const suffix = spaceIndex === -1 ? "" : afterAt.slice(spaceIndex);

          return `${beforeAt}${file}${suffix}`;
        },
      }));
  }
}
