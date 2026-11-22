#!/usr/bin/env bash
# Runs the beforeChange differential suites one by one, sequentially on /tmp/rs-before-change.db (parallel
# workers against one SQLITE_URL deadlock on the shared database).
#
#   PAYLOAD_CORE_RUNTIME_ADDON=/path/to/addon.node test/__rs/core-hooks-before-change/run.sh [hooks fields localization validate synthetic]
set -euo pipefail
cd "$(dirname "$0")/../../.."
# The TS reference must be upstream TS (the harness also fails if a reference run reaches Rust).
export PAYLOAD_ENGINE=ts # upstream TS (unset selects Rust)
unset PAYLOAD_CORE_ENGINE
# The glue's generated copies of upstream's beforeChange traversal must match upstream's sources.
node packages/engine-rs/scripts/generateBeforeChange.mjs --check
suites=("${@:-hooks fields localization validate synthetic elision elision-fields elision-localization}")
for suite in ${suites[@]}; do
  db="${RS_CORE_HOOKS_BC_DB:-/tmp/rs-before-change.db}"
  rm -f "$db"*
  SQLITE_URL="file:${db}" TZ="${TZ:-UTC}" pnpm test:int:sqlite "test/__rs/core-hooks-before-change/${suite}.int.spec.ts"
  rm -f "$db"*
done
