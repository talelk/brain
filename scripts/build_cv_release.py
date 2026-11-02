#!/usr/bin/env python3
"""Build the cv-insights configuration release with resolved digests.

Documents reference each other by content digest, so generation runs in
dependency order: Tools -> Agents/Evaluators -> Workflows.
"""
import glob
import hashlib
import json
import os
import shutil

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(ROOT), "releases", "cv-insights")
STARTER = os.path.join(os.path.dirname(ROOT), "examples", "v1", "starter-release")
CV_TOOLS = os.path.join(ROOT, "cv-tools")


def overlay_starter() -> None:
    """One active release per organization, so the CV release must be a
    superset: the starter documents plus the CV-specific ones. Starter
    documents are copied verbatim because their cross-references are content
    digests of that exact text."""
    for path in sorted(glob.glob(os.path.join(STARTER, "**", "*"), recursive=True)):
        if os.path.isdir(path):
            continue
        target = os.path.join(OUT, os.path.relpath(path, STARTER))
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copyfile(path, target)


def stage_tool_scripts() -> None:
    """Every tool script ships inside the release tree, so staging the release
    also stages the exact bytes each Tool document is pinned to."""
    for source in sorted(glob.glob(os.path.join(CV_TOOLS, "*", "run.sh"))):
        tool_id = os.path.basename(os.path.dirname(source))
        target = os.path.join(OUT, "tools", tool_id, "run.sh")
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copyfile(source, target)


# Start from a clean tree: a stale document left behind by an earlier build
# would silently become part of the active release.
if os.path.isdir(OUT):
    shutil.rmtree(OUT)
os.makedirs(OUT)
overlay_starter()
stage_tool_scripts()


def digest(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode("utf8")).hexdigest()


def dump(path: str, value) -> str:
    text = json.dumps(value, indent=2, ensure_ascii=False) + "\n"
    full = os.path.join(OUT, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w", encoding="utf8") as handle:
        handle.write(text)
    return digest(text)


def tool_script(tool_id: str) -> str:
    src = os.path.join(ROOT, "cv-tools", tool_id, "run.sh")
    with open(src, encoding="utf8") as handle:
        return handle.read()


# --- schemas -------------------------------------------------------------
schemas = {
    "schemas/cv-health-input.json": {
        "type": "object",
        "properties": {"probeTarget": {"type": "string", "minLength": 1, "maxLength": 512}},
        "required": [], "additionalProperties": False,
    },
    "schemas/cv-health-output.json": {
        "type": "object",
        "properties": {
            "summary": {"type": "string", "minLength": 1, "maxLength": 4000},
            "findings": {"type": "array", "items": {"type": "string", "maxLength": 1024}, "minItems": 0, "maxItems": 40},
            "nextActions": {"type": "array", "items": {"type": "string", "maxLength": 1024}, "minItems": 1, "maxItems": 20},
            "observations": {"type": "array", "items": {"type": "string", "maxLength": 1024}, "minItems": 1, "maxItems": 40},
        },
        "required": ["summary", "findings", "nextActions", "observations"], "additionalProperties": False,
    },
    "schemas/cv-validation-output.json": {
        "type": "object",
        "properties": {
            "passed": {"type": "boolean"},
            "checks": {"type": "array", "items": {
                "type": "object",
                "properties": {"id": {"type": "string"}, "passed": {"type": "boolean"}, "detail": {"type": "string"}},
                "required": ["id", "passed"], "additionalProperties": False}, "minItems": 1, "maxItems": 20},
        },
        "required": ["passed", "checks"], "additionalProperties": False,
    },
    "schemas/cv-verify-input.json": {
        "type": "object",
        "properties": {
            "kind": {"type": "string", "minLength": 1, "maxLength": 64},
            "report": {"type": "object",
                       "properties": {
                           "summary": {"type": "string", "maxLength": 4000},
                           "findings": {"type": "array", "items": {"type": "string", "maxLength": 1024}},
                           "nextActions": {"type": "array", "items": {"type": "string", "maxLength": 1024}},
                           "observations": {"type": "array", "items": {"type": "string", "maxLength": 1024}},
                       },
                       "required": ["summary", "findings", "nextActions", "observations"],
                       "additionalProperties": False},
        },
        "required": ["report"], "additionalProperties": False,
    },
}
for path, body in schemas.items():
    dump(path, body)

# --- tools ---------------------------------------------------------------
tools = {}
for tool_id, tool_input, tool_output in (
    ("cv.warehouse", "schemas/cv-health-input.json", "schemas/cv-health-output.json"),
    ("cv.integrity", "schemas/cv-health-input.json", "schemas/cv-validation-output.json"),
    ("cv.verify", "schemas/cv-verify-input.json", "schemas/cv-validation-output.json"),
):
    tools[tool_id] = dump(f"config/{tool_id}.yaml", {
        "apiVersion": "brain.keyrus/v1", "kind": "Tool",
        "metadata": {"id": tool_id, "version": "1.0.0"},
        "spec": {
            "effectClass": "read",
            "inputSchemaRef": tool_input,
            "outputSchemaRef": tool_output,
            "requiredCapabilities": ["tool:bash", "tool:python3"],
            "timeoutSeconds": 60, "maxOutputBytes": 1048576,
            "allowedEnvironments": ["cv-insights"],
            "owner": "keyrus_talent_intel", "license": "LicenseRef-Internal",
            "entrypoint": "run.sh",
        },
    })

# --- evaluator -----------------------------------------------------------
# The evaluator verifies the agent's claims against a recomputation of the same
# data. It deliberately does not judge deployment health: a report that says
# "the exports are 59h stale" is a correct report and must verify.
evaluator_digest = dump("config/cv-validator.yaml", {
    "apiVersion": "brain.keyrus/v1", "kind": "Evaluator",
    "metadata": {"id": "cv-validator", "version": "1.0.0"},
    "spec": {
        "tool": {"id": "cv.verify", "digest": tools["cv.verify"]},
        "requiredChecks": ["report-shape", "freshness-claim", "empty-table-claims",
                           "orphan-claims", "actionable-next-actions"],
        "independence": "L1",
    },
})

# --- agents --------------------------------------------------------------
agent_instructions = {
    "cv-health-agent": """# CV Insights Health Operator

Analyze the deployed CV Insights read model. Call each governed read tool exactly once:
cv.warehouse for freshness and row counts, cv.integrity for the four consistency checks.
Use no other tool. Return only a JSON object. No Markdown fences.

The output object must have exactly these four keys: "summary", "findings", "nextActions",
"observations". No other keys are allowed.

- summary: at most two sentences stating the overall state and the single most important reason.
- findings: array of strings, each one a concrete fact you read from a tool, naming the table,
  the check id or the number. Cite row counts, table names and export age exactly as reported.
- nextActions: array of at least one string; each must be something an operator can actually do
  on this deployment.
- observations: array of strings for tool-reported facts that are not findings.

Rules:
- If a tool reports exports older than 48 hours, say the dashboard is serving stale data and
  name the newest export time.
- If a tool reports orphan keys or empty tables, report them as findings. Do not speculate about
  causes you cannot see.
- Never claim a check passed that the tool did not report as passing.
- Never restate a number the tools did not give you.
- Finish the complete JSON object within the output budget; do not enumerate every possible check.
""",
}
agents = {}
for agent_id, body in agent_instructions.items():
    path = f"agents/{agent_id}.md"
    os.makedirs(os.path.join(OUT, "agents"), exist_ok=True)
    with open(os.path.join(OUT, path), "w", encoding="utf8") as handle:
        handle.write(body)
    agents[agent_id] = dump(f"config/{agent_id}.yaml", {
        "apiVersion": "brain.keyrus/v1", "kind": "Agent",
        "metadata": {"id": agent_id, "version": "1.0.0"},
        "spec": {
            "instructionsPath": path,
            "tools": [{"id": "cv.warehouse", "digest": tools["cv.warehouse"]},
                      {"id": "cv.integrity", "digest": tools["cv.integrity"]}],
            "engine": {"anyOf": ["pi"], "features": ["sessions"]},
            "maxTurns": 8, "maxChildren": 0, "maxDepth": 0, "maxTokens": 40000, "maxMicroUsd": 0,
        },
    })

# --- workflows -----------------------------------------------------------
runs_on_agent = {
    "group": "agents", "engine": {"anyOf": ["pi"], "features": ["sessions"]},
    "all": ["os:linux"], "resources": {"cpuMillicores": 500, "memoryMb": 512, "diskMb": 256, "slots": 1},
    "isolation": "ephemeral-container",
}
runs_on_eval = {
    "group": "evaluators", "engine": {"anyOf": ["claude"], "features": ["sessions"]},
    "all": ["os:linux", "tool:bash", "tool:python3"],
    "resources": {"cpuMillicores": 500, "memoryMb": 512, "diskMb": 256, "slots": 1},
    "isolation": "ephemeral-container",
}

dump("config/cv-health.yaml", {
    "apiVersion": "brain.keyrus/v1", "kind": "Workflow",
    "metadata": {"id": "cv-health", "version": "1.0.0"},
    "spec": {
        "inputSchemaRef": "schemas/cv-health-input.json",
        "outputSchemaRef": "schemas/cv-health-output.json",
        "jobs": {
            "inspect": {
                "kind": "dispatch", "needs": [],
                "input": {},
                "outputSchemaRef": "schemas/cv-health-output.json",
                "timeoutSeconds": 180,
                "uses": {"type": "agent", "release": {"id": "cv-health-agent", "digest": agents["cv-health-agent"]}},
                "runsOn": runs_on_agent, "effectClass": "read",
            },
            "validate": {
                "kind": "eval", "needs": ["inspect"],
                "input": {"kind": {"source": "literal", "value": "cv-health"},
                          "report": {"source": "job", "jobId": "inspect", "pointer": ""}},
                "outputSchemaRef": "schemas/cv-validation-output.json",
                "timeoutSeconds": 120,
                "evaluator": {"id": "cv-validator", "digest": evaluator_digest},
                "runsOn": runs_on_eval, "independence": "L1",
            },
        },
        "outputs": {"response": {"source": "job", "jobId": "inspect", "pointer": ""},
                    "passed": {"source": "job", "jobId": "validate", "pointer": "/passed"}},
        "failFast": True, "deadlineSeconds": 400,
        "presentation": {"title": "CV Insights health check",
                         "description": "Read the deployed read model and report freshness, completeness and integrity.",
                         "examples": [{}], "system": False},
    },
})

print(json.dumps({"tools": tools, "agents": agents, "evaluator": evaluator_digest}, indent=1))
print("wrote", OUT)
