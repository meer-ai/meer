import assert from "node:assert/strict";
import { createMeerAgentTools } from "@meer/coding-agent/agent/tools/agent.js";
import { runCommand } from "@meer/coding-agent/tools/index.js";

const context = {
  cwd: process.cwd(),
  reviewFileEdit: async () => true,
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
  "suggest_setup",
  "read_file",
  "list_files",
  "edit_file",
  "propose_edit",
  "run_command",
  "find_files",
  "read_many_files",
  "search_text",
  "semantic_search",
  "read_folder",
  "google_search",
  "web_fetch",
  "save_memory",
  "load_memory",
  "grep",
  "edit_line",
  "git_status",
  "git_diff",
  "git_log",
  "git_commit",
  "git_branch",
  "write_file",
  "delete_file",
  "move_file",
  "create_directory",
  "package_install",
  "package_run_script",
  "package_list",
  "scaffold_project",
  "get_env",
  "set_env",
  "list_env",
  "http_request",
  "get_file_outline",
  "find_symbol_definition",
  "check_syntax",
  "validate_project",
  "set_plan",
  "update_plan_task",
  "show_plan",
  "clear_plan",
  "request_user_input",
  "start_background_command",
  "explain_code",
  "generate_docstring",
  "format_code",
  "dependency_audit",
  "run_tests",
  "generate_tests",
  "security_scan",
  "code_review",
  "generate_readme",
  "fix_lint",
  "organize_imports",
  "check_complexity",
  "detect_smells",
  "analyze_coverage",
  "find_references",
  "generate_test_suite",
  "generate_mocks",
  "generate_api_docs",
  "git_blame",
  "rename_symbol",
  "extract_function",
  "extract_variable",
  "inline_variable",
  "move_symbol",
  "convert_to_async",
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

const backgroundCommandTool = toolkit.find(
  (tool) => tool.name === "start_background_command"
);
assert(backgroundCommandTool, "start_background_command tool should exist");
const backgroundResult = await backgroundCommandTool.call({
  command: "npm run dev",
});
assert.match(backgroundResult, /Started background terminal bg-test-1/);

const setPlanTool = toolkit.find((tool) => tool.name === "set_plan");
const updatePlanTaskTool = toolkit.find((tool) => tool.name === "update_plan_task");
assert(setPlanTool, "set_plan tool should exist");
assert(updatePlanTaskTool, "update_plan_task tool should exist");

const planResult = await setPlanTool.call({
  title: "Verify task ids",
  tasks: ["Inspect repo", "Patch issue"],
});
assert.match(planResult, /task-1/);
assert.match(planResult, /task-2/);

const updateVariants = ["1", "task-2", "Task 1", "task 2"];
for (const taskId of updateVariants) {
  const result = await updatePlanTaskTool.call({
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
