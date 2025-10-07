export interface SlashCommandDefinition {
  command: string;
  description: string;
}

export const slashCommands: SlashCommandDefinition[] = [
  {
    command: "/init",
    description: "Create AGENTS.md for project tracking",
  },
  {
    command: "/stats",
    description: "Show current session statistics",
  },
  {
    command: "/account",
    description: "View account info and subscription benefits",
  },
  {
    command: "/setup",
    description: "Run setup wizard to reconfigure providers",
  },
  {
    command: "/provider",
    description: "Switch AI provider (Ollama, OpenAI, Gemini)",
  },
  {
    command: "/model",
    description: "Switch AI model",
  },
  {
    command: "/help",
    description: "Show slash command help",
  },
  {
    command: "/history",
    description: "Show recent prompts you've entered",
  },
  {
    command: "/exit",
    description: "Exit chat session",
  },
];
