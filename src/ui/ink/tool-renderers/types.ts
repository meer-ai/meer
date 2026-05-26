import type React from "react";

export type ToolRendererProps = {
  toolName: string;
  content: string;
  args?: Record<string, unknown>;
  details?: Record<string, unknown>;
  isError?: boolean;
};

export type ToolRenderer = React.FC<ToolRendererProps>;
