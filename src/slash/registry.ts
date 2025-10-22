import {
  BUILT_IN_SLASH_COMMANDS,
  type BuiltInSlashCommand,
} from "./builtins.js";
import {
  loadSlashCommandConfigs,
  type SlashCommandLoadError,
  type SlashCommandLoadResult,
} from "./loader.js";
import type { SlashCommandDefinition } from "./schema.js";

interface RegistryState {
  cwd: string;
  loadedAt: number;
  commands: SlashCommandDefinition[];
  errors: SlashCommandLoadError[];
  sources: string[];
}

export interface SlashCommandListEntry {
  command: string;
  description: string;
  source: "built-in" | "custom";
  isOverride: boolean;
  isProtected: boolean;
  overrideEnabled: boolean;
}

let state: RegistryState | null = null;

function loadState(cwd: string): RegistryState {
  const result: SlashCommandLoadResult = loadSlashCommandConfigs({ cwd });
  return {
    cwd,
    loadedAt: Date.now(),
    commands: result.commands,
    errors: result.errors,
    sources: result.sources,
  };
}

function ensureState(cwd?: string): RegistryState {
  const targetCwd = cwd ?? process.cwd();
  if (!state || state.cwd !== targetCwd) {
    state = loadState(targetCwd);
  }
  return state;
}

export function reloadSlashCommandRegistry(cwd?: string): RegistryState {
  const targetCwd = cwd ?? process.cwd();
  state = loadState(targetCwd);
  return state;
}

export function getBuiltInCommands(): BuiltInSlashCommand[] {
  return BUILT_IN_SLASH_COMMANDS.slice();
}

export function getCustomCommands(cwd?: string): SlashCommandDefinition[] {
  const registry = ensureState(cwd);
  return registry.commands.slice();
}

export function getAllCommands(cwd?: string): SlashCommandListEntry[] {
  const registry = ensureState(cwd);
  const customMap = new Map<string, SlashCommandDefinition>();
  for (const command of registry.commands) {
    customMap.set(command.command, command);
  }

  const entries: SlashCommandListEntry[] = [];

  for (const builtIn of BUILT_IN_SLASH_COMMANDS) {
    const custom = customMap.get(builtIn.command);
    const isProtected = Boolean(builtIn.protected);
    const overrideEnabled = custom
      ? !isProtected || custom.override === true
      : false;
    entries.push({
      command: builtIn.command,
      description: custom?.description ?? builtIn.description,
      source: custom ? "custom" : "built-in",
      isOverride: Boolean(custom),
      isProtected,
      overrideEnabled,
    });
    if (custom) {
      customMap.delete(builtIn.command);
    }
  }

  const additional = Array.from(customMap.values()).sort((a, b) =>
    a.command.localeCompare(b.command),
  );

  for (const command of additional) {
    entries.push({
      command: command.command,
      description: command.description,
      source: "custom",
      isOverride: false,
      isProtected: false,
      overrideEnabled: true,
    });
  }

  return entries;
}

export interface ResolvedCustomCommand {
  definition: SlashCommandDefinition;
  builtIn?: BuiltInSlashCommand;
  overrideEnabled: boolean;
}

export function resolveCustomCommand(
  commandName: string,
  cwd?: string,
): ResolvedCustomCommand | null {
  const registry = ensureState(cwd);
  const custom = registry.commands.find(
    (entry) => entry.command === commandName,
  );
  if (!custom) {
    return null;
  }

  const builtIn = BUILT_IN_SLASH_COMMANDS.find(
    (entry) => entry.command === commandName,
  );

  if (!builtIn) {
    return {
      definition: custom,
      overrideEnabled: true,
    };
  }

  const overrideEnabled =
    !builtIn.protected || (custom.override ?? false) === true;

  return {
    definition: custom,
    builtIn,
    overrideEnabled,
  };
}

export function findCustomCommand(
  commandName: string,
  cwd?: string,
): SlashCommandDefinition | null {
  const resolved = resolveCustomCommand(commandName, cwd);
  return resolved && resolved.overrideEnabled ? resolved.definition : null;
}

export function getSlashCommandErrors(): SlashCommandLoadError[] {
  const registry = ensureState();
  return registry.errors.slice();
}

export function getSlashCommandSources(): string[] {
  const registry = ensureState();
  return registry.sources.slice();
}
