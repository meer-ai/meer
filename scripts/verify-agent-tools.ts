import assert from "node:assert/strict";
import { createMeerAgentTools } from "@meer-ai/coding-agent/agent/tools/agent.js";
import { runCommand } from "@meer-ai/coding-agent/tools/index.js";

const context = {
  cwd: process.cwd(),
  reviewFileEdit: async () => true,
  // Auto-approve shell commands so the background run_command path (now gated
  // through ensureCommandApproval) passes through without prompting.
  confirmCommand: async () => true,
  promptForm: async () => ({
    tech_stack: "next-postgres",
    priorities: ["events", "dashboards"],
  }),
  startBackgroundCommand: async (command: string, cwd: string) => ({
    id: "bg-test-1",
    status: "running" as const,
    command,
    cwd,
  }),
};

const toolkit = createMeerAgentTools(context);
const exportedNames = toolkit.map((tool) => tool.name).sort();

const expectedNames = [
  "analyze_project",
  "read_file",
  "list_files",
  "edit_file",
  "propose_edit",
  "run_command",
  "find_files",
  "read_many_files",
  "semantic_search",
  "google_search",
  "web_fetch",
  "save_memory",
  "load_memory",
  "grep",
  "delete_file",
  "move_file",
  "get_file_outline",
  "find_symbol_definition",
  "find_references",
  "request_user_input",
  "update_plan",
].sort();

const missing = expectedNames.filter((name) => !exportedNames.includes(name));
const unexpected = exportedNames.filter((name) => !expectedNames.includes(name));

assert.deepEqual(missing, [], `Missing tool wrappers: ${missing.join(", ")}`);
assert.deepEqual(
  unexpected,
  [],
  `Unexpected tool wrappers exported: ${unexpected.join(", ")}`
);

const requestUserInputTool = toolkit.find(
  (tool) => tool.name === "request_user_input"
);
assert(requestUserInputTool, "request_user_input tool should exist");

const questionnaireResult = await requestUserInputTool.call({
  title: "Project preferences",
  submitLabel: "Use these answers",
  questions: [
    {
      id: "tech_stack",
      label: "Choose the stack",
      type: "select",
      options: [
        { label: "Next.js + PostgreSQL", value: "next-postgres" },
        { label: "Express + React", value: "express-react" },
      ],
    },
    {
      id: "priorities",
      label: "Pick the MVP priorities",
      type: "multiselect",
      options: [
        { label: "Event ingestion", value: "events" },
        { label: "Dashboards", value: "dashboards" },
      ],
    },
  ],
});

assert.match(questionnaireResult, /"tech_stack": "next-postgres"/);
assert.match(questionnaireResult, /"priorities": \[/);

const runCommandTool = toolkit.find((tool) => tool.name === "run_command");
assert(runCommandTool, "run_command tool should exist");
// start_background_command folded into run_command(background:true)
const backgroundResult = await runCommandTool.call({
  command: "npm run dev",
  background: true,
});
assert.match(
  typeof backgroundResult === "string"
    ? backgroundResult
    : JSON.stringify(backgroundResult),
  /Started background terminal bg-test-1/
);

const updatePlanTool = toolkit.find((tool) => tool.name === "update_plan");
assert(updatePlanTool, "update_plan tool should exist");

const planResult = await updatePlanTool.call({
  op: "set",
  title: "Verify task ids",
  tasks: [{ description: "Inspect repo" }, { description: "Patch issue" }],
});
assert.match(planResult, /task-1/);
assert.match(planResult, /task-2/);

const updateVariants = ["1", "task-2", "Task 1", "task 2"];
for (const taskId of updateVariants) {
  const result = await updatePlanTool.call({
    op: "update",
    taskId,
    status: "in_progress",
  });
  assert.doesNotMatch(result, /not found/i, `task id variant should resolve: ${taskId}`);
}

const commandUpdates: string[] = [];
const commandResult = await runCommand(
  "node -e \"process.stdout.write('meer-command-ok')\"",
  process.cwd(),
  {
  silent: true,
  onUpdate: (partial) => commandUpdates.push(partial),
  }
);
assert.equal(commandResult.error, undefined);
assert.equal(commandResult.result.trim(), "meer-command-ok");
assert(commandUpdates.some((update) => update.includes("starting")));
assert(commandUpdates.some((update) => update.includes("completed")));

console.log("✅ Agent tool wrappers cover all core CLI tools.");
