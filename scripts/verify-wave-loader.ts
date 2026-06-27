import assert from "node:assert/strict";
import {
  getWaveLoader,
  getWaveLoaderFrames,
  WAVE_LOADER_INTERVAL_MS,
} from "../packages/coding-agent/src/ui/logo.js";
import { stripAnsiCodes } from "../packages/coding-agent/src/ui/shared/tool-utils.js";

const frames = getWaveLoaderFrames();

// --- a real, animatable set of frames ---------------------------------------
assert.ok(WAVE_LOADER_INTERVAL_MS > 0, "interval must be positive");
// The hue-drift design needs many frames (width × hue steps), not just one
// marching cycle — guard against a regression back to a tiny frame set.
assert.ok(frames.length >= 50, `expected the full hue-drift loop, got ${frames.length} frames`);

// --- layout is stable: every frame is the same visible width ----------------
const widths = new Set(frames.map((f) => stripAnsiCodes(f).length));
assert.equal(widths.size, 1, "all frames must share one visible width (no layout shift)");
const [width] = [...widths];
assert.equal(width, 7, "wave indicator should stay 7 cells wide");

// --- only the EQ block glyphs appear, nothing stray -------------------------
const bares = frames.map(stripAnsiCodes);
for (const bare of bares) {
  assert.match(bare, /^[▁▂▃▄▅▆▇]{7}$/, `frame should be only block glyphs: ${JSON.stringify(bare)}`);
}

// --- the swell actually marches: bare patterns are not all identical --------
assert.ok(new Set(bares).size > 1, "the swell must march (block heights have to move)");

// --- frames carry color (truecolor SGR) when chalk has a color level --------
// (skip the colour assertions when color is disabled, e.g. NO_COLOR / non-TTY)
const anyColored = frames.some((f) => f !== stripAnsiCodes(f));
if (anyColored) {
  assert.ok(
    frames.every((f) => f !== stripAnsiCodes(f)),
    "every frame should be colored when color is enabled"
  );

  // --- hue drift: two frames one marching cycle apart share the SAME swell
  // shape but DIFFERENT colour, proving the gradient drifted between them.
  assert.equal(bares[0], bares[width], "frames one cycle apart should share the swell shape");
  assert.notEqual(frames[0], frames[width], "...but differ in colour — the hue must have drifted");
}

// --- reactive intensities: calm vs active -----------------------------------
const calm = getWaveLoader("calm");
const active = getWaveLoader("active");
assert.equal(calm.frames.length, frames.length, "calm is the default frame set");
assert.equal(calm.frames[0], frames[0], "getWaveLoaderFrames() is the calm wave");
for (const variant of [calm, active]) {
  assert.ok(variant.intervalMs > 0, "interval must be positive");
  const vWidths = new Set(variant.frames.map((f) => stripAnsiCodes(f).length));
  assert.equal(vWidths.size, 1, "intensity frames keep one visible width");
  assert.equal([...vWidths][0], 7, "intensity frames stay 7 cells wide");
  for (const f of variant.frames) {
    assert.match(stripAnsiCodes(f), /^[▁▂▃▄▅▆▇]{7}$/, "intensity frames use block glyphs only");
  }
}
assert.ok(active.intervalMs < calm.intervalMs, "the active (tool-running) wave rolls faster");
// the swell shapes differ: active is choppier, so the bare patterns aren't identical
const calmShapes = new Set(calm.frames.map(stripAnsiCodes));
const activeShapes = new Set(active.frames.map(stripAnsiCodes));
assert.notDeepEqual([...calmShapes].sort(), [...activeShapes].sort(), "calm and active swells differ");

console.log("verify-wave-loader: all assertions passed");

// --- optional eyeball preview: `tsx scripts/verify-wave-loader.ts --preview`
// Animates in place so the marching swell + slow hue drift are both visible.
if (process.argv.includes("--preview")) {
  let i = 0;
  const timer = setInterval(() => {
    process.stdout.write(`\r  ${frames[i % frames.length]}  Fathoming…`);
    i++;
  }, WAVE_LOADER_INTERVAL_MS);
  setTimeout(() => {
    clearInterval(timer);
    process.stdout.write("\n");
  }, 8000);
}
