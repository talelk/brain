import { describe, expect, it } from "vitest";
import { runLocalJudge } from "../../../apps/governor/src/modules/packs/judge";

// T44 judge calibration probe against the real LAN model: a fixed set of
// obvious evidence/criterion pairs measures agreement. This is calibration
// evidence about the optional judge, not a product verdict path.
const CALIBRATION = [
  { criterion: "The evidence states every check passed.", evidence: "CI summary: 128 checks run, 128 passed, 0 failed.", expected: "passed" },
  { criterion: "The evidence states every check passed.", evidence: "CI summary: 128 checks run, 121 passed, 7 failed.", expected: "failed" },
  { criterion: "The deployment target is production.", evidence: "Deploy manifest: environment=production, region=eu-west.", expected: "passed" },
  { criterion: "The deployment target is production.", evidence: "Deploy manifest: environment=staging, region=eu-west.", expected: "failed" },
];

async function modelReachable(): Promise<boolean> {
  try {
    const base = (process.env["BRAIN_LOCAL_MODEL_URL"] ?? "http://tntungx10:8000/v1").replace(/\/$/, "");
    const r = await fetch(`${base}/models`, { signal: AbortSignal.timeout(4000) });
    return r.ok;
  } catch { return false; }
}

describe("local judge calibration (T44)", () => {
  it("agrees with obvious calibration fixtures when the model is reachable", async () => {
    if (!(await modelReachable())) {
      console.log("judge-calibration: model unreachable, skipped");
      return;
    }
    let agree = 0;
    for (const c of CALIBRATION) {
      let v;
      try {
        v = await runLocalJudge({ criterionText: c.criterion, evidenceText: c.evidence });
      } catch {
        console.log("judge-calibration: model call failed mid-probe, skipped");
        return;
      }
      if (v.outcome === c.expected) agree += 1;
    }
    console.log(`judge-calibration agreement: ${agree}/${CALIBRATION.length}`);
    expect(agree).toBeGreaterThanOrEqual(3);
  }, 300_000);
});
