import { createResource } from "solid-js";
import type { Accessor } from "solid-js";
import type { VerificationVerdict } from "@brain/contracts";
import { evidenceQuery } from "../../data/governor";
import type { ArtifactHistory } from "../../data/exec-outputs";
import { trustLineOf } from "./result-model";
import type { TrustLine } from "./result-model";

/**
 * The trust line for an artifact, from its history and the reviewer's own
 * verdict (one `evidence.get` per newest checked bundle). Undefined until the
 * history has loaded, so a result never flashes "not checked yet" while its
 * verdict is still on the way.
 */
export function createTrust(history: Accessor<ArtifactHistory | undefined>): Accessor<TrustLine | undefined> {
  const [verdict] = createResource(
    () => {
      const loaded = history();
      const checked = loaded?.history.find((version) => version.verification);
      return loaded && checked ? { digest: checked.bundleDigest, workspaceId: loaded.workspaceId } : false;
    },
    async (key): Promise<VerificationVerdict | undefined> => {
      try {
        return (await evidenceQuery(key.digest, key.workspaceId)).snapshot.verdict;
      } catch {
        return undefined;
      }
    },
  );
  return () => {
    const loaded = history();
    if (!loaded || verdict.loading) return undefined;
    return trustLineOf(loaded, verdict());
  };
}
