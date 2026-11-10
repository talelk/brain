#!/usr/bin/env bash
set -euo pipefail
python3 - "$(dirname "$0")/run.sh" <<'CHECKS'
import json, subprocess, sys
script = sys.argv[1]
situation = "Compare two vendors\nAcceptance criteria:\n1. Names the cheaper vendor\n2. States the assumptions\nUpstream results:\n- Gather prices: Vendor A costs 10, vendor B costs 12."
body = "# Vendor comparison\n\n" + "Vendor A is cheaper than vendor B at ten against twelve per seat, so the cheaper vendor is A. " * 3 + "\n\n## Assumptions\n\nSeat counts are equal and prices exclude tax, which is assumed because no tax rate was given."
good = {
 "summary": "Vendor A is cheaper.", "deliverable": body, "assumptions": ["Equal seat counts"],
 "criteria": [
  {"criterion": "Names the cheaper vendor", "met": True, "evidence": "The first section names vendor A as the cheaper one."},
  {"criterion": "States the assumptions", "met": True, "evidence": "The Assumptions section lists seat counts and tax."},
 ],
}
def mutate(**changes): return {**good, **changes}
cases = [
 (situation, good, True),
 (situation, {**good, "actions": ["Buy"]}, False),
 (situation, {k: v for k, v in good.items() if k != "assumptions"}, False),
 (situation, mutate(deliverable="Too short."), False),
 (situation, mutate(deliverable="Could you clarify which vendors you mean? " + body), False),
 (situation, mutate(deliverable="Could you clarify which vendors you mean? Please provide more detail about the vendors in question so that a comparison can be made. " * 4), False),
 (situation, mutate(criteria=good["criteria"][:1]), False),
 (situation, mutate(criteria=[good["criteria"][0], {**good["criteria"][1], "met": False}]), False),
 (situation, mutate(criteria=[good["criteria"][0], {**good["criteria"][1], "criterion": "Something else entirely"}]), False),
 (situation, mutate(criteria=[good["criteria"][0], {**good["criteria"][1], "evidence": "Yes."}]), False),
 (situation, mutate(criteria=[good["criteria"][0], good["criteria"][0]]), False),
 ("Free-form task without criteria", mutate(criteria=[]), True),
 ("Free-form task without criteria", mutate(criteria=good["criteria"]), False),
]
for situation_text, report, expected in cases:
 result = subprocess.run(["bash", script], input=json.dumps({"kind": "general-task", "situation": situation_text, "report": report}), text=True, capture_output=True, check=True)
 assert json.loads(result.stdout)["passed"] == expected, (situation_text, report, result.stdout)
print(f"Task validator: {len(cases)} contract and rejection cases passed")
CHECKS
