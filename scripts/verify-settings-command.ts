import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "yaml";
import { handleSlashCommand } from "@meer/coding-agent/chat/slash.js";
import type { ChatAdapter } from "@meer/coding-agent/ui/chat-adapter.js";
import { DEFAULT_UI_SETTINGS } from "@meer/coding-agent/ui/ui-settings.js";

const tempRoot = mkdtempSync(join(tmpdir(), "meer-settings-test-"));
const configPath = join(tempRoot, "config.yaml");
const previousConfigPath = process.env.MEER_CONFIG_PATH;

const messages: string[] = [];
let liveToolDisplay = "";
let shownToolHandle = "";
let hideToolDetailCount = 0;
const promptChoices: string[] = [];
const promptInputs: string[] = [];
const tui = {
  appendSystemMessage: (message: string) => messages.push(message),
  setToolDisplayMode: (mode: "compact" | "auto" | "expanded") => {
    liveToolDisplay = mode;
  },
  showToolDetail: (handle?: string) => {
    shownToolHandle = handle ?? "";
    return shownToolHandle !== "missing";
  },
  hideToolDetail: () => {
    hideToolDetailCount++;
  },
  promptChoice: async () => {
    const value = promptChoices.shift();
    assert.ok(value, "test promptChoice queue should provide a value");
    return value;
  },
  prompt: async () => {
    const value = promptInputs.shift();
    assert.ok(value, "test prompt queue should provide a value");
    return value;
  },
} as unknown as ChatAdapter;

try {
  process.env.MEER_CONFIG_PATH = configPath;
  writeFileSync(
    configPath,
    [
      "provider: ollama",
      "model: mistral:7b-instruct",
      "ui:",
      "  screenReaderMode: auto",
      "",
    ].join("\n"),
    "utf8"
  );

  const config = {
    ui: { ...DEFAULT_UI_SETTINGS },
  };

  await handleSlashCommand(
    "/settings ui.toolDisplay auto",
    config,
    undefined,
    tui
  );

  const updated = parse(readFileSync(configPath, "utf8")) as {
    ui?: { toolDisplay?: string; screenReaderMode?: string };
  };
  assert.equal(updated.ui?.toolDisplay, "auto", "settings command writes ui.toolDisplay");
  assert.equal(updated.ui?.screenReaderMode, "auto", "settings command preserves sibling ui settings");
  assert.equal(config.ui.toolDisplay, "auto", "settings command updates loaded config object");
  assert.equal(liveToolDisplay, "auto", "settings command updates live TUI mode");
  assert.ok(
    messages.some((message) => message.includes("ui.toolDisplay set to auto")),
    "settings command reports success"
  );

  await handleSlashCommand(
    "/settings ui.toolOutput.maxPreviewLines 4",
    config,
    undefined,
    tui
  );

  const budgetUpdated = parse(readFileSync(configPath, "utf8")) as {
    ui?: {
      toolOutput?: { maxPreviewLines?: number };
      toolDisplay?: string;
    };
  };
  assert.equal(
    budgetUpdated.ui?.toolOutput?.maxPreviewLines,
    4,
    "settings command writes nested tool output budget"
  );
  assert.equal(
    config.ui.toolOutput.maxPreviewLines,
    4,
    "settings command updates loaded config budget"
  );

  await handleSlashCommand(
    "/settings show",
    config,
    undefined,
    tui
  );
  assert.ok(
    messages.some((message) => message.includes("ui.toolDisplay: auto")) &&
      messages.some((message) => message.includes("ui.toolOutput.maxPreviewLines: 4")),
    "settings show reports current value"
  );

  promptChoices.push("ui.toolDisplay", "expanded");
  await handleSlashCommand("/settings", config, undefined, tui);
  const interactiveModeUpdated = parse(readFileSync(configPath, "utf8")) as {
    ui?: { toolDisplay?: string };
  };
  assert.equal(
    interactiveModeUpdated.ui?.toolDisplay,
    "expanded",
    "interactive settings flow writes selected choice"
  );
  assert.equal(liveToolDisplay, "expanded", "interactive tool display applies live");

  promptChoices.push("ui.toolOutput.maxDetailLines", "custom");
  promptInputs.push("18");
  await handleSlashCommand("/settings edit", config, undefined, tui);
  const interactiveNumberUpdated = parse(readFileSync(configPath, "utf8")) as {
    ui?: { toolOutput?: { maxDetailLines?: number } };
  };
  assert.equal(
    interactiveNumberUpdated.ui?.toolOutput?.maxDetailLines,
    18,
    "interactive settings flow accepts custom numeric value"
  );
  assert.equal(config.ui.toolOutput.maxDetailLines, 18, "interactive numeric update changes loaded config");

  await handleSlashCommand("/tool", config, undefined, tui);
  assert.equal(shownToolHandle, "last", "/tool shows latest tool detail");

  await handleSlashCommand("/tool tc-123", config, undefined, tui);
  assert.equal(shownToolHandle, "tc-123", "/tool <id> passes selected handle");

  await handleSlashCommand("/tool missing", config, undefined, tui);
  assert.ok(
    messages.some((message) => message.includes('No tool row found for "missing"')),
    "/tool reports missing rows"
  );

  await handleSlashCommand("/tool hide", config, undefined, tui);
  assert.equal(hideToolDetailCount, 1, "/tool hide dismisses detail panel");
} finally {
  if (previousConfigPath === undefined) {
    delete process.env.MEER_CONFIG_PATH;
  } else {
    process.env.MEER_CONFIG_PATH = previousConfigPath;
  }
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log("settings command verification passed");
