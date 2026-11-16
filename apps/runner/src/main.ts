import { configFromEnv } from "./config";
import { Runner } from "./runner";

const cfg = configFromEnv();
const stop = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => stop.abort());
const runner = await Runner.connect(cfg);
console.log(`Brain runner ${cfg.name} (${runner.runnerId}) connected to ${cfg.governorUrl}`);
await runner.run(stop.signal);
