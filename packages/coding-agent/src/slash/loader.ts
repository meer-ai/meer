import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { parse as parseYaml } from "yaml";
import {
  SlashCommandConfigSchema,
  type SlashCommandDefinition,
} from "./schema.js";

const CONFIG_FILENAMES = [
  "slash-commands.yaml",
  "slash-commands.yml",
  "slash-commands.json",
] as const;

export interface SlashCommandLoadError {
  file: string;
  message: string;
}

export interface SlashCommandLoadResult {
  commands: SlashCommandDefinition[];
  errors: SlashCommandLoadError[];
  sources: string[];
}

function resolveConfigFile(baseDir: string): string | null {
  for (const name of CONFIG_FILENAMES) {
    const candidate = join(baseDir, name);
    if (existsSync(candidate)) {
      return resolve(candidate);
    }
  }
  return null;
}

function parseRawConfig(
  filePath: string,
): { data: unknown; errors: SlashCommandLoadError[] } {
  try {
    const raw = readFileSync(filePath, "utf-8");
    if (raw.trim().length === 0) {
      return { data: {}, errors: [] };
    }

    if (filePath.endsWith(".json")) {
      return { data: JSON.parse(raw), errors: [] };
    }

    return { data: parseYaml(raw), errors: [] };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error reading file";
    return {
      data: null,
      errors: [
        {
          file: filePath,
          message,
        },
      ],
    };
  }
}

function loadConfigFile(
  filePath: string,
): { commands: SlashCommandDefinition[]; errors: SlashCommandLoadError[] } {
  const { data, errors } = parseRawConfig(filePath);
  if (errors.length > 0) {
    return { commands: [], errors };
  }

  const parsed = SlashCommandConfigSchema.safeParse(data ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      file: filePath,
      message: issue.message,
    }));
    return { commands: [], errors: issues };
  }

  return {
    commands: parsed.data.commands,
    errors: [],
  };
}

function getProjectConfigDir(cwd: string): string {
  return join(cwd, ".meer");
}

function getUserConfigDir(): string {
  return join(homedir(), ".meer");
}

export function loadSlashCommandConfigs(options?: {
  cwd?: string;
}): SlashCommandLoadResult {
  const cwd = options?.cwd ?? process.cwd();
  const errors: SlashCommandLoadError[] = [];
  const commands: SlashCommandDefinition[] = [];
  const sources: string[] = [];

  const userDir = getUserConfigDir();
  const userFile = resolveConfigFile(userDir);
  if (userFile) {
    const result = loadConfigFile(userFile);
    commands.push(...result.commands);
    errors.push(...result.errors);
    if (result.commands.length > 0) {
      sources.push(userFile);
    }
  }

  const projectDir = getProjectConfigDir(cwd);
  const projectFile = resolveConfigFile(projectDir);
  if (projectFile) {
    const result = loadConfigFile(projectFile);
    if (result.commands.length > 0) {
      // Project-level commands override user-level commands with the same name.
      const existing = new Map(commands.map((cmd) => [cmd.command, cmd]));
      for (const command of result.commands) {
        existing.set(command.command, command);
      }
      commands.length = 0;
      commands.push(...existing.values());
      sources.push(projectFile);
    }
    errors.push(...result.errors);
  }

  return { commands, errors, sources };
}

export function ensureConfigDirectories(options?: {
  cwd?: string;
}): { userDir: string; projectDir: string } {
  const cwd = options?.cwd ?? process.cwd();
  return {
    userDir: getUserConfigDir(),
    projectDir: getProjectConfigDir(cwd),
  };
}

export function formatLoadErrors(
  errors: SlashCommandLoadError[],
): string | null {
  if (errors.length === 0) {
    return null;
  }

  const header =
    errors.length === 1
      ? "Error loading slash command configuration:"
      : "Errors loading slash command configuration:";

  const lines = [header];
  for (const error of errors) {
    lines.push(`  - ${error.file}: ${error.message}`);
  }

  return lines.join("\n");
}
