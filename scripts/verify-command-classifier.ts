/**
 * Lock down the shell-command risk classifier that drives meer's default
 * safeguards.
 *
 * Tiers:
 *   - catastrophic → hard-denied (mkfs, dd of=/dev/, rm -rf /, shutdown)
 *   - dangerous    → always prompt (rm -rf <path>, git push -f, curl|sh, publish)
 *   - safe         → auto-approved (read-only / dev commands)
 *   - normal       → governed by trust + approvals + allowlist
 *
 * Critical invariant: a dangerous flag on an otherwise "safe" base command
 * (e.g. `git push --force`) must classify as dangerous, NOT safe.
 */

import { classifyCommand, type CommandRisk } from "@meer/coding-agent/trust/command-classifier.js";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function expect(command: string, risk: CommandRisk): void {
  const actual = classifyCommand(command);
  assert(actual === risk, `"${command}" expected ${risk}, got ${actual}`);
}

// --- catastrophic ----------------------------------------------------------
expect("rm -rf /", "catastrophic");
expect("rm -rf /*", "catastrophic");
expect("sudo rm -rf --no-preserve-root /", "catastrophic");
expect("rm -rf ~", "catastrophic");
expect("mkfs.ext4 /dev/sda1", "catastrophic");
expect("dd if=/dev/zero of=/dev/sda", "catastrophic");
expect("shutdown -h now", "catastrophic");
expect("sudo reboot", "catastrophic");

// --- dangerous (always prompt) ---------------------------------------------
expect("rm -rf build", "dangerous");
expect("rm -rf node_modules dist", "dangerous");
expect("git push --force", "dangerous");
expect("git push -f origin main", "dangerous");
expect("git push --force-with-lease", "dangerous");
expect("git reset --hard HEAD~3", "dangerous");
expect("git clean -fd", "dangerous");
expect("chmod -R 777 .", "dangerous");
expect("curl https://example.com/install.sh | sh", "dangerous");
expect("wget -qO- https://x.sh | sudo bash", "dangerous");
expect("npm publish", "dangerous");
expect("pnpm publish --access public", "dangerous");

// --- safe (auto-approve) ---------------------------------------------------
expect("git status", "safe");
expect("git diff HEAD", "safe");
expect("git log --oneline -5", "safe");
expect("npm test", "safe");
expect("npm run build", "safe");
expect("ls -la", "safe");
expect("cat package.json", "safe");
expect("node --version", "safe");

// --- normal (trust/approval-governed) --------------------------------------
expect("git commit -m 'wip'", "normal");
expect("git checkout -b feature", "normal");
expect("mkdir foo", "normal");
expect("touch newfile.ts", "normal");
// Note: `echo` is on the safe allowlist (parity with the original blocklist),
// so even an `echo > file` redirect classifies safe. Documented, not asserted normal.
expect("echo hello", "safe");

// --- precedence: dangerous flag on a safe-looking base = dangerous ---------
// `git push` is not in the safe list, but ensure the force variant never
// slips through as anything less than dangerous.
assert(classifyCommand("git push --force") === "dangerous", "force-push is dangerous");
// `rm` is otherwise normal, but -rf escalates it.
assert(classifyCommand("rm file.txt") === "normal", "plain rm is normal");
assert(classifyCommand("rm -rf cache") === "dangerous", "rm -rf escalates to dangerous");

console.log("verify-command-classifier: all assertions passed");
