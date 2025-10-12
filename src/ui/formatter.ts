import { marked } from "marked";
// @ts-ignore - No types available
import { markedTerminal } from "marked-terminal";
import { highlight } from "cli-highlight";
import chalk from "chalk";
import boxen from "boxen";
// @ts-ignore - No types available
import Table from "cli-table3";

// Configure marked to use terminal renderer
marked.use(markedTerminal({
  code: (code: string, lang?: string) => {
    try {
      return highlight(code, {
        language: lang || "javascript",
        theme: {
          keyword: chalk.cyan,
          built_in: chalk.cyan,
          type: chalk.cyan.dim,
          literal: chalk.blue,
          number: chalk.green,
          regexp: chalk.red,
          string: chalk.yellow,
          subst: chalk.gray,
          symbol: chalk.blue,
          class: chalk.blue,
          function: chalk.yellow,
          title: chalk.blue,
          params: chalk.gray,
          comment: chalk.gray.dim,
          doctag: chalk.green,
          meta: chalk.gray,
          "meta-keyword": chalk.cyan,
          "meta-string": chalk.blue,
          section: chalk.bold,
          tag: chalk.gray,
          name: chalk.blue,
          "builtin-name": chalk.cyan,
          attr: chalk.yellow,
          attribute: chalk.yellow,
          variable: chalk.yellow,
          bullet: chalk.cyan,
          code: chalk.green,
          emphasis: chalk.italic,
          strong: chalk.bold,
          formula: chalk.blue,
          link: chalk.underline.blue,
          quote: chalk.gray.italic,
        },
      });
    } catch (e) {
      return code;
    }
  },
  blockquote: chalk.gray.italic,
  heading: chalk.bold.cyan,
  list: (body: string, ordered: boolean) => body,
  listitem: (text: string) => `  • ${text}`,
  paragraph: (text: string) => text,
  strong: chalk.bold,
  em: chalk.italic,
  codespan: chalk.cyan,
  link: (href: string, title: string, text: string) => chalk.underline.blue(text),
}) as any);

/**
 * Format markdown content for terminal display
 */
export function formatMarkdown(content: string): string {
  try {
    return marked(content) as string;
  } catch (e) {
    // Fallback to plain text if markdown parsing fails
    return content;
  }
}

/**
 * Create a pretty box for important messages
 */
export function createBox(message: string, options?: {
  title?: string;
  type?: "success" | "error" | "warning" | "info";
}): string {
  const { title, type = "info" } = options || {};

  let borderColor: "green" | "red" | "yellow" | "cyan";
  let titleColor: "green" | "red" | "yellow" | "cyan";

  switch (type) {
    case "success":
      borderColor = "green";
      titleColor = "green";
      break;
    case "error":
      borderColor = "red";
      titleColor = "red";
      break;
    case "warning":
      borderColor = "yellow";
      titleColor = "yellow";
      break;
    default:
      borderColor = "cyan";
      titleColor = "cyan";
  }

  const titleText = title ? chalk[titleColor].bold(title) : undefined;

  return boxen(message, {
    padding: 1,
    margin: 1,
    borderStyle: "round",
    borderColor,
    title: titleText as string | undefined,
    titleAlignment: "left",
  });
}

/**
 * Create a pretty table
 */
export function createTable(
  headers: string[],
  rows: string[][],
  options?: { compact?: boolean }
): string {
  const table = new Table({
    head: headers.map(h => chalk.cyan.bold(h)),
    style: {
      head: [],
      border: [],
      compact: options?.compact || false,
    },
    chars: {
      top: "─",
      "top-mid": "┬",
      "top-left": "┌",
      "top-right": "┐",
      bottom: "─",
      "bottom-mid": "┴",
      "bottom-left": "└",
      "bottom-right": "┘",
      left: "│",
      "left-mid": "├",
      mid: "─",
      "mid-mid": "┼",
      right: "│",
      "right-mid": "┤",
      middle: "│",
    },
  });

  rows.forEach(row => table.push(row));

  return table.toString();
}

/**
 * Format a code block with syntax highlighting
 */
export function formatCodeBlock(code: string, language: string = "javascript"): string {
  try {
    const highlighted = highlight(code, { language });
    return `\n${chalk.gray("┌─ Code:")}\n${highlighted}\n${chalk.gray("└─")}\n`;
  } catch (e) {
    return `\n${chalk.gray("┌─ Code:")}\n${code}\n${chalk.gray("└─")}\n`;
  }
}

/**
 * Format a list with proper indentation and bullets
 */
export function formatList(items: string[], options?: { ordered?: boolean; indent?: number }): string {
  const { ordered = false, indent = 0 } = options || {};
  const indentStr = " ".repeat(indent);

  return items
    .map((item, index) => {
      const bullet = ordered ? `${index + 1}.` : "•";
      return `${indentStr}${chalk.cyan(bullet)} ${item}`;
    })
    .join("\n");
}

/**
 * Format an error message
 */
export function formatError(error: string, context?: string): string {
  let message = chalk.red.bold("❌ Error: ") + chalk.red(error);

  if (context) {
    message += `\n${chalk.gray("Context:")} ${chalk.dim(context)}`;
  }

  return message;
}

/**
 * Format a success message
 */
export function formatSuccess(message: string): string {
  return chalk.green.bold("✓ ") + chalk.green(message);
}

/**
 * Format a warning message
 */
export function formatWarning(message: string): string {
  return chalk.yellow.bold("⚠ ") + chalk.yellow(message);
}

/**
 * Format an info message
 */
export function formatInfo(message: string): string {
  return chalk.blue.bold("ℹ ") + chalk.blue(message);
}

/**
 * Create a section header
 */
export function createSection(title: string, content?: string): string {
  const header = chalk.cyan.bold(`\n▼ ${title}`);
  const separator = chalk.gray("─".repeat(Math.min(title.length + 2, 50)));

  if (content) {
    return `${header}\n${separator}\n${content}\n`;
  }

  return `${header}\n${separator}\n`;
}

/**
 * Format validation results
 */
export function formatValidationResults(
  results: Array<{ name: string; status: "passed" | "failed" | "skipped"; message?: string }>
): string {
  const lines: string[] = [];

  results.forEach(result => {
    let icon: string;
    let coloredIcon: string;

    switch (result.status) {
      case "passed":
        icon = "✓";
        coloredIcon = chalk.green(icon);
        break;
      case "failed":
        icon = "✗";
        coloredIcon = chalk.red(icon);
        break;
      case "skipped":
        icon = "⊘";
        coloredIcon = chalk.gray(icon);
        break;
    }

    const line = `  ${coloredIcon} ${result.name}`;
    lines.push(line);

    if (result.message) {
      lines.push(`    ${chalk.dim(result.message)}`);
    }
  });

  return lines.join("\n");
}
