/**
 * Self-update Command
 *
 * Checks the npm registry for a newer release of the `meerai` package and
 * upgrades the globally installed CLI in place.
 */

import { Command } from "commander";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import chalk from "chalk";
import { getVersion } from "./version.js";

const PACKAGE_NAME = "meerai";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export function createUpdateCommand(): Command {
  return new Command("update")
    .description("Update Meer to the latest published version")
    .option("--check", "Only check for a newer version; do not install")
    .option(
      "--pm <manager>",
      "Force a package manager (npm, pnpm, yarn, bun)"
    )
    .action(async (options: { check?: boolean; pm?: string }) => {
      await runUpdate(options);
    });
}

export async function runUpdate(options: {
  check?: boolean;
  pm?: string;
}): Promise<void> {
  const current = getVersion();
  console.log(chalk.cyan(`\nMeer is currently at v${current}.`));

  let latest: string;
  try {
    latest = await fetchLatestVersion();
  } catch (error) {
    console.error(
      chalk.red("❌ Could not reach the npm registry:"),
      error instanceof Error ? error.message : String(error)
    );
    console.error(
      chalk.gray(`💡 You can update manually: npm install -g ${PACKAGE_NAME}@latest`)
    );
    process.exitCode = 1;
    return;
  }

  if (compareVersions(latest, current) <= 0) {
    console.log(chalk.green("✓ You're already on the latest version.\n"));
    return;
  }

  console.log(chalk.yellow(`↑ A new version is available: v${latest}\n`));

  if (options.check) {
    const manager = resolvePackageManager(options.pm);
    console.log(
      chalk.gray("Run ") +
        chalk.cyan(installCommand(manager)) +
        chalk.gray(" to upgrade.\n")
    );
    return;
  }

  const manager = resolvePackageManager(options.pm);
  const command = installCommand(manager);
  console.log(chalk.gray(`Running: ${command}\n`));

  try {
    execSync(command, { stdio: "inherit" });
  } catch (error) {
    console.error(
      chalk.red("\n❌ Update failed:"),
      error instanceof Error ? error.message : String(error)
    );
    console.error(
      chalk.gray(`💡 Try running with elevated permissions, or run: ${command}`)
    );
    process.exitCode = 1;
    return;
  }

  console.log(chalk.green(`\n✓ Updated Meer to v${latest}.\n`));
}

async function fetchLatestVersion(): Promise<string> {
  const response = await fetch(REGISTRY_URL, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`registry responded with HTTP ${response.status}`);
  }
  const data = (await response.json()) as { version?: string };
  if (!data.version) {
    throw new Error("registry response did not include a version");
  }
  return data.version;
}

/**
 * Best-effort detection of how the CLI was installed by inspecting the path of
 * this module. Falls back to npm, which is the documented install path.
 */
function resolvePackageManager(forced?: string): PackageManager {
  if (forced) {
    const normalized = forced.toLowerCase();
    if (
      normalized === "npm" ||
      normalized === "pnpm" ||
      normalized === "yarn" ||
      normalized === "bun"
    ) {
      return normalized;
    }
  }

  let path = "";
  try {
    path = fileURLToPath(import.meta.url);
  } catch {
    path = "";
  }

  if (path.includes("/pnpm/") || path.includes(".pnpm")) return "pnpm";
  if (path.includes("/.bun/") || path.includes("/bun/")) return "bun";
  if (path.includes("/Yarn/") || path.includes("/yarn/")) return "yarn";
  return "npm";
}

function installCommand(manager: PackageManager): string {
  const target = `${PACKAGE_NAME}@latest`;
  switch (manager) {
    case "pnpm":
      return `pnpm add -g ${target}`;
    case "yarn":
      return `yarn global add ${target}`;
    case "bun":
      return `bun add -g ${target}`;
    case "npm":
    default:
      return `npm install -g ${target}`;
  }
}

/**
 * Numeric semver comparison (ignores pre-release tags). Returns >0 when `a` is
 * newer than `b`, 0 when equal, <0 when older.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): number[] =>
    value
      .replace(/^v/, "")
      .split("-")[0]
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);

  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length);

  for (let i = 0; i < length; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}
