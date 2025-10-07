import chalk from "chalk";

/**
 * ASCII art logos for Meer CLI
 * Inspired by the ocean wave logo
 */

/**
 * Large logo for welcome/startup screens
 */
export function displayLargeLogo(): void {
  console.log(
    chalk.cyan(
      `
   ███╗   ███╗███████╗███████╗██████╗
   ████╗ ████║██╔════╝██╔════╝██╔══██╗
   ██╔████╔██║█████╗  █████╗  ██████╔╝
   ██║╚██╔╝██║██╔══╝  ██╔══╝  ██╔══██╗
   ██║ ╚═╝ ██║███████╗███████╗██║  ██║
   ╚═╝     ╚═╝╚══════╝╚══════╝╚═╝  ╚═╝
`
    ) +
      chalk.blue(`        🌊 Dive Deep Into Code 🌊\n`)
  );
}

/**
 * Medium logo with wave design
 */
export function displayMediumLogo(): void {
  console.log(
    chalk.cyan("      ╭──────────────────╮") +
      "\n" +
      chalk.cyan("      │  ") +
      chalk.bold.cyan("MEER") +
      chalk.cyan("  ") +
      chalk.blue("~≈≈≈~") +
      chalk.cyan("  │") +
      "\n" +
      chalk.cyan("      ╰──────────────────╯") +
      "\n" +
      chalk.blue("         🌊 AI CLI 🌊\n")
  );
}

/**
 * Small logo for compact displays
 */
export function displaySmallLogo(): void {
  console.log(
    chalk.bold.cyan("MEER") +
      " " +
      chalk.blue("~≈~") +
      " " +
      chalk.gray("AI CLI")
  );
}

/**
 * Minimal ocean wave ASCII art
 */
export function displayWave(): void {
  console.log(
    chalk.blue("    ~") +
      chalk.cyan("≈") +
      chalk.blue("~") +
      chalk.cyan("≈") +
      chalk.blue("~") +
      chalk.cyan("≈") +
      chalk.blue("~")
  );
}

/**
 * Welcome banner with logo and info
 */
export function displayWelcomeBanner(version: string = "1.0.0"): void {
  console.log(
    chalk.cyan(
      `
   ╔════════════════════════════════════════╗
   ║                                        ║
   ║     ███╗   ███╗███████╗███████╗██████╗║
   ║     ████╗ ████║██╔════╝██╔════╝██╔══██║
   ║     ██╔████╔██║█████╗  █████╗  ██████╔╝║
   ║     ██║╚██╔╝██║██╔══╝  ██╔══╝  ██╔══██╗║
   ║     ██║ ╚═╝ ██║███████╗███████╗██║  ██║║
   ║     ╚═╝     ╚═╝╚══════╝╚══════╝╚═╝  ╚═╝║
   ║                                        ║
   ║        `) +
      chalk.blue(`🌊 Dive Deep Into Code 🌊`) +
      chalk.cyan(`        ║
   ║                                        ║
   ╚════════════════════════════════════════╝
`)
  );
  console.log(
    chalk.gray(`           Version ${version}`) + chalk.cyan(" • ") + chalk.gray("meer.ai\n")
  );
}

/**
 * Artistic wave logo (inspired by the actual logo design)
 */
export function displayArtisticLogo(): void {
  console.log(
    chalk.blue(`
          ╭─────────╮
       ╭──┤  `) +
      chalk.bold.cyan(`MEER`) +
      chalk.blue(`  ├──╮
    ╭──┤  `) +
      chalk.cyan(`~≈≈≈≈≈~`) +
      chalk.blue(`  ├──╮
    │  `) +
      chalk.blue(`╰─────────╯`) +
      chalk.blue(`  │
    │  `) +
      chalk.cyan(`AI-Powered`) +
      chalk.blue(`  │
    ╰─────────────────╯
`)
  );
}

/**
 * Goodbye banner with wave
 */
export function displayGoodbyeBanner(): void {
  console.log(
    "\n" +
      chalk.blue("    ╔═══════════════════════════════╗\n") +
      chalk.blue("    ║  ") +
      chalk.cyan("Thanks for using ") +
      chalk.bold.cyan("MEER") +
      chalk.blue("  ║\n") +
      chalk.blue("    ║     ") +
      chalk.blue("~≈~≈~≈~≈~≈~≈~") +
      chalk.blue("      ║\n") +
      chalk.blue("    ╚═══════════════════════════════╝\n")
  );
}

/**
 * Progress/loading animation wave
 */
export function getWaveFrame(frame: number): string {
  const waves = [
    chalk.blue("~") + chalk.cyan("≈") + chalk.blue("~") + chalk.cyan("≈") + chalk.blue("~") + chalk.cyan("≈"),
    chalk.cyan("≈") + chalk.blue("~") + chalk.cyan("≈") + chalk.blue("~") + chalk.cyan("≈") + chalk.blue("~"),
    chalk.blue("~") + chalk.cyan("≈") + chalk.blue("~") + chalk.cyan("≈") + chalk.blue("~") + chalk.cyan("≈"),
  ];
  return waves[frame % waves.length];
}
