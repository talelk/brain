import { pathToFileURL } from "node:url";
import { BASELINE_FILE, chatCompletion, decideGate, modelConfig, modelReachable, readBaseline, runStandingTests, saveReport, summaryLines } from "./lib";

/**
 * The deploy gate for the standing test set (backlog row 78). Exit codes the deploy workflow relies on:
 *   0  passed: first-pass success did not fall more than 10 points against the recorded baseline
 *   1  blocked: it fell by more than 10 points
 *   3  skipped: no model is reachable, so the set cannot run (never a failure: CI has no model)
 * Any other code is an error and blocks the deploy as well.
 */
export const EXIT_PASS = 0;
export const EXIT_BLOCK = 1;
export const EXIT_SKIPPED = 3;

export async function gate(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch, baselineFile = BASELINE_FILE, out: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): Promise<number> {
  const config = modelConfig(env);
  if (!(await modelReachable(config, fetchImpl))) {
    out(`standing tests skipped: no model is reachable at ${config.url} (model ${config.model}); not a failure`);
    return EXIT_SKIPPED;
  }
  const report = await runStandingTests(chatCompletion(config, fetchImpl), config.model);
  for (const line of summaryLines(report)) out(line);
  try { out(`report saved to ${saveReport(report)}`); } catch { /* a read-only checkout still gates */ }
  const decision = decideGate(report, readBaseline(baselineFile));
  out(decision.message);
  return decision.block ? EXIT_BLOCK : EXIT_PASS;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await gate().catch((error: unknown) => { process.stderr.write(`standing tests errored: ${error instanceof Error ? error.message : String(error)}\n`); return 2; });
}
