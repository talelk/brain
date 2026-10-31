# Brain guides

## Using Brain

- [Run your first task](use-brain.md): sign in, choose a starter task and read the result.
- [Runs and approvals](operate-runs-and-approvals.md): follow work and review proposed actions.

## Administering Brain

Start an installed source checkout with `rtk pnpm brain start`. Fresh initialization
creates the administrator and a populated workspace. See the [README](../../README.md)
for generated credentials, persistent state and current setup limits.

- [Advanced configuration](configuration-reference.md): full environment and authoring reference.
- [Run the local stack](run-local-stack.md): advanced model/runner configuration and troubleshooting.
- [Backup and restore](backup-restore.md): verified host maintenance and recovery.
- [Deploy the reference topology](deploy-compose.md): Governor, runner and launcher boundaries.
- [Run the operational proof](verify-operational.md): reproduce live execution evidence.

## Authoring capabilities

- [Compile and activate a release](compile-activate-release.md): prepare, inspect and activate custom configuration.
- [Add a governed tool](add-governed-tool.md): declare and pin tools through the broker.

## Reference

- [Functional specification](../functional-spec.md): user and admin workflows as
  functional specs with technical notes.
- [Screen descriptions](../screen-descriptions.md): every screen, its queries,
  actions and audience.

Architecture and implementation contracts live in `docs/implementation/`.
