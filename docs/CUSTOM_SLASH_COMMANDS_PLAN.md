# Custom Slash Commands Implementation Plan

## Executive Summary

Meer AI’s slash command system is currently hard-coded. This plan introduces a configurable registry that lets users define project-level and global custom slash commands without patching the CLI. The change touches input UX (chatbox + Ink UI), command execution in `src/cli.ts`, and configuration loading so that custom commands behave like first-class citizens alongside built-ins.

---

## 1. Current State

### 1.1 Command Definition
- Static list in `src/ui/slashCommands.ts` exports `{command, description}` tuples.
- Both the readline UI (`src/ui/chatbox.ts`) and Ink UI (`src/ui/ink/MeerChat.tsx`) pull directly from this array for help text and completion.

### 1.2 Execution Flow
- `src/cli.ts:508` implements `handleSlashCommand`, a large `switch` mapping each command string to bespoke logic or `runStandaloneCommand` helpers.
- Unknown commands fall back to an error message; there is no extensibility hook.

### 1.3 Discoverability & Help
- `/help` simply prints the static array via `src/ui/slashHelp.ts`.
- Slick suggestion UX exists (`src/ui/suggestionManager.ts`, `src/ui/ink/MeerChat.tsx`) but only for the baked-in list.

### 1.4 Pain Points
- Shipping new slash commands requires code changes + releases.
- Workspace- or team-specific workflows (e.g., `/deploy`, `/ticket`) cannot be modeled.
- There is no canonical place to document command metadata beyond the static array.

---

## 2. Goals & Non-Goals

### 2.1 Goals
- Allow end-users to define custom commands (name, description, handler) without patching Meer AI.
- Support at least two handler modes out of the box:
  1. **Prompt** – expand to a templated chat message sent to the agent loop.
  2. **Shell/CLI** – execute a configured shell command or Meer sub-command.
- Merge custom commands with built-ins for autocomplete, help, and validation.
- Provide JSON/YAML schema validation with clear error messages.

### 2.2 Non-Goals
- No UI builder for commands in this iteration.
- No hot-reload of configuration (loaded on process start only).
- No network fetching of remote command catalogs.

---

## 3. Proposed Architecture

### 3.1 Configuration Surface
- Introduce `~/.meer/slash-commands.yaml` for user-wide defaults.
- Allow project overrides in `<repo>/.meer/slash-commands.yaml` (if present).
- File schema (YAML or JSON) validated via `zod`:

```yaml
commands:
  - command: "/deploy"
    description: "Deploy current branch to staging"
    type: "shell"           # enum: shell | prompt | meer-cli
    action: "npm run deploy:staging"
  - command: "/ticket"
    description: "Create JIRA ticket draft"
    type: "prompt"
    template: |
      Draft a JIRA ticket for the current task.
      Branch: {{branch}}
      Summary: {{selection}}
    variables:
      - name: branch
        source: git-branch    # future extension
```

### 3.2 Registry Module
- Replace `src/ui/slashCommands.ts` with a `SlashCommandRegistry` that exports:
  - `getBuiltInCommands(): CommandDefinition[]`
  - `getCustomCommands(): CommandDefinition[]`
  - `getAllCommands(): CommandDefinition[]` (merged with duplicate resolution: custom overrides built-in descriptions but cannot shadow execution of protected commands unless explicitly enabled).
- Place loader under `src/slash/registry.ts` (new folder) to avoid UI coupling.
- Registry loads files once at startup, memoizing results. Provide `ReloadResult` helper for future refresh features.

### 3.3 Execution Strategy
- Extend `handleSlashCommand` in `src/cli.ts`:
  1. Normalize user input into `{command, args}`.
  2. Check built-in handler map (moved from `switch` to `Map<string, Handler>` for clarity).
  3. If not found, query registry for a custom definition and dispatch based on type:
     - `prompt`: interpolate template variables (basic moustache via `{{var}}`), append resulting text to chat pipeline (essentially return the prompt string to be handled like normal user input).
     - `shell`: run through existing sandbox by calling `tools.runCommand` or spawn child process; reuse `/run` infrastructure where possible and respect approvals/sandboxing.
     - `meer-cli`: reuse `runStandaloneCommand` with supplied sub-command name/args.
  4. All handlers return `{status: 'continue'|'restart'|'exit', message?: string}` to keep loop behavior consistent.
- Emit friendly error if command type unsupported or execution fails.

### 3.4 UI Integration
- Update consumers (`src/ui/chatbox.ts`, `src/ui/ink/MeerChat.tsx`, `src/ui/suggestionManager.ts`, `src/ui/slashHelp.ts`) to call `getAllCommands()` at module init.
- Include custom commands in help listing and Ink suggestion palettes.
- Show hint when a custom command overrides a built-in name (e.g., append `(custom)` tag in help output).

### 3.5 Validation & Telemetry
- Surface configuration parse errors with file path and line number (if available).
- Optionally add lightweight telemetry hook in `SessionTracker` to record custom command usage (flagged for future work).

---

## 4. Implementation Roadmap

1. **Schema + Loader**
   - Create `src/slash/schema.ts` with `zod` schema + TypeScript types.
   - Implement file resolver that checks project-first (`<cwd>/.meer/`) then user-level (`~/.meer/`).
   - Add unit tests covering valid/invalid configs and merge precedence.

2. **Registry + Utilities**
   - Implement `SlashCommandRegistry` with caching and duplicate handling.
   - Export `getAllCommands`, `findCustomCommand`, `isProtectedCommand` helpers.

3. **Refactor Built-in Handling**
   - Replace `switch` in `src/cli.ts` with handler map for readability.
   - Ensure existing commands keep behavior (construct regression tests where feasible).

4. **Custom Handler Execution**
   - Add dispatcher to `handleSlashCommand` for custom entries.
   - Implement template interpolation helper (e.g., `src/slash/template.ts`).
   - Pipe prompt-based commands back into chat loop (likely by returning `{status: 'send', message}` and letting caller feed it back).

5. **UI Updates**
   - Update all slash-command consumers to import registry instead of static list.
   - Adjust help output to highlight custom entries and note config file locations.

6. **Documentation**
   - Add `docs/CUSTOM_SLASH_COMMANDS.md` with configuration guide + examples.
   - Mention feature in README changelog if applicable.

7. **Testing & QA**
   - CLI tests for new handler map + custom execution.
   - Snapshot or integration tests for help output (if existing test infra allows).
   - Manual QA checklist: missing file, bad schema, overriding built-in, executing prompt + shell command.

---

## 5. Risks & Mitigations

- **Security / Shell Injection**: executing arbitrary shell commands is powerful. Mitigate by documenting risk, requiring explicit opt-in (`allowShell: true`), and reusing existing sandbox/approval pathways when available.
- **Name Collisions**: custom command overriding critical built-ins (e.g., `/exit`) could break UX. Treat a small set as “reserved” unless config explicitly sets `override: true`.
- **Performance**: file IO at startup is minimal, but guard against repeated loads in hot paths by caching results.
- **Template Complexity**: start with a minimal interpolation engine; defer complex expressions until real demand appears.

---

## 6. Open Questions

1. Should custom commands be shareable via packages/plugins, or stay as plain config for now?
2. Do we need per-command environment variables or working-directory overrides?
3. How should template variables (branch name, selection) be sourced—do we introduce a plugin API or keep manual for v1?
4. Should the Ink UI surface richer metadata (e.g., categories, icons) in the future?

---

## 7. Definition of Done

- Users can place a YAML/JSON file in either project or home directory and see commands appear in `/help`, autocompletion, and Ink palettes.
- Custom commands execute successfully according to their type, including prompt expansion and shell invocation.
- Configuration errors are reported with actionable messaging and do not crash the CLI.
- Tests and docs updated to cover new behavior.
