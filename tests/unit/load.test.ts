import { canonicalJsonBytes, fieldSchema, sha256Digest, type JsonValue } from "@brain/contracts";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadWorkspace, referencedSecrets } from "../../apps/governor/src/workspace/load";

const packsDir = fileURLToPath(new URL("../fixtures/packs", import.meta.url));
const folder = (files: Record<string, string>) => new Map(Object.entries(files).map(([path, content]) => [path, new TextEncoder().encode(content)]));
const load = (files: Record<string, string>) => loadWorkspace(folder(files), packsDir);
const digestOf = (files: Record<string, string>) => sha256Digest(canonicalJsonBytes(load(files).manifest as unknown as JsonValue));
const problemsOf = (files: Record<string, string>) => load(files).problems.map((problem) => `${problem.path}: ${problem.message}`);

const brain = 'name = "Test"\npacks = ["extra"]\n';
const agentToml = 'description = "Writes."\nengine = ["fixture"]\ntools = ["echo"]\n';
const play = (steps: string, head = "") => `title = "A Play"\n${head}\n${steps}`;

describe("a workspace folder with its packs", () => {
  it("loads a valid folder into a manifest", () => {
    const { manifest, problems } = load({ "brain.toml": brain });
    expect(problems).toEqual([]);
    expect(manifest?.packs).toEqual(["core", "extra"]);
    expect(Object.keys(manifest?.agents ?? {}).sort()).toEqual(["checker", "reviewer", "worker"]);
    expect(Object.keys(manifest?.tools ?? {}).sort()).toEqual(["echo", "task.note"]);
    expect(Object.keys(manifest?.plays ?? {}).sort()).toEqual(["hello", "review"]);
    expect(manifest?.memory).toMatchObject([{ name: "welcome", title: "Welcome", source: "core" }]);
    expect(manifest?.tools["echo"]?.files.map((file) => file.path)).toEqual(["run.sh", "test.sh"]);
    expect(manifest?.tools["task.note"]).toMatchObject({ runs: "brain", files: [] });
  });

  it("a pack pulls in the packs it requires, and its file replaces theirs", () => {
    const loaded = load({ "brain.toml": brain });
    expect(loaded.manifest?.agents["worker"]?.source).toBe("core");
    expect(new TextDecoder().decode(loaded.blobs.get(loaded.manifest?.agents["worker"]?.prompt.digest ?? ""))).toBe("You do the work, the extra way.\n");
  });

  it("a workspace file replaces the pack file of the same path, and only that file", () => {
    const loaded = load({ "brain.toml": brain, "agents/worker/prompt.md": "You work for this workspace." });
    expect(loaded.problems).toEqual([]);
    expect(loaded.files.get("agents/worker/prompt.md")).toMatchObject({ source: "workspace", replaces: "extra" });
    expect(loaded.files.get("agents/worker/agent.toml")).toMatchObject({ source: "core" });
    expect(loaded.manifest?.agents["worker"]?.tools).toEqual(["task.note", "echo"]);
    expect(new TextDecoder().decode(loaded.blobs.get(loaded.manifest?.agents["worker"]?.prompt.digest ?? ""))).toBe("You work for this workspace.");
  });

  it("the same content gives the same snapshot digest, and a changed prompt changes it", () => {
    const files = { "brain.toml": brain, "agents/writer/agent.toml": agentToml, "agents/writer/prompt.md": "Write well." };
    const reordered = { "agents/writer/prompt.md": "Write well.", "agents/writer/agent.toml": agentToml, "brain.toml": brain };
    expect(digestOf(files)).toBe(digestOf(reordered));
    expect(digestOf({ ...files, "agents/writer/prompt.md": "Write very well." })).not.toBe(digestOf(files));
    expect(digestOf({ ...files, "README.md": "Not a file Brain reads." })).toBe(digestOf(files));
  });

  it("reads a standing approval, its end date written as a TOML date", () => {
    const { manifest, problems } = load({ "brain.toml": `${brain}[approvals."echo"]\ntargets = ["staging-1"]\nper_day = 3\nuntil = 2027-01-31\n` });
    expect(problems).toEqual([]);
    expect(manifest?.approvals).toEqual({ echo: { targets: ["staging-1"], per_day: 3, until: "2027-01-31" } });
  });

  it("collects the secrets a snapshot refers to", () => {
    const { manifest } = load({ "brain.toml": `${brain}[[model]]\nname = "main"\nprovider = "openai-compatible"\nurl = "https://m.example/v1"\nmodel = "m"\nkey = "secret:model-main"\n[teams]\nwebhook = "secret:teams"\n` });
    expect(manifest && referencedSecrets(manifest)).toEqual(["model-main", "teams"]);
  });
});

describe("a folder is refused, with the file and what to fix, when", () => {
  it.each<[string, Record<string, string>, RegExp]>([
    ["it has no brain.toml", {}, /^brain\.toml: the workspace has no brain\.toml/u],
    ["brain.toml is not TOML", { "brain.toml": 'name = "Test' }, /^brain\.toml: not valid TOML at line 1:/u],
    ["brain.toml has an unknown key", { "brain.toml": `${brain}colour = "blue"\n` }, /^brain\.toml: Unrecognized key/u],
    ["a pack does not exist", { "brain.toml": 'name = "T"\npacks = ["nowhere"]\n' }, /^brain\.toml: pack "nowhere" does not exist/u],
    ["an agent names a tool that does not exist", { "brain.toml": brain, "agents/writer/agent.toml": agentToml.replace("echo", "deploy.restart"), "agents/writer/prompt.md": "x" }, /^agents\/writer\/agent\.toml: tool "deploy\.restart" does not exist/u],
    ["an agent names a model that is not configured", { "brain.toml": brain, "agents/writer/agent.toml": `${agentToml}model = "big"\n`, "agents/writer/prompt.md": "x" }, /model "big" is not a \[\[model\]\]/u],
    ["an agent has no prompt", { "brain.toml": brain, "agents/writer/agent.toml": agentToml }, /^agents\/writer\/agent\.toml: agent "writer" has no prompt\.md/u],
    ["an agent has a prompt and no agent.toml", { "brain.toml": brain, "agents/writer/prompt.md": "x" }, /^agents\/writer\/prompt\.md: agent "writer" has no agent\.toml/u],
    ["a tool has no run.sh", { "brain.toml": brain, "tools/deploy.restart/tool.toml": 'description = "x"\neffect = "privileged"\n' }, /^tools\/deploy\.restart\/tool\.toml: the tool needs a run\.sh/u],
    ["a tool Brain does not implement says runs = brain", { "brain.toml": brain, "tools/deploy.restart/tool.toml": 'description = "x"\neffect = "read"\nruns = "brain"\n' }, /runs = "brain" is only for the tools Brain implements/u],
    ["a tool Brain runs has a run.sh", { "brain.toml": brain, "tools/task.note/run.sh": "echo" }, /^packs\/core\/tools\/task\.note\/tool\.toml: a tool Brain runs has no run\.sh/u],
    ["a script has no tool.toml", { "brain.toml": brain, "tools/deploy.restart/run.sh": "echo" }, /tool "deploy\.restart" has no tool\.toml/u],
    ["a standing approval names a tool that does not exist", { "brain.toml": `${brain}[approvals."deploy.restart"]\ntargets = ["a"]\nper_day = 1\nuntil = 2027-01-31\n` }, /approvals names tool "deploy\.restart"/u],
    ["two models share a name", { "brain.toml": `${brain}${'[[model]]\nname = "main"\nprovider = "anthropic"\nurl = "https://m.example"\nmodel = "m"\n'.repeat(2)}` }, /two models are named "main"/u],
    ["a memory entry has no title", { "brain.toml": brain, "memory/notes.md": "no title here" }, /^memory\/notes\.md: a memory entry starts with its title/u],
    ["a step names an agent that does not exist", { "brain.toml": brain, "plays/p.toml": play('[[step]]\nid = "a"\nagent = "ghost"\n') }, /^plays\/p\.toml: step "a": agent "ghost" does not exist/u],
    ["a step has neither an agent nor a list of candidates", { "brain.toml": brain, "plays/p.toml": play('[[step]]\nid = "a"\n') }, /step "a": needs an agent/u],
    ["review_by does not exist", { "brain.toml": brain, "plays/p.toml": play('[[step]]\nid = "a"\nagent = "worker"\nreview_by = "ghost"\n') }, /agent "ghost" does not exist/u],
    ["review_by is the agent that does the step", { "brain.toml": brain, "plays/p.toml": play('[[step]]\nid = "a"\nagent = "worker"\nreview_by = "worker"\n') }, /review_by must differ from the agent/u],
    ["the judge does not exist", { "brain.toml": brain, "plays/p.toml": play('[[step]]\nid = "a"\nagent = "worker"\ncandidates = 2\njudge = "ghost"\n') }, /agent "ghost" does not exist/u],
    ["the judge is one of the candidates", { "brain.toml": brain, "plays/p.toml": play('[[step]]\nid = "a"\ncandidates = ["worker", "reviewer"]\njudge = "reviewer"\n') }, /judge must differ from the agents that attempt the step/u],
    ["candidates have no judge", { "brain.toml": brain, "plays/p.toml": play('[[step]]\nid = "a"\nagent = "worker"\ncandidates = 3\n') }, /candidates needs a judge/u],
    ["after names a step that is not earlier", { "brain.toml": brain, "plays/p.toml": play('[[step]]\nid = "a"\nagent = "worker"\nafter = ["b"]\n[[step]]\nid = "b"\nagent = "worker"\nafter = ["a"]\n') }, /step "a": after names "b", which is not an earlier step/u],
    ["two steps share an id", { "brain.toml": brain, "plays/p.toml": play('[[step]]\nid = "a"\nagent = "worker"\n[[step]]\nid = "a"\nagent = "worker"\n') }, /another step has the same id/u],
    ["a goal uses an input the Play does not declare", { "brain.toml": brain, "plays/p.toml": play('[[step]]\nid = "a"\nagent = "worker"\ngoal = "Fix {{issue}}"\n') }, /\{\{issue\}\} is not an input of this Play/u],
    ["a goal reads a field of an input that is not an object", { "brain.toml": brain, "plays/p.toml": play('[[step]]\nid = "a"\nagent = "worker"\ngoal = "Fix {{issue.title}}"\n', '[inputs.issue]\ntype = "string"\n') }, /reads a field of input "issue", which is not of type object/u],
    ["a goal reads a step this one does not wait for", { "brain.toml": brain, "plays/p.toml": play('[[step]]\nid = "a"\nagent = "worker"\n[[step]]\nid = "b"\nagent = "worker"\ngoal = "Use {{steps.a.result}}"\n') }, /step "b": \{\{steps\.a\.result\}\} reads step "a", which this step does not wait for/u],
    ["a goal has a placeholder that is not a value", { "brain.toml": brain, "plays/p.toml": play('[[step]]\nid = "a"\nagent = "worker"\ngoal = "Use {{steps.a.output}}"\n') }, /is not a value/u],
    ["{{item}} is used outside a for_each step", { "brain.toml": brain, "plays/p.toml": play('[[step]]\nid = "a"\nagent = "worker"\ngoal = "Do {{item.title}}"\n') }, /only available in a step with for_each/u],
    ["when is not one comparison", { "brain.toml": brain, "plays/p.toml": play('[[step]]\nid = "a"\nagent = "worker"\n[[step]]\nid = "b"\nagent = "worker"\nafter = ["a"]\nwhen = "steps.a.result.ok"\n') }, /when must be one comparison/u],
    ["when reads a step this one does not wait for", { "brain.toml": brain, "plays/p.toml": play('[[step]]\nid = "a"\nagent = "worker"\n[[step]]\nid = "b"\nagent = "worker"\nwhen = "steps.a.result.ok == true"\n') }, /when \(.*\) reads step "a"/u],
    ["for_each does not name an earlier result", { "brain.toml": brain, "plays/p.toml": play('[[step]]\nid = "a"\nagent = "worker"\nfor_each = "issue"\n', '[inputs.issue]\ntype = "array"\n') }, /for_each must name a list in an earlier result/u],
    ["an input is named like a reserved word", { "brain.toml": brain, "plays/p.toml": play('[[step]]\nid = "a"\nagent = "worker"\n', '[inputs.item]\ntype = "string"\n') }, /an input cannot be named "item"/u],
  ])("%s", (_name, files, expected) => {
    const loaded = load(files);
    expect(loaded.manifest).toBeUndefined();
    expect(problemsOf(files).join("\n")).toMatch(expected);
  });

  it("accepts the template forms a Play may use", () => {
    const steps = [
      '[[step]]\nid = "plan"\nagent = "worker"\ngoal = "Plan {{feature}} for {{delivery.pull_request.title}}"',
      '[[step]]\nid = "build"\nagent = "worker"\nafter = ["plan"]\nfor_each = "steps.plan.result.tasks"\ngoal = "Do {{item.title}}: {{item}}"',
      '[[step]]\nid = "wrap"\nagent = "worker"\nafter = ["build"]\nwhen = \'steps.plan.result.kind != "none"\'\ngoal = "Sum up {{steps.plan.result.summary}} and {{steps.build.result}}"',
    ].join("\n");
    expect(problemsOf({ "brain.toml": brain, "plays/p.toml": play(steps, '[inputs.feature]\ntype = "string"\n[trigger]\nwebhook = "github.pull_request.opened"\n') })).toEqual([]);
  });
});

describe("tool inputs", () => {
  it("compile to the JSON Schema a call must satisfy", () => {
    const { manifest } = load({ "brain.toml": brain });
    expect(manifest?.tools["echo"]?.input_schema).toEqual({
      type: "object",
      properties: { mode: { type: "string", enum: ["plain", "loud"] }, words: { type: "array", description: "Words to return.", items: { type: "string" } } },
      required: ["words"],
      additionalProperties: false,
    });
    expect(fieldSchema({}, "inputs")).toEqual({ type: "object", properties: {}, required: [], additionalProperties: false });
  });
});

describe("a step's declared outputs", () => {
  const play = (rest: string) => `title = "Check"
[[step]]
id = "check"
agent = "dev"
goal = "Check."
outputs.healthy = { type = "boolean", required = true }
outputs.names = { type = "array", items = { type = "string" } }
outputs.kind = { type = "string", enum = ["web", "db"] }
[[step]]
id = "act"
agent = "dev"
after = ["check"]
${rest}`;
  const problems = (rest: string) => problemsOf({ "brain.toml": 'name = "T"\n', "agents/dev/agent.toml": 'description = "Dev."\n', "agents/dev/prompt.md": "Work.\n", "plays/check.toml": play(rest) });

  it("lets later steps read the declared fields, by their types", () => {
    expect(problems('goal = "Fix {{item}} after {{steps.check.result}}"\nfor_each = "steps.check.result.names"\nwhen = "steps.check.result.healthy == false"\n')).toEqual([]);
  });

  it("refuses a field the step does not declare, a list that is none, and a comparison that can never hold", () => {
    expect(problems('goal = "{{steps.check.result.summary}}"\n')).toEqual([expect.stringContaining('reads the field "summary", which step "check" does not declare')]);
    expect(problems('goal = "x"\nfor_each = "steps.check.result.healthy"\n')).toEqual([expect.stringContaining("names a boolean, not a list")]);
    expect(problems('goal = "x"\nwhen = \'steps.check.result.healthy == "no"\'\n')).toEqual([expect.stringContaining("compares a boolean with a string")]);
    expect(problems('goal = "x"\nwhen = \'steps.check.result.kind == "cache"\'\n')).toEqual([expect.stringContaining("a value the field never has")]);
  });

  it("takes an agent's engines as pi and claude when the file names none", () => {
    expect(load({ "brain.toml": 'name = "T"\n', "agents/dev/agent.toml": 'description = "Dev."\n', "agents/dev/prompt.md": "Work.\n" }).manifest?.agents["dev"]?.engine).toEqual(["pi", "claude"]);
  });
});
