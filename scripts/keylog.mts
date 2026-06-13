/**
 * Key diagnostic: prints the exact byte sequences the terminal sends, using the
 * same Kitty keyboard-protocol negotiation meer's TUI uses. Run it, press the
 * key once, and share the output.
 *
 *   npx tsx scripts/keylog.mts
 *
 * Press a key (e.g. Down arrow) ONCE per line. Ctrl+C twice to exit.
 */

const DESIRED_KITTY_FLAGS = 7;
const KITTY_QUERY = `\x1b[>${DESIRED_KITTY_FLAGS}u\x1b[?u\x1b[c`;

function show(chunk: string): string {
  // Escape every byte so control chars are visible.
  const escaped = chunk
    .replace(/\x1b/g, "\\x1b")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/[\x00-\x1f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
  const hex = [...chunk].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join(" ");
  return `seq="${escaped}"   hex=[${hex}]   len=${chunk.length}`;
}

if (process.stdin.setRawMode) process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.resume();

// Ask the terminal to enable the Kitty keyboard protocol (event types etc.),
// exactly as meer does — so we observe the same press/repeat/release encoding.
process.stdout.write(KITTY_QUERY);

process.stdout.write(
  "\r\nKey diagnostic running. Press a key ONCE (each press prints below).\r\n" +
    "When done, press Ctrl+C twice.\r\n\r\n"
);

let ctrlC = 0;
process.stdin.on("data", (data: string) => {
  if (data === "\x03") {
    ctrlC++;
    process.stdout.write(`\r\n(Ctrl+C ${ctrlC}/2)\r\n`);
    if (ctrlC >= 2) {
      process.stdout.write("\x1b[<u"); // disable kitty protocol
      if (process.stdin.setRawMode) process.stdin.setRawMode(false);
      process.stdout.write("\r\nbye\r\n");
      process.exit(0);
    }
    return;
  }
  ctrlC = 0;
  process.stdout.write(show(data) + "\r\n");
});
