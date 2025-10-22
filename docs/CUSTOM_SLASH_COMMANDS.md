# Custom Slash Commands

Meer AI now supports project-level and user-level slash commands without touching the CLI source. Custom commands appear everywhere the built-in palette is used—Ink suggestions, the readline picker, and `/help`.

---

## Configuration Files

The CLI loads configuration once at startup. Place a YAML or JSON file at one of the following locations:

| Scope   | Path                                   |
|---------|----------------------------------------|
| User    | `~/.meer/slash-commands.yaml` (or `.yml`, `.json`) |
| Project | `<repo>/.meer/slash-commands.yaml` (or `.yml`, `.json`) |

Project entries override user entries with the same name. Restart the CLI after editing the file.

If parsing fails, the CLI prints detailed errors the next time you run `/help` or trigger the failing command.

---

## Schema

```yaml
commands:
  - command: "/deploy"
    description: "Deploy current branch to staging"
    type: "shell"           # prompt | shell | meer-cli
    action: "npm run deploy:staging"
    allowShell: true        # required for shell actions

  - command: "/ticket"
    description: "Create JIRA ticket draft"
    type: "prompt"
    template: |
      Draft a JIRA ticket for this task.
      Branch: {{args}}

  - command: "/mem-stats"
    description: "Show memory summary"
    type: "meer-cli"
    action: "memory show --summary"
```

### Common fields
| Field            | Description |
|------------------|-------------|
| `command`        | Slash command string (must start with `/` and contain no spaces). |
| `description`    | Text shown in `/help`, pickers, and suggestions. |
| `type`           | Execution mode: `prompt`, `shell`, or `meer-cli`. Defaults to `prompt`. |
| `action`         | Required for `shell` and `meer-cli` commands. |
| `template`       | Required for `prompt` commands. Supports `{{args}}`, `{{command}}`, and `{{raw}}` placeholders. |
| `args`           | Optional array of additional arguments appended when running `shell` or `meer-cli` actions. |
| `allowShell`     | Must be `true` for `shell` commands to acknowledge the security risk. |
| `override`       | Set to `true` to replace protected built-ins (e.g., `/model`). |

Unsupported combinations fail validation with a descriptive error.

---

## Command Types

### Prompt
Expands the `template` and injects the result into the chat loop. Useful for boilerplate queries.

Available template variables:
- `{{args}}` – User input after the command (single string).
- `{{command}}` – The slash command itself (e.g., `/ticket`).
- `{{raw}}` – The full input line.

Unknown placeholders are left intact, so you can introduce your own conventions without breaking the renderer.

### Shell
Runs the configured shell command via the existing sandbox pipeline. Custom arguments provided by the user are appended verbatim. The CLI refuses to run the command unless `allowShell: true` is present.

### Meer CLI
Executes another Meer sub-command (`meer memory show`, `meer review`, etc.) inside the current process. The `action` field is split using shell-style quoting rules, then combined with optional `args` and any user-provided arguments.

---

## Overrides & Badges

`/help` and the palette display badges that describe each entry:

| Badge             | Meaning |
|-------------------|---------|
| `custom`          | Command defined in config (no built-in conflict). |
| `override`        | Custom command replaces a built-in handler. |
| `custom metadata` | Custom description is applied, but execution still uses the built-in handler (protected command without `override: true`). |
| `reserved`        | Command name is reserved; override requires explicit opt-in. |

Protected commands (`/exit`, `/help`, `/setup`, `/provider`, etc.) keep their built-in behaviour unless `override: true` is set.

---

## Troubleshooting

- Run `/help` to see the loaded file paths and any parse errors.
- Unknown slash commands will also surface configuration validation issues.
- Edits require a CLI restart; hot reload is not supported yet.
- Configuration files must be valid UTF-8.

---

## Tips

- Prefer project-level commands for workflow-specific helpers and store them in VCS.
- Use `prompt` commands for structured requests (e.g., `/retro`, `/summary`).
- Wrap potentially destructive `shell` commands inside scripts committed to the repo so collaborators can audit them.
- Combine `meer-cli` commands with arguments to create shortcuts like `/memory-full` or `/ask-docs`.
