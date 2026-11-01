#!/usr/bin/env bash
# Runs the live query differential specs one by one, each on a fresh SQLite file.
#
#   PAYLOAD_CORE_RUNTIME_ADDON=/path/to/query-addon.node test/__rs/core-query/live/run.sh [synthetic access-control ...]
#
# The addon must export coreRuntimeBinding and coreQueryBinding (payload-node, or the
# `query_addon` example of crates/payload-core-query). RS_CORE_QUERY_DB overrides the database
# file (default /tmp/rs-core-query-live.db). Exits non-zero if any spec failed.
set -uo pipefail
cd "$(dirname "$0")/../../../.."
if [ -z "${PAYLOAD_CORE_RUNTIME_ADDON:-}${PAYLOAD_ENGINE_ADDON:-}" ]; then
  echo "set PAYLOAD_CORE_RUNTIME_ADDON (or PAYLOAD_ENGINE_ADDON) to an addon exporting coreQueryBinding" >&2
  exit 2
fi
specs=("$@")
[ ${#specs[@]} -eq 0 ] && specs=(synthetic access-control joins versions localization relationships)
db="${RS_CORE_QUERY_DB:-/tmp/rs-core-query-live.db}"
status=0
for spec in "${specs[@]}"; do
  rm -f "$db" "$db-journal" "$db-wal" "$db-shm"
  echo "== core-query live: $spec"
  SQLITE_URL="file:${db}" TZ="${TZ:-UTC}" pnpm test:int:sqlite "test/__rs/core-query/live/${spec}.int.spec.ts" || status=1
  rm -f "$db" "$db-journal" "$db-wal" "$db-shm"
done
exit $status
