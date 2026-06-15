# Model Context Protocol (MCP) Guide

## Overview

Meer AI includes production-ready support for the Model Context Protocol (MCP), enabling powerful integrations with external tools and services. MCP allows AI agents to securely access data and functionality from various sources.

## Prerequisites

Some MCP servers are Python-based and require `uv` (Universal Virtualenv) to be installed.

**✨ Automatic Detection** - Meer AI will automatically detect if `uvx` is missing and provide platform-specific installation instructions when you run:
- `meer mcp setup`
- `meer mcp status`
- `meer mcp connect <server-name>`

### Manual Installation (Optional)

If you want to install `uvx` ahead of time:

```bash
# macOS (Homebrew - Recommended)
brew install uv

# macOS/Linux (Official installer)
curl -LsSf https://astral.sh/uv/install.sh | sh

# Windows (PowerShell)
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"

# Windows (winget)
winget install --id=astral-sh.uv -e

# Linux (using pip)
pip install uv
```

After installation, restart your terminal for `uvx` to be available.

## Quick Start

### 1. Interactive Setup

The easiest way to get started is with the interactive setup wizard:

```bash
meer mcp setup
```

This will guide you through:
- Viewing available MCP servers by category
- Enabling recommended servers
- Configuring API keys and credentials

### 2. Enable Recommended Servers

For most developers, the recommended set includes:
- **filesystem**: Secure file operations
- **git**: Git repository operations
- **memory**: Persistent knowledge graph
- **fetch**: Web content fetching
- **time**: Time and timezone utilities

```bash
# Quick enable via setup wizard
meer mcp setup
# Select "Enable recommended servers"
```

### 3. Verify Connection

Check that your servers are connected:

```bash
meer mcp status
```

## Available MCP Servers

### Core Development Tools

#### filesystem
**Status**: ✅ Enabled by default
**Description**: Secure file operations with configurable access controls
**Use cases**: Read, write, search files within allowed directories

**Configuration**:
```yaml
filesystem:
  command: npx
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users/yourname/projects']
  enabled: true
  timeout: 30000
```

#### git
**Status**: ✅ Enabled by default (requires `uvx`)
**Description**: Git repository operations (status, diff, commit, log)
**Use cases**: View git status, create commits, review diffs, browse history

**Installation**:
```bash
# Runs automatically via uvx (no installation needed)
uvx mcp-server-git
```

**Tools provided**:
- `git.status` - Show repository status
- `git.diff` - View changes
- `git.log` - Browse commit history
- `git.commit` - Create commits

#### github
**Status**: ⚙️ Requires API key
**Description**: GitHub API integration (repos, issues, PRs, search)
**Use cases**: Search repositories, manage issues, review pull requests

**Setup**:
```bash
# 1. Create a GitHub Personal Access Token
# 2. Set environment variable
export GITHUB_TOKEN="ghp_your_token_here"

# 3. Enable the server
meer mcp enable github
```

### Knowledge & Memory

#### memory
**Status**: ✅ Enabled by default
**Description**: Knowledge graph-based persistent memory system
**Use cases**: Store and retrieve context across sessions, build knowledge graphs

**Tools provided**:
- `memory.store` - Store information
- `memory.retrieve` - Query stored knowledge
- `memory.relate` - Create relationships

### Web & Content

#### fetch
**Status**: ✅ Enabled by default (requires `uvx`)
**Description**: Web content fetching and conversion to markdown
**Use cases**: Fetch web pages, convert HTML to markdown, extract content

**Installation**:
```bash
# Runs automatically via uvx (no installation needed)
uvx mcp-server-fetch
```

**Example usage**:
```
# In chat
> Fetch the latest news from example.com/news
```

#### brave
**Status**: ⚙️ Requires API key
**Description**: Web search using Brave Search API
**Use cases**: Search the web directly from AI

**Setup**:
```bash
# 1. Get API key from https://brave.com/search/api/
export BRAVE_API_KEY="your_api_key"

# 2. Enable the server
meer mcp enable brave
```

#### puppeteer
**Status**: 💻 Resource-intensive (disabled by default)
**Description**: Browser automation and web scraping
**Use cases**: Take screenshots, fill forms, navigate pages

**Note**: This server launches a headless browser and is resource-intensive. Enable only when needed.

### Collaboration

#### slack
**Status**: ⚙️ Requires API tokens
**Description**: Slack integration (channels, messages, users)
**Use cases**: Send messages, search history, manage channels

**Setup**:
```bash
export SLACK_BOT_TOKEN="xoxb-your-bot-token"
export SLACK_TEAM_ID="T01234567"
meer mcp enable slack
```

#### google-drive
**Status**: ⚙️ Requires OAuth setup
**Description**: Google Drive file access and management
**Use cases**: Read, write, search files in Google Drive

**Setup requires OAuth 2.0 credentials** - see [Google Cloud Console](https://console.cloud.google.com)

### Database

#### postgres
**Status**: ⚙️ Requires database connection
**Description**: PostgreSQL database queries and schema inspection
**Use cases**: Query databases, inspect schemas, analyze data

**Setup**:
```bash
export POSTGRES_CONNECTION_STRING="postgresql://user:pass@localhost:5432/dbname"
meer mcp enable postgres
```

#### sqlite
**Status**: ⚙️ Requires database path
**Description**: SQLite database operations
**Use cases**: Query SQLite databases, inspect schemas

**Setup**:
```bash
export SQLITE_DB_PATH="/path/to/your/database.db"
meer mcp enable sqlite
```

### Utilities

#### time
**Status**: ✅ Enabled by default (requires `uvx`)
**Description**: Time and timezone conversion capabilities
**Use cases**: Convert between timezones, format dates, calculate durations

**Installation**:
```bash
# Runs automatically via uvx (no installation needed)
uvx mcp-server-time
```

#### sequential_thinking
**Status**: 🧠 Advanced feature (disabled by default)
**Description**: Dynamic problem-solving through thought sequences
**Use cases**: Complex reasoning tasks, step-by-step problem solving

## MCP Commands Reference

### List Servers

View all configured MCP servers and their status:

```bash
meer mcp list
```

### View Available Tools

See all tools provided by connected servers:

```bash
meer mcp tools
```

### View Available Resources

List resources exposed by MCP servers:

```bash
meer mcp resources
```

### Check Status

Check connection status of all servers:

```bash
meer mcp status
```

### Add a Custom Server

Add any MCP server that isn't in the defaults (e.g. Supabase) without hand-editing
the config file. The target is positional — pass a **URL** for a remote server or
a **command** for a stdio server:

```bash
# remote server (URL auto-detected) — transport accepts http/sse/ws/stdio aliases
meer mcp add supabase "https://mcp.supabase.com/mcp?project_ref=YOUR_REF" --transport http

# stdio server (command + args)
meer mcp add fs npx @modelcontextprotocol/server-filesystem ~/code

# if any command arg starts with a dash (e.g. -y), put `--` before the args
meer mcp add fs -- npx -y @modelcontextprotocol/server-filesystem ~/code
```

You can also be explicit with `--url` or `--command`/`--args` instead of the
positional target. Other options: `--transport` (`http`, `sse`, `ws`, `stdio`),
`--env KEY=VALUE` (repeatable), `--header KEY=VALUE` (repeatable),
`--description`, `--timeout <ms>`, `--oauth`/`--scope` (see below), and `--disabled`.

> **Secrets:** `${VAR}` placeholders are resolved from environment variables, but
> **only** inside `--env`, `--header`, and `--url` — never inside `--args`. Put
> tokens in `--env` and export them in your shell. New servers are enabled by
> default; pass `--disabled` to add without enabling.

### Remove a Server

```bash
meer mcp remove <server-name>   # alias: meer mcp rm
```

### Authenticate with OAuth (remote servers)

Many hosted MCP servers (Supabase, Notion, Linear, GitHub's remote server, …)
require an OAuth sign-in instead of a static token. Add the server with `--oauth`,
then run `login`:

```bash
# 1. Add the remote server and mark it OAuth-backed
meer mcp add notion \
  --url https://mcp.notion.com/mcp \
  --oauth \
  --description "Notion workspace"

# 2. Sign in — opens your browser, captures the redirect, stores tokens
meer mcp login notion

# Later, to revoke locally:
meer mcp logout notion
```

How it works:
- `login` starts a temporary loopback server, opens the consent page in your
  browser, performs OAuth 2.1 with PKCE and Dynamic Client Registration, and
  stores the resulting tokens at `~/.meer/mcp-auth/<server>.json` (permissions `0600`).
- Subsequent connections attach the stored token automatically and refresh it
  when it expires — no re-login needed until the refresh token is revoked.
- If an OAuth server is used before you log in, Meer fails with a clear message
  telling you to run `meer mcp login <server>`.
- `meer mcp list` shows whether each OAuth server is currently signed in.

> Use `--scope "<scopes>"` on `meer mcp add` to request specific OAuth scopes.
> OAuth applies only to remote (`--url`) servers, not stdio (`--command`) servers.

**Scopes are provider-specific.** Each server defines its own valid scope values
and they are space-separated. For example, Supabase expects scopes like
`projects:read projects:write database:read database:write storage:read` — not a
single generic value. If you pass an unsupported scope, login fails with the
server's message listing the accepted values. When unsure, omit `--scope` and
grant access on the consent screen.

To change a server's scope (or any field) without removing it, use `edit`:

```bash
meer mcp edit supabase --scope "projects:read projects:write database:read"
meer mcp login supabase   # re-run after changing OAuth settings
```

Changing the scope clears any stored credentials so the next `login` re-registers
cleanly.

### Enable/Disable Servers

```bash
# Enable a server
meer mcp enable <server-name>

# Disable a server
meer mcp disable <server-name>

# Examples
meer mcp enable github
meer mcp disable puppeteer
```

### Connect/Disconnect

```bash
# Connect to a specific server
meer mcp connect <server-name>

# Disconnect from a server
meer mcp disconnect <server-name>
```

### Setup Wizard

Run the interactive setup wizard:

```bash
meer mcp setup
```

### Reset Configuration

Reset MCP configuration to defaults:

```bash
# With confirmation prompt
meer mcp reset

# Skip confirmation
meer mcp reset --force
```

## Configuration

### Configuration File Location

MCP configuration is stored at: `~/.meer/mcp-config.yaml`

### Example Configuration

```yaml
mcpServers:
  filesystem:
    command: npx
    args:
      - -y
      - '@modelcontextprotocol/server-filesystem'
      - /Users/yourname/projects
    enabled: true
    description: Secure file operations with configurable access controls
    timeout: 30000

  git:
    command: uvx
    args:
      - mcp-server-git
      - --repository
      - /path/to/your/repo
    enabled: true
    description: Git repository operations
    timeout: 30000

  fetch:
    command: uvx
    args:
      - mcp-server-fetch
    enabled: true
    description: Web content fetching and conversion to markdown
    timeout: 30000

  github:
    command: npx
    args:
      - -y
      - '@modelcontextprotocol/server-github'
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: ${GITHUB_TOKEN}
    enabled: false
    description: GitHub API integration
    timeout: 30000

mcp:
  autoStart: true
  timeout: 30000
  maxRetries: 3
  cacheTools: true
  logLevel: info
```

### Environment Variables

MCP servers use environment variables for sensitive credentials:

```bash
# Add to ~/.bashrc, ~/.zshrc, or ~/.profile

# GitHub
export GITHUB_TOKEN="ghp_your_token"

# Brave Search
export BRAVE_API_KEY="your_brave_key"

# Slack
export SLACK_BOT_TOKEN="xoxb-your-token"
export SLACK_TEAM_ID="T01234567"

# Google Drive
export GDRIVE_CLIENT_ID="your_client_id"
export GDRIVE_CLIENT_SECRET="your_secret"
export GDRIVE_REDIRECT_URI="http://localhost:8080"

# PostgreSQL
export POSTGRES_CONNECTION_STRING="postgresql://user:pass@localhost/db"
```

## Advanced Usage

### Custom MCP Servers

You can add custom MCP servers to the configuration:

```yaml
mcpServers:
  my-custom-server:
    command: node
    args:
      - /path/to/my-server/index.js
    enabled: true
    description: My custom MCP server
    timeout: 30000
```

### URL-based Servers

Some MCP servers connect via HTTP/WebSocket:

```yaml
mcpServers:
  remote-server:
    url: http://localhost:3000/mcp
    transport: streaming-http  # or 'websocket'
    enabled: true
    description: Remote MCP server
    timeout: 30000
```

### Timeout Configuration

Adjust timeouts for slow operations:

```yaml
mcpServers:
  puppeteer:
    command: npx
    args: ['-y', '@modelcontextprotocol/server-puppeteer']
    enabled: true
    timeout: 60000  # 60 seconds for browser operations
```

## Troubleshooting

### uvx Command Not Found

If you see errors like "uvx: command not found", you need to install `uv`:

```bash
# Install uv
curl -LsSf https://astral.sh/uv/install.sh | sh

# Or with Homebrew (macOS)
brew install uv

# Restart your terminal after installation
```

The following servers require `uvx`:
- fetch
- git
- time

### Server Won't Connect

1. Check if the server is enabled:
   ```bash
   meer mcp list
   ```

2. Verify environment variables are set:
   ```bash
   echo $GITHUB_TOKEN  # Should output your token
   ```

3. Check server status for error messages:
   ```bash
   meer mcp status
   ```

4. Try connecting manually:
   ```bash
   meer mcp connect <server-name>
   ```

### API Key Issues

- Ensure environment variables are exported in your shell
- Restart your terminal after adding new environment variables
- Check that API keys have the required permissions

### Performance Issues

- Disable resource-intensive servers (puppeteer) when not needed
- Reduce the number of enabled servers
- Increase timeout values for slow operations

### Network Errors

- Check your internet connection
- Verify firewall settings
- Some MCP servers may require proxy configuration

## Best Practices

1. **Enable only what you need**: Each MCP server uses resources. Enable only the servers you actively use.

2. **Secure your API keys**: Never commit API keys to version control. Use environment variables.

3. **Use the memory server**: The knowledge graph can significantly improve AI context across sessions.

4. **Configure appropriate timeouts**: Set higher timeouts for operations you know will be slow (e.g., browser automation).

5. **Monitor resource usage**: Some servers (like puppeteer) can be resource-intensive.

6. **Regular updates**: Keep MCP servers updated:
   ```bash
   # MCP servers will auto-update when using npx -y
   ```

## Examples

### Using GitHub Integration

```
# In Meer AI chat
> Search GitHub for TypeScript MCP servers
> Create an issue in my-org/my-repo about the bug I mentioned
> Show me open PRs in anthropics/anthropic-sdk-typescript
```

### Using Memory

```
> Remember that our API endpoint is https://api.example.com/v2
> What was the API endpoint I mentioned earlier?
> Store this code pattern for future reference
```

### Using Web Fetch

```
> Fetch and summarize the documentation from https://docs.example.com
> Get the latest release notes from the GitHub releases page
```

## Additional Resources

- [MCP Official Documentation](https://docs.claude.com/en/docs/mcp)
- [MCP Server Repository](https://github.com/modelcontextprotocol/servers)
- [Building Custom MCP Servers](https://github.com/modelcontextprotocol/sdk)

## Support

For issues or questions about MCP integration in Meer AI:
- Check the troubleshooting section above
- Run `meer mcp status` for detailed server information
- Review logs with `MCP_VERBOSE=1 meer` for detailed debugging
