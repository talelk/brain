import { slugify } from "@brain/contracts/slug";

/** The project's name when it is not given: the last part of its address (`https://github.com/acme/shop.git` is `shop`). The Governor makes the same name. */
export const projectNameOf = (repo: string): string => slugify(repo.trim().replace(/[/?#]+$/u, "").replace(/\.git$/u, "").split(/[/:]/u).at(-1) ?? "") || "project";

/** True for an address on github.com, whose secret is the workspace's `github` one. */
export const onGithub = (repo: string): boolean => /^https:\/\/github\.com\//u.test(repo.trim());
