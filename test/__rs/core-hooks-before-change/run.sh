#!/usr/bin/env bash
# Runs the beforeChange differential suites one by one, sequentially on /tmp/rs-before-change.db (parallel
# workers against one SQLITE_URL deadlock on the shared database).
#
#   PAYLOAD_CORE_RUNTIME_ADDON=/path/to/addon.node test/__rs/core-hooks-before-change/run.sh [hooks fields localization validate synthetic]
set -euo pipefail
cd "$(dirname "$0")/../../.."
suites=("${@:-hooks fields localization validate synthetic}")
for suite in ${suites[@]}; do
  db="/tmp/rs-before-change.db"
  rm -f "$db"*
  SQLITE_URL="file:${db}" TZ="${TZ:-UTC}" pnpm test:int:sqlite "test/__rs/core-hooks-before-change/${suite}.int.spec.ts"
  rm -f "$db"*
done
