/**
 * First-run project-trust gate.
 *
 * The first time meer runs interactively in a folder, the user is asked whether
 * they trust it. The decision selects the session's {@link TrustMode} and is
 * persisted (except "Trust once"), so trusted/untrusted folders are never asked
 * again.
 */

import chalk from "chalk";
import { TrustStore, type TrustMode } from "./store.js";

export interface ResolveTrustOptions {
  cwd: string;
  store: TrustStore;
  /** Interactive chooser (the TUI's promptChoice). Absent in headless modes. */
  promptChoice?: (
    message: string,
    choices: Array<{ label: string; value: string }>,
    defaultChoice?: string
  ) => Promise<string>;
}

function trustPromptMessage(cwd: string): string {
  return [
    "**Trust this project folder?**",
    "",
    `\`${cwd}\``,
    "",
    "Trusting lets meer run shell commands without prompting and remember your",
    "\"always allow\" choices for this folder. If you don't trust it, every shell",
    "command will ask first.",
  ].join("\n");
}

/**
 * Resolve the trust mode for this session, prompting once for new folders.
 *
 * - Previously trusted folder  → "trusted" (no prompt)
 * - Previously declined folder → "restricted" (no prompt)
 * - New folder, interactive    → prompt: Trust / Trust once / Don't trust
 * - New folder, non-interactive→ "trusted" (preserves headless behavior; not persisted)
 */
export async function resolveTrustMode(options: ResolveTrustOptions): Promise<TrustMode> {
  const { cwd, store, promptChoice } = options;

  const existing = store.getProject(cwd);
  if (existing) {
    return existing.trusted ? "trusted" : "restricted";
  }

  // No recorded decision. Without an interactive chooser (print/headless mode)
  // we cannot ask, so fall back to the historical behavior of running freely.
  if (!promptChoice) {
    return "trusted";
  }

  const choice = await promptChoice(
    trustPromptMessage(cwd),
    [
      { label: "Trust (remember this folder)", value: "trust" },
      { label: "Trust once (this session only)", value: "once" },
      { label: "Don't trust (ask before every command)", value: "no" },
    ],
    "once"
  );

  if (choice === "trust") {
    store.setTrusted(cwd, true);
    return "trusted";
  }
  if (choice === "no") {
    store.setTrusted(cwd, false);
    return "restricted";
  }
  // "once": session-only trust, deliberately not persisted.
  return "session";
}

/** Human-readable one-liner for the session banner. */
export function describeTrustMode(mode: TrustMode): string {
  switch (mode) {
    case "trusted":
      return chalk.dim("Project trusted — commands run without prompting.");
    case "session":
      return chalk.dim("Project trusted for this session only.");
    case "restricted":
      return chalk.yellow("Project not trusted — shell commands will ask first.");
  }
}

export { TrustStore };
