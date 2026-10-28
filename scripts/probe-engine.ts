import { selectEngine } from "../apps/runner/src/engines/run";
const id = process.env["BRAIN_RUNNER_ENGINE"] ?? "pi";
const engine = selectEngine(id);
if (!engine) throw new Error(`Unknown runner engine: ${id}`);
const probe = await engine.probe();
if (!probe.features.includes("sessions")) throw new Error(`${id} unavailable: ${probe.version}. Check model URL/ID or provider credential.`);
console.log(`${id} ${probe.version}: model ${engine.defaultModelId ?? "fixture"} available`);
