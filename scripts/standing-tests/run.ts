import { pathToFileURL } from "node:url";
import { chatCompletion, fingerprint, lastFingerprint, modelConfig, modelReachable, runStandingTests, saveReport, summaryLines, writeBaseline } from "./lib";

/**
 * Runs the standing test set (backlog row 78) and prints and saves its report: first-pass success, attempts, tokens, time.
 *   --if-changed       run only when the prompts, fixtures, model or release (BRAIN_RELEASE_DIGEST) changed since the last report
 *   --record-baseline  store this run's first-pass success as the baseline the deploy gate compares with
 * Nightly: a timer runs `pnpm standing-tests -- --if-changed` plus one unconditional run a day (deploy/demo/standing-tests.timer).
 * Exit code 3 when no model is reachable (skipped, not failed).
 */
export async function run(args: readonly string[], env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch, out: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): Promise<number> {
  const config = modelConfig(env);
  if (args.includes("--if-changed") && lastFingerprint() === fingerprint(config.model, env["BRAIN_RELEASE_DIGEST"] ?? "")) { out("standing tests: nothing changed since the last report; not run"); return 0; }
  if (!(await modelReachable(config, fetchImpl))) { out(`standing tests skipped: no model is reachable at ${config.url}`); return 3; }
  const report = await runStandingTests(chatCompletion(config, fetchImpl), config.model);
  for (const line of summaryLines(report)) out(line);
  out(`report saved to ${saveReport(report)}`);
  if (args.includes("--record-baseline")) { writeBaseline(report); out("baseline recorded"); }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await run(process.argv.slice(2)).catch((error: unknown) => { process.stderr.write(`standing tests errored: ${error instanceof Error ? error.message : String(error)}\n`); return 2; });
}
