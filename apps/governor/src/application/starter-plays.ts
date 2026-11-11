import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ActorContext, Play } from "@brain/contracts";
import { parse } from "yaml";
import { handlersFor, type CommandHandlers } from "./command-funnel";
import { requireWorkspaceRead } from "./authz";
import type { Store } from "./store";
import { BrainDomainError } from "../domain/errors";
import { activateRelease, activeReleaseAssets, activeReleaseRecord, activeSourceDocuments, releaseAssets, stageRelease, type SourceDoc } from "../modules/configuration/index";

/**
 * The starter Plays (row 49): six ready-made mission templates shipped as ordinary release documents under
 * `examples/v1/starter-release/config/plays/`. A fresh install gets them with the starter release. An existing
 * workspace gets them with one click: "Add starter Plays" merges the missing documents into the active release's
 * source, stages that as a new release and activates it (compare-and-swap on the digest it started from). They are
 * normal Plays afterwards, listed in the Library and editable in the Studio. A Play whose agent, engine or workflow
 * is not in the active release is skipped, and the reason is reported, never installed half-working.
 */
const DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "../../../../examples/v1/starter-release/config/plays");

export interface StarterPlay { readonly playId: string; readonly title: string; readonly document: SourceDoc; readonly play: Play }
export interface StarterPlayStatus {
  readonly total: number;
  readonly installed: number;
  readonly installable: number;
  readonly blocked: ReadonlyArray<{ readonly playId: string; readonly reason: string }>;
}

/** The shipped starter Play documents, read from the repository. */
export function starterPlays(): StarterPlay[] {
  return readdirSync(DIRECTORY).filter((name) => /\.ya?ml$/iu.test(name)).sort().map((name) => {
    const text = readFileSync(join(DIRECTORY, name), "utf8");
    const play = parse(text) as Play & { metadata: { id: string } };
    return { playId: play.metadata.id, title: play.spec.title, document: { path: `config/plays/${name}`, text }, play };
  });
}

type Release = NonNullable<ReturnType<typeof activeReleaseRecord>>["release"];

/** The engine a team member runs on in this release: the one the Play names when its agent allows it, else the agent's first. */
const engineFor = (release: Release, member: { agentId: string; engine: string }): string => {
  const allowed = release.agents?.[member.agentId]?.spec.engine.anyOf ?? [];
  return allowed.includes(member.engine) ? member.engine : (allowed[0] ?? member.engine);
};

/** Why this starter Play cannot be installed into a release, or nothing when it can. */
function blockedBy(entry: StarterPlay, release: Release): string | undefined {
  if (release.workflows?.[entry.playId]) return "a task with this id already exists in the release";
  for (const member of entry.play.spec.team) if (!release.agents?.[member.agentId]) return `the agent ${member.agentId} is not in the active release`;
  for (const task of entry.play.spec.plan.tasks) if (task.workflowId && !release.workflows?.[task.workflowId]) return `the task ${task.workflowId} is not in the active release`;
  return undefined;
}

export class StarterPlays {
  constructor(private readonly store: Store) {}

  status(organizationId: string): StarterPlayStatus {
    const entries = starterPlays();
    const release = activeReleaseRecord(this.store, organizationId)?.release;
    if (!release) return { total: entries.length, installed: 0, installable: 0, blocked: [] };
    const installed = entries.filter((entry) => release.plays?.[entry.playId]);
    const rest = entries.filter((entry) => !release.plays?.[entry.playId]);
    const blocked = rest.flatMap((entry) => { const reason = blockedBy(entry, release); return reason ? [{ playId: entry.playId, reason }] : []; });
    return { total: entries.length, installed: installed.length, installable: rest.length - blocked.length, blocked };
  }

  commands(): CommandHandlers {
    return handlersFor(["plays.addStarter"], {
      kind: "self",
      handle: ({ actor, workspaceId }) => {
        if (!workspaceId) throw new BrainDomainError("INVALID_ARGUMENT", "workspaceId required");
        requireWorkspaceRead(this.store, actor, workspaceId);
        this.install(actor);
        return { resourceId: workspaceId };
      },
    });
  }

  /** Adds every installable starter Play that is not yet in the active release. Idempotent: with nothing to add it changes nothing. */
  private install(actor: ActorContext): number {
    const active = activeReleaseRecord(this.store, actor.organizationId);
    if (!active) throw new BrainDomainError("DEPENDENCY_UNAVAILABLE", "no active config release");
    const missing = starterPlays().filter((entry) => !active.release.plays?.[entry.playId] && !blockedBy(entry, active.release));
    if (missing.length === 0) return 0;
    const sources = activeSourceDocuments(this.store, actor.organizationId);
    const taken = new Set(sources.map((doc) => doc.path));
    const added = missing.map((entry) => {
      const play = { ...entry.play, spec: { ...entry.play.spec, team: entry.play.spec.team.map((member) => ({ ...member, engine: engineFor(active.release, member) })) } };
      return { path: taken.has(entry.document.path) ? `config/plays/starter-${entry.playId}.yaml` : entry.document.path, text: `${JSON.stringify(play, null, 2)}\n` };
    });
    const documents = [...sources, ...added];
    const assets = releaseAssets(documents, activeReleaseAssets(this.store, actor.organizationId));
    const sourceRevision = `sha256:${createHash("sha256").update(JSON.stringify(documents)).digest("hex")}`;
    const { digest } = stageRelease(this.store, actor, documents, sourceRevision, assets.scripts, assets.instructions, assets.schemas);
    activateRelease(this.store, actor, digest, active.digest);
    return missing.length;
  }
}
