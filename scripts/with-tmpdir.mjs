#!/usr/bin/env node
// Runs a command with a private TMPDIR so parallel agent sessions and test runs never clean each other's
// temp files (and /tmp never fills). A TMPDIR you set yourself is used as given; otherwise a unique directory
// under ~/.cache/brain-tmp is created for this run and removed when the command ends.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const signalNumber = new Map([["SIGHUP", 1], ["SIGINT", 2], ["SIGTERM", 15], ["SIGKILL", 9]]);
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
const clean = () => { if (owned) rmSync(owned, { recursive: true, force: true }); };
const child = spawn(command, args, { env, stdio: "inherit" });
// A signal to this process goes on to the command; this process then ends when the command does, and the folder goes with it.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => {
  console.error(`with-tmpdir: could not run ${command}: ${error.message}`);
  clean();
  process.exit(127);
});
child.on("exit", (code, signal) => {
  clean();
  process.exit(code ?? (signal ? 128 + (signalNumber.get(signal) ?? 1) : 0));
});
