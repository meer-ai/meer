import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  formatSkillInvocation,
  formatSkillsForSystemPrompt,
  loadSkillsFromSources,
} from "@meer/coding-agent/skills/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "meer-skills-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function verifyProjectAndGlobalLoading(): Promise<void> {
  await withTempDir(async (root) => {
    const project = join(root, "project", ".meer", "skills", "review");
    const global = join(root, "global", "skills");
    await mkdir(project, { recursive: true });
    await mkdir(global, { recursive: true });

    await writeFile(
      join(project, "SKILL.md"),
      [
        "---",
        "name: review",
        "description: Use when reviewing code changes.",
        "---",
        "Read diffs before commenting.",
      ].join("\n")
    );
    await writeFile(
      join(global, "docs.md"),
      [
        "---",
        "name: docs",
        "description: Use when editing documentation.",
        "---",
        "Keep docs concise.",
      ].join("\n")
    );

    const result = await loadSkillsFromSources([
      { path: join(root, "project", ".meer", "skills"), source: "project" },
      { path: global, source: "global" },
    ]);

    assert.equal(result.skills.length, 2);
    assert.deepEqual(
      result.skills.map((skill) => `${skill.name}:${skill.source}`),
      ["review:project", "docs:global"]
    );
    assert.equal(result.diagnostics.length, 0);

    const prompt = formatSkillsForSystemPrompt(result.skills);
    assert.match(prompt, /<available_skills>/);
    assert.match(prompt, /<name>review<\/name>/);
    assert.doesNotMatch(prompt, /Read diffs before commenting/);

    const invocation = formatSkillInvocation(result.skills[0]!);
    assert.match(invocation, /Read diffs before commenting/);
    assert.match(invocation, /References are relative to/);
  });
}

async function verifyMetadataValidationAndPrecedence(): Promise<void> {
  await withTempDir(async (root) => {
    const project = join(root, "project");
    const global = join(root, "global");
    await mkdir(join(project, "same"), { recursive: true });
    await mkdir(join(global, "same"), { recursive: true });
    await mkdir(join(project, "bad"), { recursive: true });

    await writeFile(
      join(project, "same", "SKILL.md"),
      [
        "---",
        "name: same",
        "description: Project version wins.",
        "---",
        "project",
      ].join("\n")
    );
    await writeFile(
      join(global, "same", "SKILL.md"),
      [
        "---",
        "name: same",
        "description: Global duplicate loses.",
        "---",
        "global",
      ].join("\n")
    );
    await writeFile(join(project, "bad", "SKILL.md"), "No frontmatter body only");

    const result = await loadSkillsFromSources([
      { path: project, source: "project" },
      { path: global, source: "global" },
    ]);

    assert.equal(result.skills.length, 1);
    assert.equal(result.skills[0]?.description, "Project version wins.");
    assert.equal(result.skills[0]?.content, "project");
    assert.ok(result.diagnostics.some((d) => d.code === "invalid_metadata"));
    assert.ok(result.diagnostics.some((d) => d.code === "duplicate"));
  });
}

await verifyProjectAndGlobalLoading();
await verifyMetadataValidationAndPrecedence();
console.log("✅ Agent skills verified.");
