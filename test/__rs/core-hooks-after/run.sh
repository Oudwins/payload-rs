#!/usr/bin/env bash
# Runs the afterChange/beforeDuplicate differential suites one by one, each on its own SQLite file.
#
#   PAYLOAD_ENGINE_ADDON=/path/to/payload-node.node test/__rs/core-hooks-after/run.sh [hooks fields localization synthetic]
set -euo pipefail
cd "$(dirname "$0")/../../.."
suites=("${@:-hooks fields localization synthetic}")
for suite in ${suites[@]}; do
  db="${RS_CORE_HOOKS_AFTER_DB:-/tmp/rs-after-change.db}"
  rm -f "$db"
  SQLITE_URL="file:${db}" TZ="${TZ:-UTC}" pnpm test:int:sqlite "test/__rs/core-hooks-after/${suite}.int.spec.ts"
  rm -f "$db"
done
