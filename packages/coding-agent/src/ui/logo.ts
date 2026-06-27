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

/** How busy the wave looks — calm while thinking, choppy while a tool runs. */
export type WaveIntensity = "calm" | "active";

/** Frame interval for the calm marching-wave loading indicator. */
const CALM_INTERVAL_MS = 130;

/** Frame interval for the calm marching-wave loading indicator (back-compat). */
export const WAVE_LOADER_INTERVAL_MS = CALM_INTERVAL_MS;

/** Visible width (in cells) of the wave loader indicator. */
const WAVE_LOADER_WIDTH = 7;

/** Slow frames per marching cycle — controls how gradually the hue drifts. */
const WAVE_HUE_STEPS = 30;

/** Peak hue swing, in degrees, of the slow ocean hue drift (blue ↔ teal). */
const WAVE_HUE_DRIFT_DEG = 26;

/** EQ-style block ramp, low swell → high crest. All cells are width-1. */
const WAVE_BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇"] as const;

/**
 * Ocean depth gradient in HSL (hue°, sat%, light%), dark trough → bright foam.
 * Kept in HSL so the whole ramp's hue can be drifted together (see
 * {@link getWaveLoaderFrames}) without leaving the blue–cyan–teal water range.
 */
const OCEAN_HSL: ReadonlyArray<readonly [number, number, number]> = [
  [212, 68, 22], // deep trough
  [205, 74, 38],
  [198, 80, 52],
  [191, 85, 67],
  [186, 92, 88], // foam crest
];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** HSL (h in degrees, s/l in 0..100) → #rrggbb. */
function hslToHex(h: number, s: number, l: number): string {
  const sn = s / 100;
  const ln = l / 100;
  const k = (n: number): number => (n + h / 30) % 12;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n: number): number => ln - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  const toHex = (x: number): string =>
    Math.round(255 * x)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

/**
 * Sample the ocean ramp at height t∈[0,1], with `hueDrift` degrees added to
 * the whole ramp → a #rrggbb hex string.
 */
function oceanHex(t: number, hueDrift: number): string {
  const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t;
  const x = clamped * (OCEAN_HSL.length - 1);
  const i = Math.floor(x);
  const frac = x - i;
  const a = OCEAN_HSL[i]!;
  const b = OCEAN_HSL[Math.min(OCEAN_HSL.length - 1, i + 1)]!;
  const h = (lerp(a[0], b[0], frac) + hueDrift + 360) % 360;
  const s = lerp(a[1], b[1], frac);
  const l = lerp(a[2], b[2], frac);
  return hslToHex(h, s, l);
}

/** Per-intensity shape + speed of the swell. */
interface WaveProfile {
  intervalMs: number;
  /** Wave height ∈[0,1] at the given phase angle and per-frame offset. */
  height: (theta: number, offset: number) => number;
}

const clamp01 = (n: number): number => (n <= 0 ? 0 : n >= 1 ? 1 : n);

const WAVE_PROFILES: Record<WaveIntensity, WaveProfile> = {
  // Gentle, slow single swell — meer is thinking.
  calm: {
    intervalMs: CALM_INTERVAL_MS,
    height: (theta) => 0.5 + 0.38 * Math.sin(theta),
  },
  // Faster, with a second harmonic for chop — meer is running a tool.
  active: {
    intervalMs: 78,
    height: (theta, offset) =>
      0.5 + 0.5 * (0.72 * Math.sin(theta) + 0.28 * Math.sin(2 * theta + offset)),
  },
};

/**
 * Pre-colored marching-wave frames + their frame interval for the loading
 * indicator, with two animation timescales baked into one frame array:
 *
 * - **Fast (per frame):** a sine swell scrolls left one cell per frame and is
 *   drawn with EQ-style block glyphs (`▁`…`▇`) whose height tracks the wave —
 *   the surface undulates like a waveform. The `intensity` sets how tall and
 *   choppy that swell is, and how fast it rolls.
 * - **Slow (across the loop):** the ocean gradient's hue drifts on a gentle
 *   sine, blue ↔ teal, over the full {@link WAVE_HUE_STEPS}-cycle loop (~tens
 *   of seconds), so the colour breathes without ever leaving the water range.
 *
 * Cycling the returned frames animates both at once — no extra timer needed.
 * Every frame is exactly {@link WAVE_LOADER_WIDTH} cells wide, and on terminals
 * without truecolor chalk downsamples the tones while the swell still animates.
 */
export function getWaveLoader(intensity: WaveIntensity = "calm"): {
  frames: string[];
  intervalMs: number;
} {
  const profile = WAVE_PROFILES[intensity];
  const width = WAVE_LOADER_WIDTH;
  const total = width * WAVE_HUE_STEPS;
  const frames: string[] = [];
  for (let f = 0; f < total; f++) {
    const offset = f % width;
    // One full hue oscillation across the whole loop, so frame 0 and the wrap
    // point share the same hue → seamless.
    const hueDrift = WAVE_HUE_DRIFT_DEG * Math.sin((f / total) * Math.PI * 2);
    let frame = "";
    for (let i = 0; i < width; i++) {
      const theta = ((i + offset) / width) * Math.PI * 2;
      const height = clamp01(profile.height(theta, offset));
      const level = Math.round(height * (WAVE_BLOCKS.length - 1));
      frame += chalk.hex(oceanHex(height, hueDrift))(WAVE_BLOCKS[level]);
    }
    frames.push(frame);
  }
  return { frames, intervalMs: profile.intervalMs };
}

/** Calm wave frames — kept for the startup spinner and back-compat. */
export function getWaveLoaderFrames(): string[] {
  return getWaveLoader("calm").frames;
}
