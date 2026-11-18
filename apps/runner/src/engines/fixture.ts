import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { JsonValue } from "@brain/contracts";
import { EngineEventStream } from "./event-stream";
import type { EngineAdapter, EngineEvent, EngineSessionSpec, EngineUsage } from "./port";
import { CORRECTION_HEADER } from "./run";
import { engineToolName, ToolRequests } from "./tool-calls";

/**
 * The fixture engine: an engine without a model, for tests and for trying a workspace out. It does what a script tells it, and the
 * script is written in the texts a real model would read: the agent's prompt (`prompt.md`) and the task text (the goal of a Play step,
 * a note, an earlier result). Every line that starts with `FIXTURE` is one command; prompt lines run first, then task lines, in order.
 *
 *   FIXTURE [@<kind>] [#<round>] <command> <arguments>
 *
 * `@<kind>` keeps the line for attempts of that kind only (`@work`, `@plan`, `@check`, `@judge`). A goal is shown to the agent that
 * checks the result as well, so a line in a goal that is meant for the worker is written `FIXTURE @work ...`.
 * `@correction` keeps the line for the corrective session: a plan, check or judge answer that is not the required JSON gets one more
 * session that must return it. That session sees the agent's prompt but not the goal, so a `@correction` line goes in the prompt; no
 * `@<kind>` line applies in it.
 * `#<round>` keeps the line for that round only; `#2+` for round 2 and every later one. Rounds start at 1.
 *
 * Commands:
 *   reply <text>            The final answer. The last `reply` or `json` that applies wins.
 *   json <json>             The final answer is this JSON value (a planner's plan, a checker's verdict, a router's answer).
 *   write <path> <text>     Native tool: writes the file, relative to the working directory (`/work`). Needs `native = "all"`.
 *   delete <path>           Native tool: removes the file. Needs `native = "all"`.
 *   read <path>             Native tool: reads the file. Needs `native = "read"` or `"all"`.
 *   out <name> <text>       Writes a file the agent wants kept (`/out`); the runner uploads it as an artifact.
 *   tool <name> <json>      Calls the workspace or Brain-run tool `<name>` with that input, exactly as a model would.
 *   usage <in> <out> [usd]  Adds input tokens, output tokens and micro-dollars to what the session reports (to reach a limit).
 *   sleep <ms>              Waits (a long attempt, a stop, a lease renewal).
 *   fail <reason>           Ends the session as an engine failure with that reason.
 *
 * In `<text>`, `\n` is a line break and `\\` a backslash; `%last%` is the text the last `tool` or `read` returned and `%round%`
 * the round (written with `%` because `{{ }}` in a Play's goal belongs to the Play). `write`, `delete`, `read` and `tool` each count as
 * one turn.
 *
 * Without a `reply` or `json` the answer depends on the kind: `fixture: done` for work (and for a correction, which therefore fails); a plan of one task for the workspace's
 * `worker` agent (or its first agent) for plan; `{"pass": true, "score": 1, "findings": "fixture check"}` for check; and the first
 * candidate for judge. The kind, the round, the agents and the candidates are read from the task text the runner composes
 * (`task-text.ts`).
 *
 * Example, a Play step checked twice:
 *   goal = """Write the note.
 *   FIXTURE @work write notes/a.md round %round%
 *   FIXTURE @work reply wrote the note
 *   FIXTURE @check #1 json {"pass": false, "score": 0.3, "findings": "say more"}
 *   FIXTURE @check #2+ json {"pass": true, "score": 0.9, "findings": "fine"}"""
 */

interface Command { readonly name: string; readonly args: string }

const LINE = /^[ \t>*-]*FIXTURE[ \t]+(.*)$/gmu;
const KINDS = new Set(["work", "plan", "check", "judge", "correction"]);

/** The attempt's kind and round, as the first line of the composed task text states them. */
export function attemptHeader(task: string): { kind: string; round: number } {
  if (task.startsWith(CORRECTION_HEADER)) return { kind: "correction", round: 1 };
  const header = /^\[(work|plan|check|judge) attempt, round (\d+)\]/mu.exec(task);
  return { kind: header?.[1] ?? "work", round: header ? Number(header[2]) : 1 };
}

/** The commands of a text that apply to an attempt of this kind and round, in order. */
export function fixtureCommands(text: string, kind: string, round: number): Command[] {
  const commands: Command[] = [];
  for (const match of text.matchAll(LINE)) {
    let words = (match[1] ?? "").trim();
    let applies = true;
    for (;;) {
      const scope = /^([@#])(\S+)[ \t]+/u.exec(words);
      if (!scope) break;
      words = words.slice(scope[0].length);
      if (scope[1] === "@") applies &&= KINDS.has(scope[2]!) && scope[2] === kind;
      else {
        const wanted = /^(\d+)(\+?)$/u.exec(scope[2]!);
        applies &&= wanted !== null && (wanted[2] ? round >= Number(wanted[1]) : round === Number(wanted[1]));
      }
    }
    const space = words.search(/[ \t]/u);
    const name = space < 0 ? words : words.slice(0, space);
    if (applies && name) commands.push({ name, args: space < 0 ? "" : words.slice(space + 1).trim() });
  }
  return commands;
}

const unescaped = (text: string): string => text.replace(/\\(n|\\)/gu, (_all, what: string) => (what === "n" ? "\n" : "\\"));
const splitFirst = (args: string): [string, string] => { const space = args.search(/[ \t]/u); return space < 0 ? [args, ""] : [args.slice(0, space), args.slice(space + 1).trim()]; };

function defaultAnswer(kind: string, task: string): string {
  if (kind === "check") return JSON.stringify({ pass: true, score: 1, findings: "fixture check" });
  if (kind === "judge") return JSON.stringify({ keep: /^## Candidate (\S+)/mu.exec(task)?.[1] ?? "", findings: "fixture judge" });
  if (kind === "plan") {
    const lines = task.split("\n");
    const agents: string[] = [];
    for (let at = lines.indexOf("## Agents") + 1; at > 0 && lines[at]?.startsWith("- "); at++) agents.push(lines[at]!.slice(2).split(":")[0]!);
    const goal = /^# Goal\n+([^\n]*)/mu.exec(task)?.[1] ?? "the goal";
    return JSON.stringify({ summary: "fixture plan", tasks: [{ title: goal.slice(0, 60) || "Do the work", goal, agent: agents.includes("worker") ? "worker" : agents[0] ?? "worker", after: [] }] });
  }
  return "fixture: done";
}

export class FixtureEngine implements EngineAdapter {
  readonly id = "fixture";
  private stream = new EngineEventStream();
  private requests: ToolRequests | undefined;
  private abort: AbortController | undefined;

  async probe() { return { id: this.id, ready: true }; }

  async start(spec: EngineSessionSpec, signal: AbortSignal): Promise<void> {
    const stream = new EngineEventStream();
    const abort = new AbortController();
    this.stream = stream;
    this.abort = abort;
    signal.addEventListener("abort", () => abort.abort(), { once: true });
    this.requests = new ToolRequests(spec.tools, (event) => stream.push(event));
    void this.run(spec, stream, abort.signal, this.requests);
  }

  private async run(spec: EngineSessionSpec, stream: EngineEventStream, signal: AbortSignal, requests: ToolRequests): Promise<void> {
    const push = (event: EngineEvent): void => stream.push(event);
    const { kind, round } = attemptHeader(spec.task);
    let answer: string | undefined;
    let last = "";
    let native = 0;
    const usage = { inputTokens: Math.ceil((spec.instructions.length + spec.task.length) / 4), outputTokens: 0, cachedInputTokens: 0, microUsd: 0, turns: 1 };
    const report = (): void => push({ kind: "usage", ...usage } satisfies EngineEvent & EngineUsage);
    const text = (raw: string): string => unescaped(raw).replaceAll("%last%", last).replaceAll("%round%", String(round));
    /** A path of the script, kept inside the directory it is relative to. */
    const inside = (root: string | undefined, path: string, what: string): string => {
      if (!root) throw new Error(`the script uses ${what} but this attempt has no working copy`);
      const target = resolve(root, path);
      if (target !== root && !target.startsWith(root + sep)) throw new Error(`the script's ${what} path ${path} leaves the directory`);
      // A link in the working copy (a repository can commit one) must not carry the script out: no existing part of the path may be one.
      let walked = resolve(root);
      for (const part of relative(walked, target).split(sep).filter(Boolean)) {
        walked = join(walked, part);
        let link = false;
        try { link = lstatSync(walked).isSymbolicLink(); } catch { break; }
        if (link) throw new Error(`the script's ${what} path ${path} goes through a symbolic link`);
      }
      return target;
    };
    const nativeCall = (name: string, input: JsonValue, needs: "read" | "all", run: () => string): void => {
      if (spec.native === "none" || (needs === "all" && spec.native !== "all")) throw new Error(`the script uses ${name} but the agent's native tools are "${spec.native}"`);
      const callId = `native-${++native}`;
      push({ kind: "native.call", callId, name, input });
      let ok = true;
      let output: string;
      try { output = run(); } catch (error) { ok = false; output = error instanceof Error ? error.message : String(error); }
      push({ kind: "native.result", callId, ok, output });
      last = output;
      usage.turns += 1;
      report();
    };
    try {
      for (const command of [...fixtureCommands(spec.instructions, kind, round), ...fixtureCommands(spec.task, kind, round)]) {
        if (signal.aborted) break;
        const [first, rest] = splitFirst(command.args);
        switch (command.name) {
          case "reply": answer = text(command.args); break;
          case "json": answer = JSON.stringify(JSON.parse(text(command.args)) as JsonValue); break;
          case "write": nativeCall("write", { path: first, content: text(rest) }, "all", () => { const file = inside(spec.workDir, first, "write"); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text(rest)); return `wrote ${first}`; }); break;
          case "delete": nativeCall("delete", { path: first }, "all", () => { rmSync(inside(spec.workDir, first, "delete")); return `deleted ${first}`; }); break;
          case "read": nativeCall("read", { path: first }, "read", () => readFileSync(inside(spec.workDir, first, "read"), "utf8")); break;
          case "out": { const file = inside(spec.outDir, first, "out"); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text(rest)); break; }
          case "tool": {
            push({ kind: "text", channel: "diagnostic", text: `calling ${first}` });
            last = await requests.execute(engineToolName(first), (rest ? JSON.parse(text(rest)) : {}) as JsonValue);
            usage.turns += 1;
            report();
            break;
          }
          case "usage": {
            const [input = 0, output = 0, microUsd = 0] = command.args.split(/\s+/u).map(Number);
            usage.inputTokens += input; usage.outputTokens += output; usage.microUsd += microUsd;
            report();
            break;
          }
          case "sleep": await new Promise<void>((done) => { const timer = setTimeout(done, Number(command.args) || 0); signal.addEventListener("abort", () => { clearTimeout(timer); done(); }, { once: true }); }); break;
          case "fail": throw new Error(command.args || "the fixture script failed");
          default: throw new Error(`unknown fixture command ${command.name}`);
        }
      }
      if (signal.aborted) { push({ kind: "stopped", reason: "cancelled", detail: "the session was cancelled" }); return; }
      const final = answer ?? defaultAnswer(kind, spec.task);
      usage.outputTokens += Math.ceil(final.length / 4);
      push({ kind: "text", channel: "assistant", text: final });
      report();
      push({ kind: "stopped", reason: "completed" });
    } catch (error) {
      report();
      push({ kind: "stopped", reason: "error", detail: error instanceof Error ? error.message : String(error) });
    } finally {
      stream.close();
    }
  }

  events(signal: AbortSignal): AsyncIterable<EngineEvent> { return this.stream.read(signal); }

  async toolResult(callId: string, text: string): Promise<void> {
    if (!this.requests) throw new Error("no fixture session is running");
    this.requests.complete(callId, text);
  }

  async cancel(): Promise<void> {
    this.abort?.abort();
    this.requests?.clear();
  }

  async dispose(): Promise<void> { await this.cancel(); this.stream.close(); }
}
