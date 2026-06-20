const PLACEHOLDER_PATTERN = /{{\s*([\w.-]+)\s*}}/g;

export interface TemplateContext {
  [key: string]: string | undefined;
}

export function renderSlashTemplate(
  template: string,
  context: TemplateContext,
): string {
  if (!template.includes("{{")) {
    return template;
  }

  return template.replace(PLACEHOLDER_PATTERN, (match, key) => {
    const value = context[key];
    return typeof value === "string" ? value : match;
  });
}
