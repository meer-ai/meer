import { readFile, writeFile, unlink, readdir, stat, mkdir } from "fs/promises";
import { join, resolve } from "path";
import { existsSync } from "fs";
import { homedir } from "os";
import { parse as parseYaml } from "yaml";
import chalk from "chalk";
import { logVerbose } from "../logger.js";
import type { SubAgentDefinition, AgentScope, AgentDiscoveryResult } from "./types.js";

/**
 * AgentRegistry - Discovers and manages sub-agent definitions
 *
 * Agents are discovered from:
 * 1. Project-level: .meer/agents/ (highest priority)
 * 2. User-level: ~/.meer/agents/ (lower priority)
 * 3. Built-in templates: src/agents/templates/ (lowest priority)
 *
 * Agent files are markdown with YAML frontmatter:
 * ---
 * name: code-reviewer
 * description: Reviews code for quality
 * tools: [Read, Grep, Bash]
 * ---
 * # Agent prompt here
 */
export class AgentRegistry {
  private agents: Map<string, AgentDiscoveryResult> = new Map();
  private searchPaths: string[];
  private projectPath: string;
  private userPath: string;
  private templatesPath: string;

  constructor(cwd: string = process.cwd()) {
    this.projectPath = join(cwd, '.meer', 'agents');
    this.userPath = join(homedir(), '.meer', 'agents');
    this.templatesPath = join(import.meta.dirname, 'templates');

    this.searchPaths = [
      this.projectPath,    // Highest priority
      this.userPath,       // Medium priority
      this.templatesPath,  // Lowest priority (built-in templates)
    ];

    logVerbose(chalk.blue('[AgentRegistry] Initialized'));
    logVerbose(chalk.gray(`  Project: ${this.projectPath}`));
    logVerbose(chalk.gray(`  User: ${this.userPath}`));
    logVerbose(chalk.gray(`  Templates: ${this.templatesPath}`));
  }

  /**
   * Load all agents from search paths
   */
  async loadAgents(): Promise<void> {
    this.agents.clear();

    for (const searchPath of this.searchPaths) {
      await this.loadAgentsFromPath(searchPath);
    }

    logVerbose(chalk.green(`[AgentRegistry] Loaded ${this.agents.size} agents`));
  }

  /**
   * Refresh agents (reload from disk)
   */
  async refreshAgents(): Promise<void> {
    await this.loadAgents();
  }

  /**
   * Get a specific agent by name
   */
  getAgent(name: string): SubAgentDefinition | null {
    const result = this.agents.get(name);
    return result ? result.definition : null;
  }

  /**
   * Get all loaded agents
   */
  getAllAgents(): SubAgentDefinition[] {
    return Array.from(this.agents.values()).map(r => r.definition);
  }

  /**
   * Get all enabled agents
   */
  getEnabledAgents(): SubAgentDefinition[] {
    return this.getAllAgents().filter(agent => agent.enabled !== false);
  }

  /**
   * Search agents by query (searches name, description, tags)
   */
  searchAgents(query: string): SubAgentDefinition[] {
    const lowerQuery = query.toLowerCase();
    return this.getAllAgents().filter(agent => {
      return (
        agent.name.toLowerCase().includes(lowerQuery) ||
        agent.description.toLowerCase().includes(lowerQuery) ||
        agent.tags?.some(tag => tag.toLowerCase().includes(lowerQuery))
      );
    });
  }

  /**
   * Save an agent definition to disk
   */
  async saveAgent(definition: SubAgentDefinition, scope: AgentScope = 'project'): Promise<void> {
    const targetPath = scope === 'project' ? this.projectPath : this.userPath;

    // Ensure directory exists
    if (!existsSync(targetPath)) {
      await mkdir(targetPath, { recursive: true });
    }

    const filePath = join(targetPath, `${definition.name}.md`);
    const content = this.serializeAgent(definition);

    await writeFile(filePath, content, 'utf-8');

    logVerbose(chalk.green(`[AgentRegistry] Saved agent: ${definition.name} (${scope})`));

    // Reload agents to update cache
    await this.loadAgents();
  }

  /**
   * Delete an agent
   */
  async deleteAgent(name: string, scope: AgentScope): Promise<void> {
    const targetPath = scope === 'project' ? this.projectPath : this.userPath;
    const filePath = join(targetPath, `${name}.md`);

    if (existsSync(filePath)) {
      await unlink(filePath);
      logVerbose(chalk.yellow(`[AgentRegistry] Deleted agent: ${name} (${scope})`));

      // Reload agents to update cache
      await this.loadAgents();
    } else {
      throw new Error(`Agent not found: ${name} in ${scope} scope`);
    }
  }

  /**
   * Check if an agent exists
   */
  hasAgent(name: string): boolean {
    return this.agents.has(name);
  }

  /**
   * Get agent discovery result (includes metadata)
   */
  getAgentResult(name: string): AgentDiscoveryResult | null {
    return this.agents.get(name) || null;
  }

  // Private methods

  private async loadAgentsFromPath(searchPath: string): Promise<void> {
    if (!existsSync(searchPath)) {
      logVerbose(chalk.gray(`[AgentRegistry] Path does not exist: ${searchPath}`));
      return;
    }

    try {
      const files = await readdir(searchPath);
      const mdFiles = files.filter(f => f.endsWith('.md'));

      for (const file of mdFiles) {
        const filePath = join(searchPath, file);
        await this.loadAgentFile(filePath);
      }
    } catch (error) {
      logVerbose(chalk.red(`[AgentRegistry] Error loading from ${searchPath}: ${error}`));
    }
  }

  private async loadAgentFile(filePath: string): Promise<void> {
    try {
      const content = await readFile(filePath, 'utf-8');
      const definition = this.parseAgentFile(content);

      if (!definition) {
        logVerbose(chalk.yellow(`[AgentRegistry] Invalid agent file: ${filePath}`));
        return;
      }

      // Determine scope based on path
      const scope = this.determineScope(filePath);

      // Get file stats for metadata
      const stats = await stat(filePath);

      const result: AgentDiscoveryResult = {
        definition,
        filePath,
        scope,
        lastModified: stats.mtime,
      };

      // Only add if not already loaded with higher priority
      // (earlier paths in searchPaths have higher priority)
      if (!this.agents.has(definition.name)) {
        this.agents.set(definition.name, result);
        logVerbose(chalk.green(`[AgentRegistry] Loaded: ${definition.name} (${scope})`));
      } else {
        logVerbose(chalk.gray(`[AgentRegistry] Skipped (lower priority): ${definition.name} at ${filePath}`));
      }
    } catch (error) {
      logVerbose(chalk.red(`[AgentRegistry] Error loading ${filePath}: ${error}`));
    }
  }

  private parseAgentFile(content: string): SubAgentDefinition | null {
    // Split frontmatter and body
    const frontmatterRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
    const match = content.match(frontmatterRegex);

    if (!match) {
      return null;
    }

    const [, frontmatter, body] = match;

    try {
      const metadata = parseYaml(frontmatter) as Partial<SubAgentDefinition>;

      if (!metadata.name || !metadata.description) {
        return null;
      }

      const definition: SubAgentDefinition = {
        name: metadata.name,
        description: metadata.description,
        model: metadata.model || 'inherit',
        tools: metadata.tools,
        enabled: metadata.enabled !== false, // Default to enabled
        maxIterations: metadata.maxIterations,
        temperature: metadata.temperature,
        systemPrompt: body.trim(),
        author: metadata.author,
        version: metadata.version,
        tags: metadata.tags,
      };

      return definition;
    } catch (error) {
      logVerbose(chalk.red(`[AgentRegistry] YAML parse error: ${error}`));
      return null;
    }
  }

  private serializeAgent(definition: SubAgentDefinition): string {
    const frontmatter = {
      name: definition.name,
      description: definition.description,
      model: definition.model || 'inherit',
      tools: definition.tools,
      enabled: definition.enabled !== false,
      ...(definition.maxIterations && { maxIterations: definition.maxIterations }),
      ...(definition.temperature && { temperature: definition.temperature }),
      ...(definition.author && { author: definition.author }),
      ...(definition.version && { version: definition.version }),
      ...(definition.tags && { tags: definition.tags }),
    };

    const yamlContent = Object.entries(frontmatter)
      .map(([key, value]) => {
        if (Array.isArray(value)) {
          return `${key}:\n${value.map(v => `  - ${v}`).join('\n')}`;
        }
        return `${key}: ${value}`;
      })
      .join('\n');

    return `---\n${yamlContent}\n---\n\n${definition.systemPrompt}\n`;
  }

  private determineScope(filePath: string): AgentScope {
    const normalizedPath = resolve(filePath);

    if (normalizedPath.startsWith(resolve(this.projectPath))) {
      return 'project';
    } else if (normalizedPath.startsWith(resolve(this.userPath))) {
      return 'user';
    } else {
      // Built-in templates are treated as user scope
      return 'user';
    }
  }
}
