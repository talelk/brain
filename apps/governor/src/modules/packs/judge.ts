// Optional calibrated model judge (T44): advisory rubric assessment against
// pinned evidence, using the local OpenAI-compatible model endpoint. The
// judge never advances dossier state; its transcript is stored as CAS
// evidence and its outcome is recorded through the same rubric-result path
// as any evaluator. Unparseable or low-information replies fail closed as
// "incomplete" (inconclusive), never as passed.

export const JUDGE_PROMPT_VERSION = "brain.judge/v1";

export type JudgeOutcome = "passed" | "failed" | "incomplete";

export interface JudgeVerdict {
  outcome: JudgeOutcome;
  rationale: string;
  raw: string;
}

export function buildJudgePrompt(criterionText: string, evidenceText: string): string {
  return [
    "You are an independent rubric judge. Decide only from the evidence below.",
    "Reply with exactly one JSON object: {\"verdict\":\"pass\"|\"fail\"|\"inconclusive\",\"rationale\":\"<one sentence>\"}.",
    "Use \"inconclusive\" when the evidence does not settle the criterion.",
    "",
    `CRITERION: ${criterionText}`,
    "",
    "EVIDENCE:",
    evidenceText,
  ].join("\n");
}

export function parseJudgeResponse(raw: string): { outcome: JudgeOutcome; rationale: string } {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return { outcome: "incomplete", rationale: "judge reply contained no JSON verdict" };
  }
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { verdict?: string; rationale?: string };
    const rationale = typeof parsed.rationale === "string" && parsed.rationale ? parsed.rationale.slice(0, 500) : "judge gave no rationale";
    if (parsed.verdict === "pass") return { outcome: "passed", rationale };
    if (parsed.verdict === "fail") return { outcome: "failed", rationale };
    return { outcome: "incomplete", rationale };
  } catch {
    return { outcome: "incomplete", rationale: "judge reply was not valid JSON" };
  }
}

export interface JudgeOptions {
  modelUrl?: string;
  modelId?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function judgeModelUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env["BRAIN_LOCAL_MODEL_URL"] ?? "http://tntungx10:8000/v1";
}

export function judgeModelId(env: NodeJS.ProcessEnv = process.env): string {
  return env["BRAIN_JUDGE_MODEL"] ?? env["BRAIN_LOCAL_MODEL_ID"] ?? "qwen3.8-flash-next-a5b";
}

export async function runLocalJudge(
  input: { criterionText: string; evidenceText: string },
  opts: JudgeOptions = {},
): Promise<JudgeVerdict> {
  const modelUrl = (opts.modelUrl ?? judgeModelUrl()).replace(/\/$/, "");
  const modelId = opts.modelId ?? judgeModelId();
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(`${modelUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: modelId,
      temperature: 0,
      // Reasoning models spend tokens before the final answer; 512 can
      // truncate the verdict entirely (observed content:null on vLLM).
      max_tokens: 2048,
      messages: [{ role: "user", content: buildJudgePrompt(input.criterionText, input.evidenceText) }],
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
  });
  if (!res.ok) throw new Error(`judge model endpoint returned ${res.status}`);
  const body = (await res.json()) as { choices?: Array<{ message?: { content?: string | null; reasoning?: string | null; reasoning_content?: string | null } }> };
  const message = body.choices?.[0]?.message;
  const raw = message?.content ?? message?.reasoning_content ?? message?.reasoning ?? "";
  if (!raw) throw new Error("judge model endpoint returned no content");
  const { outcome, rationale } = parseJudgeResponse(raw);
  return { outcome, rationale, raw };
}
