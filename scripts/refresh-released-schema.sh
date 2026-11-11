#!/usr/bin/env bash
# Records the schema files of the build that was just deployed as the "previously released" fixture.
# tests/contracts/live-schema-upgrade.test.ts proves scripts/repair-live-schema.ts can upgrade this fixture
# to the schema of the working tree, so the next deploy cannot strand the live Governor.
# Run (and commit the result) after every successful deploy; scripts/deploy-demo.sh does the copy for you.
set -euo pipefail
cd "$(dirname "$0")/.."
dest=tests/fixtures/released-schema
mkdir -p "$dest"
cp apps/governor/schema/*.sql "$dest/"
git rev-parse HEAD > "$dest/RELEASED_AT"
echo "released-schema fixture refreshed from $(cat "$dest/RELEASED_AT" | cut -c1-9); commit $dest"
