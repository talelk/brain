import { describe, expect, it } from "vitest";
import type { CheckResult } from "@brain/contracts";
import { deriveTrust, needsSignOff } from "../../apps/governor/src/modules/evidence/trust";

const check = (id: string, status: CheckResult["status"]): CheckResult => ({ criterionId: id, checkId: id, status, oracleDigest: `sha256:${"a".repeat(64)}`, artifacts: [], detail: "" });

describe("trust read (#49): check status x evaluator basis x independence x sign-off", () => {
  const statuses: CheckResult["status"][] = ["passed", "failed", "missing", "inconclusive"];
  const bases = ["deterministic", "model-opinion"] as const;
  const levels = ["L1", "L2", "L3"] as const;
  for (const status of statuses) for (const basis of bases) for (const independence of levels) for (const signedOffBy of [undefined, "person-1"]) {
    const name = `${status} / ${basis} / ${independence} / ${signedOffBy ? "signed off" : "no sign-off"}`;
    it(name, () => {
      const trust = deriveTrust({ checks: [check("c1", status)], evaluatorBasis: basis, independence, ...(signedOffBy ? { signedOffBy } : {}) });
      const row = trust.rows[0]!;
      // Only a passed check supports a criterion at all.
      const expected = status !== "passed" ? "none" : basis === "deterministic" ? "deterministic" : signedOffBy ? "human" : "model";
      expect(row.basis).toBe(expected);
      expect(row.independence).toBe(independence);
      expect({ det: trust.deterministic, human: trust.human, model: trust.model }).toEqual({ det: expected === "deterministic" ? 1 : 0, human: expected === "human" ? 1 : 0, model: expected === "model" ? 1 : 0 });
      // Done needs a person exactly when a passed criterion rests on model opinion alone.
      expect(needsSignOff(trust)).toBe(expected === "model");
      expect(trust.unverified).toEqual(expected === "model" || expected === "none" ? ["c1"] : []);
      expect(trust.text.startsWith(`${expected === "deterministic" ? 1 : 0} of 1 criterion checked by tests, files or hashes`)).toBe(true);
      if (expected === "model") expect(trust.text).toContain("a person must sign off");
    });
  }

  it("counts mixed criteria into the plain sentence", () => {
    const trust = deriveTrust({ checks: [check("a", "passed"), check("b", "passed"), check("c", "passed"), check("d", "failed")], evaluatorBasis: "deterministic", independence: "L2" });
    expect(trust.text).toBe("3 of 4 criteria checked by tests, files or hashes; 0 by human sign-off; 0 by model opinion. 1 not met.");
    expect(trust.unverified).toEqual(["d"]);
  });

  it("a sign-off turns model opinion into human sign-off and records who", () => {
    const trust = deriveTrust({ checks: [check("a", "passed"), check("b", "passed")], evaluatorBasis: "model-opinion", independence: "L1", signedOffBy: "person-1" });
    expect(trust.text).toBe("0 of 2 criteria checked by tests, files or hashes; 2 by human sign-off; 0 by model opinion.");
    expect(trust.signedOffBy).toBe("person-1");
    expect(needsSignOff(trust)).toBe(false);
  });
});
