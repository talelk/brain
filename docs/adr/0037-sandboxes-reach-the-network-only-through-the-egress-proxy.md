# 37. Sandboxes reach the network only through the egress proxy

Status: accepted, 2026-11-15. Spec #90, story 105.

Sandboxes run on `--network none`. A tool that must reach a host needs a network, and a network that is not the proxy's would reach everything. The runner's fetch broker (`web.fetch`, per-tool `allowedHosts`) is a different thing: it fetches on the runner's behalf and is not changed.

## Decision
1. **One proxy, per-workspace separation by grant.** `apps/launcher/src/egress-proxy.ts` is one process every workspace's sandbox shares. A sandbox's whole network is the `internal` Docker network `brain-internal` plus the proxy's name on it; the proxy is the only member with an uplink. What a request may reach is the grant its own credentials name, never anything the request says.
2. **Grants.** The launcher writes `<id>.json` (`{token, hosts}`) into `BRAIN_LAUNCHER_EGRESS_GRANTS_DIR` when it creates a sandbox, sets the sandbox's `http(s)_proxy` to `http://<id>:<token>@brain-egress-proxy:18080`, and deletes the file when the sandbox stops. A launcher restart prunes grants whose sandbox no longer exists (label `brain.egress-grant`). The proxy reads the directory read-only on each request, so a revoked grant stops at once. No credentials or a wrong token is 407; a host outside the grant is 403, for plain HTTP and CONNECT alike.
3. **Matching is exact.** An entry is a lower-case DNS name or IPv4 address, with an optional port. `host` allows ports 80 and 443; `host:port` allows that port only. No wildcards, subdomains, schemes or paths. There is no private-address block: the model host is private and meant to be listed.
4. **Fail closed.** The launcher gives a sandbox a network only when the request names `egressHosts`, the profile is not `privileged-tool`, and a grants directory is configured (else 409). No hosts means `--network none`.
5. **The list is the workspace's.** An administrator sets `egressHosts` with `workspace.effects.set` (`config:activate`, whole-list replace; omitted means unchanged) and reads it with `effects.get`; it is a column of `workspace_effect_policy`. Every job offer carries its own workspace's list; the runner gives a read-class tool's sandbox `network: internal` with those hosts, or `none` when the list is empty. Self-tests and held-effect runs stay `none`.
6. **Shipped.** The proxy image is `deploy/egress-proxy.Dockerfile`; `deploy/reference/compose.runner.yaml` runs it on `brain-internal` (named, `internal: true`) and an uplink network, with the grants directory mounted read-only.

## Limits (be honest)
- Matching is on the name the client sends. An allowed name that resolves to an internal address is reachable, and DNS answers are the proxy host's; the administrator who lists a name vouches for it.
- The proxy does not inspect TLS or bodies: what an allowed host is sent is the tool's own business.
- The launcher trusts the runner's `egressHosts` the way it trusts its other fields (it validates the shape, not the policy); the Governor's list is authority only as far as the runner is honest.
- Proven against local fake upstreams. A live Docker proof (`tests/probes/sandbox/egress.test.ts`) was updated but not run.
