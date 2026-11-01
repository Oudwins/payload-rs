#!/usr/bin/env bash
# Runs upstream int suites through test/__rs/core-ops/vitest.config.ts in the given modes
# (PAYLOAD_OPS=ts|rs|shadow; default "ts rs shadow"), one suite at a time on a fresh SQLite file,
# then summarizes (summarize.mjs exits non-zero on any shadow diff, on a suite whose rs per-test
# outcomes differ from ts, or when no case was compared).
#
#   PAYLOAD_ENGINE_ADDON=/tmp/operations-addon/payload-engine.node \
#     test/__rs/core-ops/run.sh sort fields relationships
#
# OUT (default /tmp/rs-ops), DB (default /tmp/rs-operations.db), MODES, TZ (default UTC).
# The reference never runs the Rust engine: PAYLOAD_ENGINE / PAYLOAD_CORE_ENGINE are unset (the
# Rust operations come only from the harness' `rs` side). RS_OPS_SQL_ENGINE=rs runs every mode on
# the Rust SQL adapter with TS field hooks (PAYLOAD_ENGINE=rs PAYLOAD_CORE_ENGINE=ts).
set -u
source /tmp/penv.sh
cd "$(dirname "$0")/../../.."
unset PAYLOAD_ENGINE PAYLOAD_CORE_ENGINE
if [ "${RS_OPS_SQL_ENGINE:-}" = rs ]; then
  export PAYLOAD_ENGINE=rs PAYLOAD_CORE_ENGINE=ts
fi
export PAYLOAD_DATABASE=sqlite NODE_NO_WARNINGS=1 DISABLE_LOGGING=true \
  NODE_OPTIONS="--no-deprecation --no-experimental-strip-types" TZ=${TZ:-UTC}
OUT=${OUT:-/tmp/rs-ops}
DB=${DB:-/tmp/rs-operations.db}
mkdir -p "$OUT"
# RS_CORE_DB=mongodb: the same runs on MongoDB (test/__rs/core-mongo), each mode on its own
# database (named after the run, dropped afterwards).
CONFIG=test/__rs/core-ops/vitest.config.ts
if [ "${RS_CORE_DB:-sqlite}" = mongodb ]; then
  export PAYLOAD_DATABASE=mongodb
  CONFIG=test/__rs/core-mongo/vitest.core-ops.config.ts
fi
for suite in "$@"; do
  spec="test/$suite/int.spec.ts"
  [ -f "$spec" ] || spec="$suite"
  tag=$(echo "$suite" | tr '/' '_')
  for mode in ${MODES:-ts rs shadow}; do
    rm -f "$DB" "$DB-shm" "$DB-wal" "$DB-journal"
    mkdir -p "$OUT/$mode"
    rm -rf "$OUT/$mode/ops-$tag"
    mongo_db="coremongo_ops_${tag//[^a-zA-Z0-9]/_}_${mode}_$$"
    PAYLOAD_OPS=$mode RS_OPS_OUT="$OUT/$mode/ops-$tag" SQLITE_URL="file:$DB" \
      MONGODB_URL="$(node test/__rs/core-mongo/db.mjs url "$mongo_db")" \
      pnpm vitest run --config "$CONFIG" --project int "$spec" \
      --reporter=json --outputFile="$OUT/$mode/$tag.json" > "$OUT/$mode/$tag.log" 2>&1
    [ "$PAYLOAD_DATABASE" = mongodb ] && node test/__rs/core-mongo/db.mjs drop "$mongo_db"
    echo "$suite $mode: $(node -e 'const r=require(process.argv[1]);console.log(`passed ${r.numPassedTests} failed ${r.numFailedTests} pending ${r.numPendingTests+r.numTodoTests}`)' "$OUT/$mode/$tag.json" 2>/dev/null || echo 'no report')"
  done
done
rm -f "$DB" "$DB-shm" "$DB-wal" "$DB-journal"
MODES="${MODES:-ts rs shadow}" node test/__rs/core-ops/summarize.mjs "$OUT" "$@"
