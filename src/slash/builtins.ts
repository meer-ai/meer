import type { SlashCommandDefinition } from "./schema.js";

export interface BuiltInSlashCommand {
  command: string;
  description: string;
  protected?: boolean;
}

export const BUILT_IN_SLASH_COMMANDS: BuiltInSlashCommand[] = [
  {
    command: "/ask",
    description: "Ask the assistant a one-off question",
  },
  {
    command: "/commit-msg",
    description: "Generate a commit message from staged changes",
  },
  {
    command: "/history",
    description: "Show recent prompts you've entered",
  },
  {
    command: "/index",
    description: "Index project files for semantic search",
  },
  {
    command: "/init",
    description: "Create or refresh AGENTS.md for project tracking",
    protected: true,
  },
  {
    command: "/login",
    description: "Authenticate with Meer AI cloud services",
    protected: true,
  },
  {
    command: "/logout",
    description: "Sign out of the Meer AI cloud account",
    protected: true,
  },
  {
    command: "/mcp",
    description: "Manage Model Context Protocol servers",
  },
  {
    command: "/memory",
    description: "Inspect or manage session memory",
  },
  {
    command: "/provider",
    description: "Switch AI provider (Ollama, OpenAI, Gemini, etc)",
    protected: true,
  },
  {
    command: "/model",
    description: "Switch the active AI model",
  },
  {
    command: "/review",
    description: "Run a code review on staged changes",
  },
  {
    command: "/setup",
    description: "Open the setup wizard to configure providers",
    protected: true,
  },
  {
    command: "/screen-reader",
    description: "Toggle screen reader layout (on|off|auto)",
  },
  {
    command: "/alt-buffer",
    description: "Toggle alternate screen buffer (on|off|auto)",
  },
  {
    command: "/stats",
    description: "Show current session statistics",
  },
  {
    command: "/version",
    description: "Display installed Meer AI version",
  },
  {
    command: "/whoami",
    description: "Show the currently authenticated user",
  },
  {
    command: "/account",
    description: "View account info and subscription benefits",
  },
  {
    command: "/help",
    description: "Show slash command help",
    protected: true,
  },
  {
    command: "/exit",
    description: "Exit the chat session",
    protected: true,
  },
];

export type ResolvedSlashCommand = BuiltInSlashCommand & {
  source: "built-in" | "custom";
  custom?: SlashCommandDefinition;
  isOverride?: boolean;
};
