import type { ToolRenderer } from "./types.js";
import { FileRenderer } from "./FileRenderer.js";
import { GenericRenderer } from "./GenericRenderer.js";
import { MutationRenderer } from "./MutationRenderer.js";
import { RunCommandRenderer } from "./RunCommandRenderer.js";
import { ShellRenderer } from "./ShellRenderer.js";
import { classifyTool } from "./utils.js";

type ToolRendererEntry = {
  match: (toolName: string) => boolean;
  render: ToolRenderer;
};

const toolRenderers: ToolRendererEntry[] = [
  {
    match: (toolName) => toolName.toLowerCase() === "run_command",
    render: RunCommandRenderer,
  },
  {
    match: (toolName) => classifyTool(toolName) === "mutation",
    render: MutationRenderer,
  },
  {
    match: (toolName) => classifyTool(toolName) === "file",
    render: FileRenderer,
  },
  {
    match: (toolName) => classifyTool(toolName) === "shell",
    render: ShellRenderer,
  },
];

export function getToolRenderer(toolName: string): ToolRenderer {
  return toolRenderers.find((entry) => entry.match(toolName))?.render ?? GenericRenderer;
}

export { classifyTool, isMutationTool } from "./utils.js";
export type { ToolRenderer, ToolRendererProps } from "./types.js";
