import { startSupervisor } from "./supervisor";
import { applyLocalConfiguration, localRevision, readLocalConfiguration } from "./local-configuration";

if (process.env["BRAIN_LOCAL_RUNNER"] === "true") {
  const stateDirectory = process.env["BRAIN_RUNNER_STATE_DIR"];
  if (!stateDirectory) throw new Error("Local runner state directory is required");
  console.log("Waiting for an administrator to connect the local model in Brain.");
  for (;;) {
    try {
      const configuration = readLocalConfiguration(stateDirectory);
      if (!configuration) { await new Promise((resolve) => setTimeout(resolve, 1000)); continue; }
      applyLocalConfiguration(configuration, stateDirectory);
      await startSupervisor(() => localRevision(stateDirectory) !== configuration.revision);
    } catch { console.error("Local runner setup failed. Check model setup and runner health in Brain."); await new Promise((resolve) => setTimeout(resolve, 3000)); }
  }
} else await startSupervisor();
