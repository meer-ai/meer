/**
 * Bridges meer's hex palette (src/ui/theme.ts) to the style-function themes
 * the vendored pi-tui components expect. All styling is plain chalk — the
 * renderer works with already-styled strings.
 */

import chalk from "chalk";
import { getTheme } from "../theme.js";
import type { EditorTheme } from "../tui/components/editor.js";
import type { MarkdownTheme } from "../tui/components/markdown.js";
import type { SelectListTheme } from "../tui/components/select-list.js";

export interface TuiStyles {
  accent: (text: string) => string;
  primary: (text: string) => string;
  success: (text: string) => string;
  warning: (text: string) => string;
  danger: (text: string) => string;
  info: (text: string) => string;
  text: (text: string) => string;
  muted: (text: string) => string;
  bold: (text: string) => string;
  dim: (text: string) => string;
  italic: (text: string) => string;
}

export function getTuiStyles(): TuiStyles {
  const palette = getTheme();
  return {
    accent: chalk.hex(palette.accent),
    primary: chalk.hex(palette.primary),
    success: chalk.hex(palette.success),
    warning: chalk.hex(palette.warning),
    danger: chalk.hex(palette.danger),
    info: chalk.hex(palette.info),
    text: chalk.hex(palette.text),
    muted: chalk.hex(palette.muted),
    bold: chalk.bold,
    dim: chalk.dim,
    italic: chalk.italic,
  };
}

export function getSelectListTheme(): SelectListTheme {
  const s = getTuiStyles();
  return {
    selectedPrefix: (text) => s.accent(text),
    selectedText: (text) => s.bold(s.text(text)),
    description: (text) => s.muted(text),
    scrollInfo: (text) => s.muted(text),
    noMatch: (text) => s.muted(text),
  };
}

export function getEditorTheme(): EditorTheme {
  const s = getTuiStyles();
  return {
    borderColor: (text) => s.muted(text),
    selectList: getSelectListTheme(),
  };
}

export function getMarkdownTheme(): MarkdownTheme {
  const s = getTuiStyles();
  return {
    heading: (text) => s.bold(s.text(text)),
    link: (text) => chalk.underline(s.info(text)),
    linkUrl: (text) => s.muted(text),
    code: (text) => s.accent(text),
    codeBlock: (text) => s.text(text),
    codeBlockBorder: (text) => s.muted(text),
    quote: (text) => s.italic(s.muted(text)),
    quoteBorder: (text) => s.muted(text),
    hr: (text) => s.muted(text),
    listBullet: (text) => s.accent(text),
    bold: (text) => s.bold(text),
    italic: (text) => s.italic(text),
    strikethrough: (text) => chalk.strikethrough(text),
    underline: (text) => chalk.underline(text),
  };
}
