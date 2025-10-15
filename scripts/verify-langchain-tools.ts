import assert from "node:assert/strict";
import { createMeerLangChainTools } from "../src/agent/tools/langchain.js";

const context = {
  cwd: process.cwd(),
  reviewFileEdit: async () => true,
};

const toolkit = createMeerLangChainTools(context);
const exportedNames = toolkit.map((tool) => tool.name).sort();

const expectedNames = [
  "analyze_project",
  "read_file",
  "list_files",
  "propose_edit",
  "run_command",
  "find_files",
  "read_many_files",
  "search_text",
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

console.log("✅ LangChain tool wrappers cover all core CLI tools.");
