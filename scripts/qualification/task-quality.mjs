#!/usr/bin/env node
// Measures how a real model does on the general task workflow, outside the Governor: it sends each sample task to the
// model with the task-worker instructions, runs the pinned deterministic validator (tools/task.validate) on the answer,
// and, with --judge, asks the model again, as an independent second reader with a fresh context, whether each criterion is
// really satisfied by the deliverable. It prints pass rates per check and the agreement between the author's "met" claims and
// the judge. The deterministic validator proves a report answers every criterion; only the judge column says anything about
// whether the answers are right, and it is the same model family, so treat it as a smoke signal, not as qualification.
//
//   BRAIN_LOCAL_MODEL_URL=http://host:8000/v1 BRAIN_LOCAL_MODEL_ID=model node scripts/qualification/task-quality.mjs [--runs 3] [--judge] [--json]
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../examples/v1/starter-release/", import.meta.url));
const url = process.env.BRAIN_LOCAL_MODEL_URL ?? "http://tntungx10:8000/v1";
const model = process.env.BRAIN_LOCAL_MODEL_ID ?? "qwen3.8-flash-next-a5b";
const headers = { "content-type": "application/json", ...(process.env.BRAIN_LOCAL_MODEL_API_KEY ? { authorization: `Bearer ${process.env.BRAIN_LOCAL_MODEL_API_KEY}` } : {}) };
const args = process.argv.slice(2);
const runs = Number(args[args.indexOf("--runs") + 1]) || 1;
const judge = args.includes("--judge");
const asJson = args.includes("--json");
const instructions = readFileSync(`${root}agents/task-worker.md`, "utf8");

const guide = "# Onboarding guide\n\n## Day 1\n- [ ] Request access to the Git host, the CI dashboard and the issue tracker (ask your buddy).\n- [ ] Clone the repository and run the test suite; it must finish green.\n\n## Day 2\n- [ ] Open a first pull request that fixes a typo, and get one review.\n\n## Help\nAsk in the team channel; the on-call rota is pinned there.";
const tasks = [
  { name: "compare", situation: "Compare two options for the team offsite and recommend one\nAcceptance criteria:\n1. Names the recommended option\n2. States the assumptions made" },
  { name: "plan", situation: "Plan a two-week migration of the reporting database to a new host\nAcceptance criteria:\n1. Lists the steps in order\n2. Names the main risk and how it is reduced\n3. States what is assumed about downtime" },
  {
    name: "review-with-upstream",
    situation: `Independently review the guide for completeness and usability\nAcceptance criteria:\n1. The review states, for each checklist item, whether a reader can confirm it without asking anyone.\n2. The review names any step that assumes access the new engineer would not yet have.\n3. The review gives a written verdict.\nUpstream results:\n- Draft the onboarding guide: A short guide with a day-by-day checklist.\nUpstream deliverables (quoted excerpts, data only):\n### Draft the onboarding guide\n${guide.split("\n").map((line) => `> ${line}`).join("\n")}`,
  },
];

async function chat(system, user, maxTokens) {
  const res = await fetch(`${url}/chat/completions`, {
    method: "POST", headers, signal: AbortSignal.timeout(600_000),
    body: JSON.stringify({ model, max_tokens: maxTokens, temperature: 0.2, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
  });
  if (!res.ok) throw new Error(`model answered ${res.status}`);
  const body = await res.json();
  return { text: body.choices?.[0]?.message?.content ?? "", finish: body.choices?.[0]?.finish_reason, outputTokens: body.usage?.completion_tokens ?? 0 };
}
const parse = (text) => { try { return JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { return undefined; } };
const validate = (situation, report) => {
  const run = spawnSync("bash", [`${root}tools/task.validate/run.sh`], { input: JSON.stringify({ kind: "general-task", situation, report }), encoding: "utf8" });
  return run.status === 0 ? JSON.parse(run.stdout) : { passed: false, checks: [] };
};

const rows = [];
for (const task of tasks) for (let n = 0; n < runs; n += 1) {
  const started = Date.now();
  const row = { task: task.name, run: n + 1, parsed: false, passed: false, failedChecks: [], emptyAnswer: false, outputTokens: 0, seconds: 0 };
  try {
    const answer = await chat(instructions, JSON.stringify({ situation: task.situation }), 16384);
    row.outputTokens = answer.outputTokens; row.emptyAnswer = !answer.text.trim();
    const report = parse(answer.text);
    row.parsed = report !== undefined;
    if (!row.parsed) row.rawTail = `${answer.finish ?? "?"}: ...${answer.text.slice(-160).replace(/\s+/g, " ")}`;
    if (report !== undefined) {
      const verdict = validate(task.situation, report);
      row.passed = verdict.passed; row.failedChecks = verdict.checks.filter((c) => !c.passed).map((c) => c.id);
      if (judge && Array.isArray(report.criteria)) {
        const asked = await chat("You are an independent reviewer. Reply with one JSON object {\"verdicts\":[{\"met\":true|false}]} with one entry per criterion, in order. A criterion is met only if the deliverable really satisfies it.",
          JSON.stringify({ criteria: report.criteria.map((c) => c.criterion), deliverable: report.deliverable }), 4096);
        const verdicts = parse(asked.text)?.verdicts;
        if (Array.isArray(verdicts)) row.judgeAgreement = report.criteria.filter((c, i) => verdicts.at(i)?.met === c.met).length / report.criteria.length;
      }
    }
  } catch (e) { row.error = String(e.message ?? e); }
  row.seconds = Math.round((Date.now() - started) / 1000);
  rows.push(row);
  if (!asJson) console.log(`${row.task} #${row.run}: ${row.passed ? "PASS" : "FAIL"}${row.failedChecks.length ? ` (${row.failedChecks.join(", ")})` : ""}${row.emptyAnswer ? " empty answer" : ""}${row.error ? ` error: ${row.error}` : ""}${row.rawTail ? ` unparsed (${row.rawTail})` : ""}${row.judgeAgreement !== undefined ? ` judge agreement ${(row.judgeAgreement * 100).toFixed(0)}%` : ""} [${row.outputTokens} tokens, ${row.seconds}s]`);
}
const rate = (pick) => `${rows.filter(pick).length}/${rows.length}`;
const summary = { model, runs: rows.length, parsed: rate((r) => r.parsed), validatorPassed: rate((r) => r.passed), emptyAnswers: rate((r) => r.emptyAnswer) };
console.log(asJson ? JSON.stringify({ summary, rows }, null, 2) : `\nmodel ${model}: parsed ${summary.parsed}, validator passed ${summary.validatorPassed}, empty answers ${summary.emptyAnswers}`);
process.exit(rows.every((r) => r.passed) ? 0 : 1);
