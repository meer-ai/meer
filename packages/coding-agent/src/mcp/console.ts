export function shouldLogMCPToConsole(): boolean {
  return (
    process.env.MEER_MCP_CONSOLE === "1" ||
    process.env.MCP_VERBOSE === "1" ||
    process.env.DEBUG === "1"
  );
}

