import type { Skill } from "./types.js";

export function formatSkillsForSystemPrompt(skills: Skill[]): string {
  const visible = skills.filter((skill) => !skill.disableModelInvocation);
  if (visible.length === 0) return "";

  const lines = [
    "## Agent Skills",
    "",
    "Skills provide specialized instructions for specific task types.",
    "When the user request matches a skill description, call `load_skill` with that skill name before doing the task.",
    "Do not claim you used a skill unless `load_skill` succeeded.",
    "When a loaded skill references relative files, resolve them from the skill directory.",
    "",
    "<available_skills>",
  ];

  for (const skill of visible) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push(`    <source>${escapeXml(skill.source)}</source>`);
    lines.push("  </skill>");
  }

  lines.push("</available_skills>");
  return lines.join("\n");
}

export function formatSkillInvocation(skill: Skill): string {
  return [
    `<skill name="${escapeXml(skill.name)}" location="${escapeXml(skill.filePath)}">`,
    `References are relative to ${escapeXml(dirname(skill.filePath))}.`,
    "",
    skill.content,
    "</skill>",
  ].join("\n");
}

function dirname(filePath: string): string {
  const normalized = filePath.replace(/\/+$/, "");
  const slash = normalized.lastIndexOf("/");
  return slash <= 0 ? "/" : normalized.slice(0, slash);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
