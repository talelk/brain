#!/usr/bin/env node
// A stand-in `docker` for tests that must see how the launcher calls it, never a container runtime. Every call's argv is appended to
// $FAKE_DOCKER_LOG as one JSON line. `docker run` behaves like an engine host that is ready at once and then echoes each line it is
// given (prefixed "echo:") until its stdin closes; $FAKE_DOCKER_RUN_FAIL makes it fail the way a missing image does. Everything else
// succeeds, except `inspect`, which says the container is gone (as it is after `rm -f`).
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
if (process.env.FAKE_DOCKER_LOG) appendFileSync(process.env.FAKE_DOCKER_LOG, `${JSON.stringify(argv)}\n`);
const [command] = argv;

if (command === "run") {
  // An `--env-file` is read now, as docker does at `run`, and what it held is recorded beside the argv (FAKE_DOCKER_LOG.envfile).
  const envFile = argv[argv.indexOf("--env-file") + 1];
  if (process.env.FAKE_DOCKER_LOG && argv.includes("--env-file") && envFile) {
    appendFileSync(`${process.env.FAKE_DOCKER_LOG}.envfile`, `${JSON.stringify({ path: envFile, mode: statSync(envFile).mode & 0o777, text: readFileSync(envFile, "utf8") })}\n`);
  }
  if (process.env.FAKE_DOCKER_RUN_DELAY_MS) await new Promise((done) => setTimeout(done, Number(process.env.FAKE_DOCKER_RUN_DELAY_MS)));
  if (process.env.FAKE_DOCKER_RUN_FAIL) {
    process.stderr.write(`${process.env.FAKE_DOCKER_RUN_FAIL}\n`);
    process.exit(125);
  }
  process.stdout.write('@brain-engine {"type":"ready"}\n');
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => process.stdout.write(`echo:${line}\n`));
  lines.on("close", () => process.exit(0));
} else if (command === "inspect") {
  process.exit(1);
} else if (command === "version") {
  process.stdout.write("fake\n");
}
