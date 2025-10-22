import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadSlashCommandConfigs,
} from "../src/slash/loader.js";
import {
  reloadSlashCommandRegistry,
  getAllCommands,
  resolveCustomCommand,
  findCustomCommand,
} from "../src/slash/registry.js";

const tempRoot = mkdtempSync(join(tmpdir(), "meer-slash-test-"));
const projectDir = join(tempRoot, "project");
const meerDir = join(projectDir, ".meer");

mkdirSync(meerDir, { recursive: true });

const configContent = `commands:
  - command: "/custom"
    description: "Custom prompt command"
    type: "prompt"
    template: "Hello {{args}}"
  - command: "/help"
    description: "Friendly help override"
    type: "prompt"
    template: "Help override"
`;

const configPath = join(meerDir, "slash-commands.yaml");
writeFileSync(configPath, configContent, "utf-8");

const loadResult = loadSlashCommandConfigs({ cwd: projectDir });
assert.equal(loadResult.commands.length, 2, "should load two custom commands");
assert.equal(loadResult.errors.length, 0, "should not report loader errors");

const originalCwd = process.cwd();
process.chdir(projectDir);

try {
  reloadSlashCommandRegistry(projectDir);
  const commands = getAllCommands();

  const customEntry = commands.find((entry) => entry.command === "/custom");
  assert(customEntry, "custom command should appear in command list");
  assert.equal(customEntry?.source, "custom");
  assert.equal(customEntry?.isOverride, false);

  const helpEntry = commands.find((entry) => entry.command === "/help");
  assert(helpEntry, "built-in /help command should still be present");
  assert.equal(helpEntry?.isOverride, true);
  assert.equal(
    helpEntry?.overrideEnabled,
    false,
    "/help should require override: true",
  );

  const customResolution = resolveCustomCommand("/custom");
  assert(customResolution, "custom command resolution should exist");
  assert.equal(customResolution?.overrideEnabled, true);

  const helpResolution = resolveCustomCommand("/help");
  assert(helpResolution, "help resolution should exist");
  assert.equal(helpResolution?.overrideEnabled, false);
  assert.equal(
    findCustomCommand("/help"),
    null,
    "protected command without override should not replace built-in handler",
  );
} finally {
  process.chdir(originalCwd);
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log("Slash command registry verified.");
