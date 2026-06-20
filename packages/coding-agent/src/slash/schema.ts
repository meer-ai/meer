import { z } from "zod";

const CommandNameRegex = /^\/[^\s]+$/;

export const SlashCommandTypeSchema = z.enum(["prompt", "shell", "meer-cli"]);

const CommandVariableSchema = z.object({
  name: z.string().min(1, "Variable name is required"),
  source: z.string().optional(),
  defaultValue: z.string().optional(),
  description: z.string().optional(),
});

export const SlashCommandDefinitionSchema = z
  .object({
    command: z
      .string()
      .min(2, "Command must include a slash and name")
      .regex(
        CommandNameRegex,
        "Command names must start with '/' and contain no whitespace",
      ),
    description: z.string().min(1, "Description is required"),
    type: SlashCommandTypeSchema.default("prompt"),
    template: z.string().optional(),
    action: z.string().optional(),
    args: z.array(z.string()).optional(),
    allowShell: z.boolean().optional(),
    override: z.boolean().optional(),
    variables: z.array(CommandVariableSchema).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.type === "prompt") {
      if (!value.template || value.template.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["template"],
          message: "Prompt commands require a non-empty template.",
        });
      }
      return;
    }

    if (value.type === "shell") {
      if (!value.action || value.action.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["action"],
          message: "Shell commands require an action string to execute.",
        });
      }
      if (!value.allowShell) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["allowShell"],
          message:
            "Shell commands must explicitly set allowShell: true to acknowledge the security risk.",
        });
      }
      return;
    }

    if (value.type === "meer-cli") {
      if (!value.action || value.action.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["action"],
          message:
            "Meer CLI commands require an action specifying the sub-command to run.",
        });
      }
    }
  });

export const SlashCommandConfigSchema = z.object({
  commands: z
    .array(SlashCommandDefinitionSchema)
    .default([])
    .transform((commands) => {
      // Remove duplicate command entries, keeping the last occurrence
      const byName = new Map<string, (typeof commands)[number]>();
      for (const command of commands) {
        byName.set(command.command, command);
      }
      return Array.from(byName.values());
    }),
});

export type SlashCommandType = z.infer<typeof SlashCommandTypeSchema>;
export type SlashCommandDefinition = z.infer<
  typeof SlashCommandDefinitionSchema
>;
export type SlashCommandConfig = z.infer<typeof SlashCommandConfigSchema>;
