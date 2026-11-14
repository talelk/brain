import type { GitProvider } from "@brain/contracts";
import { BrainDomainError } from "../../domain/errors";

/**
 * The Git provider is the owner's choice when a connection is set up (GLOSSARY: Git provider). It decides which hosting API opens a pull
 * request; it is never read from the remote's address, so a self-hosted host needs no special name and an unknown one is refused.
 */
const LABELS: Readonly<Record<GitProvider, string>> = { github: "GitHub", "github-enterprise": "GitHub Enterprise", gitlab: "GitLab", gitea: "Gitea" };

export function gitProviderLabel(provider: GitProvider): string {
  return LABELS[provider];
}

/** The provider the owner named, or a plain refusal that lists the supported ones. */
export function parseGitProvider(value: unknown): GitProvider {
  if (typeof value === "string" && Object.hasOwn(LABELS, value)) return value as GitProvider;
  const shown = typeof value === "string" && value ? `"${value.slice(0, 40)}"` : "none";
  throw new BrainDomainError("INVALID_ARGUMENT", `Git provider ${shown} is not supported; choose one of ${Object.values(LABELS).join(", ")}`);
}

/** GitHub is the github.com service and GitHub Enterprise is a server of your own: the choice and the address must say the same thing. */
export function checkProviderFitsHost(provider: GitProvider, remote: URL): void {
  const onGitHub = remote.hostname === "github.com";
  if (provider === "github" && !onGitHub) throw new BrainDomainError("INVALID_ARGUMENT", "GitHub is github.com; for a GitHub server of your own choose GitHub Enterprise");
  if (provider === "github-enterprise" && onGitHub) throw new BrainDomainError("INVALID_ARGUMENT", "github.com is GitHub; choose GitHub, not GitHub Enterprise");
}
