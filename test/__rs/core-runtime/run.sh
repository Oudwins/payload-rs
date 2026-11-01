#!/usr/bin/env bash
# Runs the core runtime differential suites one by one, each on a fresh SQLite file (running the
# spec files in parallel workers against one SQLITE_URL deadlocks on the shared database).
#
#   PAYLOAD_CORE_RUNTIME_ADDON=/path/to/addon.node test/__rs/core-runtime/run.sh [hooks fields synthetic]
#
# RS_CORE_RUNTIME_DB overrides the database file (default /tmp/rs-core-runtime.db).
set -euo pipefail
cd "$(dirname "$0")/../../.."
# The TS reference must be upstream TS (the harness also fails if a reference run reaches Rust).
unset PAYLOAD_ENGINE PAYLOAD_CORE_ENGINE
suites=("${@:-hooks fields synthetic}")
db="${RS_CORE_RUNTIME_DB:-/tmp/rs-core-runtime.db}"
status=0
for suite in ${suites[@]}; do
  rm -f "$db" "$db-journal" "$db-wal" "$db-shm"
  SQLITE_URL="file:${db}" TZ="${TZ:-UTC}" pnpm test:int:sqlite "test/__rs/core-runtime/${suite}.int.spec.ts" || status=1
  rm -f "$db" "$db-journal" "$db-wal" "$db-shm"
done
exit $status
