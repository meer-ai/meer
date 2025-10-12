import chalk from "chalk";
import { formatMarkdown, formatCodeBlock } from "./formatter.js";

/**
 * Process AI response and apply formatting
 * This handles markdown rendering for streamed responses
 */
export class ResponseFormatter {
  private buffer: string = "";
  private inCodeBlock = false;
  private codeBlockContent = "";
  private codeBlockLang = "";
  private lastWasNewline = true;

  /**
   * Process a chunk of streamed response
   */
  processChunk(chunk: string): string {
    this.buffer += chunk;

    // Look for complete markdown blocks
    const output: string[] = [];

    // Split by newlines to process line by line
    const lines = this.buffer.split("\n");

    // Keep last incomplete line in buffer
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      const processed = this.processLine(line);
      if (processed !== null) {
        output.push(processed);
      }
    }

    return output.join("\n");
  }

  /**
   * Flush remaining buffer
   */
  flush(): string {
    if (this.buffer) {
      const processed = this.processLine(this.buffer);
      this.buffer = "";
      return processed || "";
    }
    return "";
  }

  /**
   * Process a single line
   */
  private processLine(line: string): string | null {
    // Detect code block start/end
    const codeBlockMatch = line.match(/^```(\w*)$/);

    if (codeBlockMatch) {
      if (!this.inCodeBlock) {
        // Start of code block
        this.inCodeBlock = true;
        this.codeBlockLang = codeBlockMatch[1] || "text";
        this.codeBlockContent = "";
        return null; // Don't output the fence
      } else {
        // End of code block - format and output
        this.inCodeBlock = false;
        const formatted = formatCodeBlock(this.codeBlockContent.trim(), this.codeBlockLang);
        this.codeBlockContent = "";
        this.codeBlockLang = "";
        return formatted;
      }
    }

    // Accumulate code block content
    if (this.inCodeBlock) {
      this.codeBlockContent += line + "\n";
      return null;
    }

    // Format inline code
    const withInlineCode = line.replace(/`([^`]+)`/g, (_, code) => chalk.cyan(code));

    // Format bold
    const withBold = withInlineCode.replace(/\*\*([^*]+)\*\*/g, (_, text) => chalk.bold(text));

    // Format italic
    const withItalic = withBold.replace(/\*([^*]+)\*/g, (_, text) => chalk.italic(text));

    // Format lists
    if (line.match(/^\s*[-*]\s+/)) {
      const formatted = line.replace(/^(\s*)([-*])\s+(.+)$/, (_, indent, bullet, text) => {
        return `${indent}${chalk.cyan("•")} ${text}`;
      });
      return withItalic.replace(line, formatted);
    }

    // Format headers
    if (line.match(/^#+\s+/)) {
      const formatted = line.replace(/^(#+)\s+(.+)$/, (_, hashes, text) => {
        return chalk.bold.cyan(text);
      });
      return formatted;
    }

    return withItalic;
  }

  /**
   * Reset the formatter state
   */
  reset(): void {
    this.buffer = "";
    this.inCodeBlock = false;
    this.codeBlockContent = "";
    this.codeBlockLang = "";
    this.lastWasNewline = true;
  }
}

/**
 * Format a complete response (non-streamed)
 */
export function formatCompleteResponse(response: string): string {
  const formatter = new ResponseFormatter();

  // Process the entire response
  const lines = response.split("\n");
  const output: string[] = [];

  for (const line of lines) {
    const result = formatter.processChunk(line + "\n");
    if (result) {
      output.push(result);
    }
  }

  // Flush any remaining content
  const final = formatter.flush();
  if (final) {
    output.push(final);
  }

  return output.join("\n");
}
