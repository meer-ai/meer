export type SkillSource = "project" | "global" | "env";

export interface Skill {
  name: string;
  description: string;
  content: string;
  filePath: string;
  source: SkillSource;
  disableModelInvocation: boolean;
}

export type SkillDiagnosticCode =
  | "read_failed"
  | "parse_failed"
  | "invalid_metadata"
  | "duplicate";

export interface SkillDiagnostic {
  type: "warning";
  code: SkillDiagnosticCode;
  message: string;
  path: string;
  source: SkillSource;
}

export interface SkillLoadResult {
  skills: Skill[];
  diagnostics: SkillDiagnostic[];
  sources: string[];
}
