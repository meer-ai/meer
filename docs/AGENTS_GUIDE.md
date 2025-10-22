# Sub-Agents User Guide

## Overview

Meer AI's sub-agents system enables task parallelization, better context management, and specialized agent capabilities. Each sub-agent is a specialized AI assistant focused on a specific task domain.

## What are Sub-Agents?

Sub-agents are isolated AI instances that:
- Have their own system prompts and personalities
- Can be restricted to specific tools for safety
- Maintain independent conversation contexts
- Execute tasks in parallel for better performance
- Provide focused expertise in their domain

## Getting Started

### List Available Agents

View all available agents:

```bash
meer agents
# or
meer agents list
```

View only enabled agents:

```bash
meer agents list --enabled-only
```

### View Agent Details

Get detailed information about a specific agent:

```bash
meer agents show code-reviewer
```

This shows:
- Description and purpose
- Allowed tools
- System prompt preview
- Scope (user or project)
- Enabled status

## Creating Custom Agents

### Interactive Creation

Create a new agent using the interactive wizard:

```bash
meer agents create
```

The wizard will guide you through:
1. **Name**: Lowercase identifier (e.g., `security-auditor`)
2. **Description**: What the agent does and when to use it
3. **Tools**: Which tools the agent can access
4. **System Prompt**: The agent's instructions and personality
5. **Tags**: Optional tags for organization

### Agent Scopes

Agents can be created in two scopes:

- **Project** (`--scope project`, default): Stored in `.meer/agents/`
  - Specific to the current project
  - Version controlled with your code
  - Override user-level agents

- **User** (`--scope user`): Stored in `~/.meer/agents/`
  - Available across all projects
  - Personal agent library
  - Lower priority than project agents

```bash
# Create a project-specific agent
meer agents create --scope project

# Create a user-level agent
meer agents create --scope user
```

## Agent Definition Format

Agents are defined in Markdown files with YAML frontmatter:

```markdown
---
name: security-auditor
description: Audits code for security vulnerabilities and best practices
model: inherit
tools:
  - read_file
  - grep
  - find_files
  - run_command
enabled: true
version: 1.0.0
tags:
  - security
  - audit
---

# Security Auditor Agent

You are a specialized security auditor focused on finding vulnerabilities.

## Your Responsibilities

1. **Vulnerability Detection**: Identify common security issues
2. **Best Practices**: Ensure secure coding patterns
3. **Compliance**: Check for security standards compliance

## Security Checklist

- [ ] SQL injection vulnerabilities
- [ ] XSS vulnerabilities
- [ ] Authentication/authorization issues
- [ ] Sensitive data exposure
- [ ] Dependency vulnerabilities

## Output Format

Provide findings as:
- 🔴 Critical: Immediate security risks
- 🟡 Warning: Potential issues
- 🟢 Good: Security best practices found
```

## Built-in Agents

Meer comes with three default agents:

### Code Reviewer

**Name**: `code-reviewer`
**Purpose**: Reviews code for quality, security, and best practices

Use after making code changes to get expert feedback on:
- Code quality and maintainability
- Security vulnerabilities
- Performance issues
- Best practices

```bash
meer agents show code-reviewer
```

### Debugger

**Name**: `debugger`
**Purpose**: Analyzes errors and finds root causes

Use when encountering:
- Test failures
- Runtime errors
- Unexpected behavior

```bash
meer agents show debugger
```

### Test Writer

**Name**: `test-writer`
**Purpose**: Generates unit and integration tests

Use when:
- New code needs test coverage
- Existing tests need expansion
- Test quality needs improvement

```bash
meer agents show test-writer
```

## Tool Access Control

### Why Tool Restrictions?

Restricting tools per agent provides:
- **Safety**: Prevent accidental file modifications
- **Focus**: Keep agents focused on their domain
- **Performance**: Reduce unnecessary tool calls

### Available Tool Categories

When creating an agent, you can select from these categories:

1. **Read** - Read-only file operations
   - `read_file`, `grep`, `find_files`, `list_files`, `read_many_files`

2. **Edit** - File modification operations
   - `propose_edit`, `edit_section`, `edit_line`

3. **Bash** - Command execution
   - `run_command`

4. **Web** - Internet access
   - `google_search`, `brave_search`, `web_fetch`

5. **All** - Unrestricted access to all tools

### Recommended Tool Sets

**Read-Only Agents** (reviewers, analyzers):
```yaml
tools:
  - read_file
  - grep
  - find_files
```

**Write-Enabled Agents** (refactorers, fixers):
```yaml
tools:
  - read_file
  - grep
  - propose_edit
  - edit_section
```

**Execution Agents** (testers, builders):
```yaml
tools:
  - read_file
  - run_command
  - grep
```

## Managing Agents

### Enable/Disable Agents

Temporarily disable an agent without deleting it:

```bash
# Disable an agent
meer agents disable code-reviewer

# Re-enable an agent
meer agents enable code-reviewer
```

Disabled agents remain in your agent library but won't be used.

### Deleting Agents

Remove an agent permanently:

```bash
# Delete from project scope
meer agents delete custom-agent --scope project

# Delete from user scope
meer agents delete custom-agent --scope user
```

You'll be asked to confirm before deletion.

### Editing Agents

To edit an agent, find its file location:

```bash
meer agents show my-agent
# Look for "File: /path/to/agent.md"
```

Then edit the markdown file directly in your preferred editor.

## Using Agents (Coming Soon)

The agents are currently set up and ready. Integration with the main chat interface for automatic delegation is planned for a future update.

Future usage will include:

```bash
# Explicit delegation (planned)
> @code-reviewer check my latest changes

# Automatic delegation (planned)
> Fix the authentication bug
# System automatically delegates to debugger agent
```

## Best Practices

### Creating Effective Agents

1. **Clear Purpose**: Give each agent a well-defined, focused responsibility
2. **Detailed Prompts**: Write comprehensive system prompts with examples
3. **Appropriate Tools**: Only grant tools necessary for the task
4. **Good Descriptions**: Help users understand when to use the agent

### Naming Conventions

- Use lowercase with hyphens: `security-auditor`
- Be descriptive: `api-endpoint-analyzer` not `analyzer`
- Include domain: `python-test-writer` vs `test-writer`

### Organization

- Use **tags** to categorize agents: `security`, `testing`, `refactoring`
- Use **project agents** for project-specific needs
- Use **user agents** for reusable, generic agents

## Troubleshooting

### Agent Not Found

```bash
# Refresh the agent registry
meer agents list

# Check both scopes
meer agents show <name>
```

### Agent Not Working

1. Check if agent is enabled: `meer agents show <name>`
2. Verify the agent file is valid markdown with YAML frontmatter
3. Check file location matches the scope

### Tool Access Denied

If an agent tries to use a restricted tool, you'll see an error like:

```
Tool "propose_edit" is not allowed for agent "code-reviewer"
```

Solution: Edit the agent definition to include the required tool in the `tools` list.

## File Locations

- **Project agents**: `<project>/.meer/agents/*.md`
- **User agents**: `~/.meer/agents/*.md`
- **Templates**: `<meer-install>/src/agents/templates/*.md`

## Examples

### Example 1: Creating a Documentation Generator

```bash
meer agents create --scope project
```

Inputs:
- Name: `doc-generator`
- Description: `Generates README and API documentation for the codebase`
- Tools: Select "Read" only
- System Prompt:
  ```markdown
  # Documentation Generator

  Generate clear, comprehensive documentation including:
  - README with installation and usage
  - API documentation with examples
  - Code comments for complex functions

  Focus on clarity and completeness.
  ```
- Tags: `documentation, readme`

### Example 2: Creating a Performance Analyzer

```bash
meer agents create --scope user
```

Inputs:
- Name: `performance-analyzer`
- Description: `Analyzes code for performance bottlenecks and optimization opportunities`
- Tools: Select "Read" and "Bash"
- System Prompt:
  ```markdown
  # Performance Analyzer

  Analyze code for:
  - Algorithmic complexity
  - Database query efficiency
  - Memory usage patterns
  - Caching opportunities

  Provide specific optimization recommendations with examples.
  ```
- Tags: `performance, optimization`

## Advanced Topics

### Model Selection

By default, agents inherit the model from the main configuration:

```yaml
model: inherit  # Uses the configured model
```

You can also specify a different model per agent:

```yaml
model: sonnet   # Use Claude Sonnet
model: opus     # Use Claude Opus
model: haiku    # Use Claude Haiku (faster, cheaper)
```

### Max Iterations

Control how many thinking iterations the agent can perform:

```yaml
maxIterations: 5  # Default: 10
```

Lower values for simple tasks, higher for complex reasoning.

### Temperature

Adjust creativity vs. precision:

```yaml
temperature: 0.0  # Deterministic (good for code)
temperature: 0.7  # Balanced (default)
temperature: 1.0  # Creative (good for brainstorming)
```

## Further Reading

- [Implementation Plan](./SUB_AGENTS_IMPLEMENTATION_PLAN.md) - Technical architecture
- [API Documentation](./AGENTS_API.md) - For developers extending the system
- [Agent Templates](../src/agents/templates/) - Built-in agent examples

## Support

Found a bug or have a feature request?
Open an issue: https://github.com/meer-ai/meer/issues
