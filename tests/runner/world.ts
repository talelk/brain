import { join } from "node:path";
import type { RunnerConfig } from "../../apps/runner/src/config";
import { Runner } from "../../apps/runner/src/runner";
import { FakeGovernor } from "./fake-governor";
import { tempDir } from "./git-repo";

/**
 * A runner on the fixture engine, enrolled with a fake Governor in the same process. There is no launcher: tool scripts and setup
 * commands run directly on this host through the runner's test-only path.
 */
export async function runnerWorld(overrides: Partial<RunnerConfig> = {}): Promise<{ gov: FakeGovernor; runner: Runner; stateDir: string; cfg: RunnerConfig }> {
  const gov = new FakeGovernor();
  const stateDir = tempDir("state");
  const cfg: RunnerConfig = {
    governorUrl: gov.url, stateDir, name: "test-runner", enrollToken: gov.enrollToken, capabilities: ["bash"], engines: ["fixture"], slots: 1, attemptTimeoutMs: 20_000,
    sandbox: { cpuMillicores: 1000, memoryMb: 1024 }, transport: gov.transport, unsandboxedForTests: true, approval: { pollMs: 5, waitMs: 150 }, ...overrides,
  };
  return { gov, runner: await Runner.connect(cfg), stateDir, cfg };
}

/** A script tool's `run.sh` that prints its input back as `{"echo": <input>}`. */
export const ECHO_SCRIPT = '#!/usr/bin/env bash\nset -euo pipefail\ninput="$(cat)"\nprintf \'{"echo": %s}\' "$input"\n';

/** A script that leaves a marker file beside the runner's state, so a test can tell whether it ran. */
export const markerScript = (stateDir: string, name: string): string => `#!/usr/bin/env bash\nset -euo pipefail\ncat > /dev/null\ntouch ${join(stateDir, name)}\nprintf '{"done": true}'\n`;
