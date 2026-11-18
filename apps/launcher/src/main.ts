import { ENGINE_LABEL } from "./engine-sandbox";
import { removeLeftovers } from "./sandbox-common";
import { startLauncher } from "./server";
import { TOOL_LABEL } from "./tool-sandbox";

await startLauncher();

// Stopped, the launcher takes its containers with it: nothing of it can be reattached, and a container left behind holds a grant at the proxy.
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void Promise.all([removeLeftovers(ENGINE_LABEL), removeLeftovers(TOOL_LABEL)]).finally(() => process.exit(0));
  });
}
