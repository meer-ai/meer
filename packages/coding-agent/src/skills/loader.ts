import { readdir, readFile, stat } from "fs/promises";
import { existsSync } from "fs";
import type { Dirent } from "fs";
import { basename, dirname, extname, join, resolve, delimiter } from "path";
import { homedir } from "os";
import { parse as parseYaml } from "yaml";
import type {
  Skill,
  SkillDiagnostic,
  SkillLoadResult,
  SkillSource,
} from "./types.js";

const MAX_NAME_LENGTH = 128;
const MAX_DESCRIPTION_LENGTH = 1536;
const SKILL_NAME_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const DEFAULT_IGNORES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  ".next",
]);

interface SkillFrontmatter {
  name?: unknown;
  description?: unknown;
  "disable-model-invocation"?: unknown;
  disableModelInvocation?: unknown;
}

export function defaultSkillSources(cwd: string): Array<{ path: string; source: SkillSource }> {
  const sources: Array<{ path: string; source: SkillSource }> = [
    { path: join(cwd, ".meer", "skills"), source: "project" },
    { path: join(homedir(), ".meer", "skills"), source: "global" },
  ];

  const extra = process.env.MEER_SKILLS_PATH;
  if (extra?.trim()) {
    for (const entry of extra.split(delimiter)) {
      const path = expandHome(entry.trim());
      if (path) sources.push({ path, source: "env" });
    }
  }

  return sources;
}

export async function loadSkillsForCwd(cwd: string): Promise<SkillLoadResult> {
  return loadSkillsFromSources(defaultSkillSources(cwd));
}

export async function loadSkillsFromSources(
  sources: Array<{ path: string; source: SkillSource }>
): Promise<SkillLoadResult> {
  const skills: Skill[] = [];
  const diagnostics: SkillDiagnostic[] = [];
  const loadedSources: string[] = [];
  const seen = new Map<string, Skill>();

  for (const source of sources) {
    const root = resolve(expandHome(source.path));
    if (!existsSync(root)) continue;
    loadedSources.push(root);

    const result = await loadSkillsFromDir(root, source.source, true);
    diagnostics.push(...result.diagnostics);

    for (const skill of result.skills) {
      const key = skill.name.toLowerCase();
      if (seen.has(key)) {
        diagnostics.push({
          type: "warning",
          code: "duplicate",
          message: `Skill "${skill.name}" ignored because "${seen.get(key)?.filePath}" was already loaded first.`,
          path: skill.filePath,
          source: skill.source,
        });
        continue;
      }
      seen.set(key, skill);
      skills.push(skill);
    }
  }

  return { skills, diagnostics, sources: loadedSources };
}

async function loadSkillsFromDir(
  dir: string,
  source: SkillSource,
  includeRootMarkdown: boolean
): Promise<{ skills: Skill[]; diagnostics: SkillDiagnostic[] }> {
  const skills: Skill[] = [];
  const diagnostics: SkillDiagnostic[] = [];

  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    diagnostics.push({
      type: "warning",
      code: "read_failed",
      message: error instanceof Error ? error.message : String(error),
      path: dir,
      source,
    });
    return { skills, diagnostics };
  }

  const directSkill = entries.find((entry) => entry.isFile() && entry.name === "SKILL.md");
  if (directSkill) {
    const result = await loadSkillFile(join(dir, directSkill.name), source);
    if (result.skill) skills.push(result.skill);
    diagnostics.push(...result.diagnostics);
    return { skills, diagnostics };
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (DEFAULT_IGNORES.has(entry.name)) continue;
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      const result = await loadSkillsFromDir(fullPath, source, false);
      skills.push(...result.skills);
      diagnostics.push(...result.diagnostics);
      continue;
    }

    if (!includeRootMarkdown || !entry.isFile() || extname(entry.name) !== ".md") {
      continue;
    }

    const result = await loadSkillFile(fullPath, source);
    if (result.skill) skills.push(result.skill);
    diagnostics.push(...result.diagnostics);
  }

  return { skills, diagnostics };
}

async function loadSkillFile(
  filePath: string,
  source: SkillSource
): Promise<{ skill: Skill | null; diagnostics: SkillDiagnostic[] }> {
  const diagnostics: SkillDiagnostic[] = [];
  let raw = "";
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    diagnostics.push({
      type: "warning",
      code: "read_failed",
      message: error instanceof Error ? error.message : String(error),
      path: filePath,
      source,
    });
    return { skill: null, diagnostics };
  }

  const parsed = parseFrontmatter(raw);
  if (!parsed.ok) {
    diagnostics.push({
      type: "warning",
      code: "parse_failed",
      message: parsed.error.message,
      path: filePath,
      source,
    });
    return { skill: null, diagnostics };
  }

  const { frontmatter, body } = parsed.value;
  const fallbackName =
    basename(filePath) === "SKILL.md"
      ? basename(dirname(filePath))
      : basename(filePath, extname(filePath));
  const name =
    typeof frontmatter.name === "string" && frontmatter.name.trim()
      ? frontmatter.name.trim()
      : fallbackName;
  const description =
    typeof frontmatter.description === "string"
      ? frontmatter.description.trim()
      : "";

  for (const message of validateName(name)) {
    diagnostics.push({
      type: "warning",
      code: "invalid_metadata",
      message,
      path: filePath,
      source,
    });
  }
  for (const message of validateDescription(description)) {
    diagnostics.push({
      type: "warning",
      code: "invalid_metadata",
      message,
      path: filePath,
      source,
    });
  }

  if (!SKILL_NAME_RE.test(name) || !description) {
    return { skill: null, diagnostics };
  }

  return {
    skill: {
      name,
      description,
      content: body.trim(),
      filePath,
      source,
      disableModelInvocation:
        frontmatter["disable-model-invocation"] === true ||
        frontmatter.disableModelInvocation === true,
    },
    diagnostics,
  };
}

function parseFrontmatter(
  content: string
): { ok: true; value: { frontmatter: SkillFrontmatter; body: string } } | { ok: false; error: Error } {
  try {
    const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (!normalized.startsWith("---\n")) {
      return { ok: true, value: { frontmatter: {}, body: normalized } };
    }
    const end = normalized.indexOf("\n---", 4);
    if (end === -1) {
      return { ok: true, value: { frontmatter: {}, body: normalized } };
    }
    const yaml = normalized.slice(4, end);
    const body = normalized.slice(end + 4).replace(/^\n/, "");
    return {
      ok: true,
      value: {
        frontmatter: (parseYaml(yaml) ?? {}) as SkillFrontmatter,
        body,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

function validateName(name: string): string[] {
  const errors: string[] = [];
  if (!name) errors.push("name is required");
  if (name.length > MAX_NAME_LENGTH) {
    errors.push(`name exceeds ${MAX_NAME_LENGTH} characters`);
  }
  if (!SKILL_NAME_RE.test(name)) {
    errors.push("name must match ^[a-zA-Z0-9_-]{1,128}$");
  }
  return errors;
}

function validateDescription(description: string): string[] {
  if (!description) return ["description is required"];
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return [`description exceeds ${MAX_DESCRIPTION_LENGTH} characters`];
  }
  return [];
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
