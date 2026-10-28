# Example status

All domains, identities, credentials, source revisions and repeated `aaaa…` digests are synthetic. The fixtures demonstrate wire/config shape and pack consistency. They are not signed releases, real permits or an executable production configuration. Registry resolution and vendor integration remain implementation gates.

`config/brainconfig.yaml` now explicitly selects NewUI through its required `spec.ui` block. Its foundation digest is a real byte hash of the reviewed `contracts/v1/ui-foundation.json`; it is a consistency binding, not a production release certificate. `config/web-build.json` separates image-build package selection and asset layout from runtime presentation defaults. Vite/CSS references are in `web/`. The pack rejects unsupported foundations, runtime package downloads, palette overrides, missing UI configuration and browser runner proxies, and checks manifest/locale consistency separately from wire shape.

`support-investigate.yaml` is the main five-step example. `all-primitives-fixture.yaml` covers all six job kinds and is a compiler/conformance fixture, not an operational support policy. Example schemas are deliberately small fixtures; a real pack must bind precise per-operation output schemas and a complete reviewed release manifest.

The echo tool below has no external effects. Its Python dependency is declared; it demonstrates strict JSON stdin/output and failure behavior without cloud credentials. The pack checker executes it, validates output and exercises an invalid input. Tool publication additionally requires ShellCheck/shfmt/behavior tests on the pinned runner image.
