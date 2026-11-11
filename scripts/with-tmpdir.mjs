#!/usr/bin/env node
// Runs a command with a private TMPDIR so parallel agent sessions and test runs never clean each other's
// temp files (and /tmp never fills). A TMPDIR you set yourself is used as given; otherwise a unique directory
// under ~/.cache/brain-tmp is created for this run and removed when the command ends.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [command, ...args] = process.argv.slice(2);
if (!command) { console.error("usage: with-tmpdir.mjs <command> [args...]"); process.exit(2); }
const env = { ...process.env };
let owned;
if (!env.TMPDIR) {
  const base = join(homedir(), ".cache", "brain-tmp");
  mkdirSync(base, { recursive: true });
  owned = mkdtempSync(join(base, "run-"));
  env.TMPDIR = owned;
}
const child = spawn(command, args, { env, stdio: "inherit" });
const forward = (signal) => () => child.kill(signal);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, forward(signal));
child.on("exit", (code, signal) => {
  if (owned) rmSync(owned, { recursive: true, force: true });
  process.exit(code ?? (signal ? 1 : 0));
});
