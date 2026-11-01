#!/usr/bin/env bash
# Runs upstream int suites through test/__rs/core-ops-write/vitest.config.ts in the given modes
# (PAYLOAD_OPS=ts|rs|shadow; default "ts rs shadow"), one suite at a time on a fresh SQLite file,
# then summarizes (summarize.mjs exits non-zero on any shadow diff, on a suite whose rs per-test
# outcomes differ from ts, on a missing report, when no case was compared, or when a Rust branch
# ran no Rust operation).
#
#   PAYLOAD_ENGINE_ADDON=/tmp/ops-write-addon/payload-engine.node \
#     test/__rs/core-ops-write/run.sh hooks versions
#
# OUT (default /tmp/rs-ops-write), DB (default /tmp/rs-ops-write.db), MODES, TZ (default UTC).
#
# Transaction-enabled runs (writes cannot be rolled back with a savepoint, so no shadow mode): the
# cross-process trace modes, compared by trace-compare.mjs (TS run, second TS run, Rust run):
#
#   PAYLOAD_RS_SQLITE_TRANSACTIONS=true [RS_OPS_WRITE_SINGLE_TX=true] \
#     MODES="trace-ts trace-ts2 trace-rs" test/__rs/core-ops-write/run.sh synthetic hooks
#
# MongoDB (real mongoose sessions on the replica set; RS_OPS_ORDERED_IO=true delivers database
# results in call order so concurrent per-document work interleaves deterministically, see
# shadow.ts `orderedIO`):
#
#   RS_CORE_DB=mongodb RS_OPS_ORDERED_IO=true [RS_OPS_WRITE_SINGLE_TX=true] \
#     MODES="trace-ts trace-ts2 trace-rs" test/__rs/core-ops-write/run.sh __rs/core-ops-write/synthetic
set -u
source /tmp/penv.sh
cd "$(dirname "$0")/../../.."
unset PAYLOAD_ENGINE PAYLOAD_CORE_ENGINE PAYLOAD_CORE_OPS_ENGINE
export PAYLOAD_DATABASE=sqlite NODE_NO_WARNINGS=1 DISABLE_LOGGING=true \
  NODE_OPTIONS="--no-deprecation --no-experimental-strip-types" TZ=${TZ:-UTC}
OUT=${OUT:-/tmp/rs-ops-write}
DB=${DB:-/tmp/rs-ops-write.db}
mkdir -p "$OUT"
# RS_CORE_DB=mongodb: the same runs on MongoDB (test/__rs/core-mongo), each mode on its own
# database (named after the run, dropped afterwards).
CONFIG=test/__rs/core-ops-write/vitest.config.ts
if [ "${RS_CORE_DB:-sqlite}" = mongodb ]; then
  export PAYLOAD_DATABASE=mongodb
  CONFIG=test/__rs/core-mongo/vitest.core-ops-write.config.ts
fi
for suite in "$@"; do
  spec="test/$suite/int.spec.ts"
  [ -f "$spec" ] || spec="$suite"
  tag=$(echo "$suite" | tr '/' '_')
  for mode in ${MODES:-ts rs shadow}; do
    rm -f "$DB" "$DB-shm" "$DB-wal" "$DB-journal"
    mkdir -p "$OUT/$mode"
    rm -rf "$OUT/$mode/ops-$tag"
    # trace-ts2: a second process running the TS reference (trace-compare.mjs)
    mongo_db="coremongo_opsw_${tag//[^a-zA-Z0-9]/_}_${mode}_$$"
    PAYLOAD_OPS=${mode%2} RS_OPS_OUT="$OUT/$mode/ops-$tag" SQLITE_URL="file:$DB" \
      MONGODB_URL="$(node test/__rs/core-mongo/db.mjs url "$mongo_db")" \
      pnpm vitest run --config "$CONFIG" --project int "$spec" \
      --reporter=json --outputFile="$OUT/$mode/$tag.json" > "$OUT/$mode/$tag.log" 2>&1
    [ "$PAYLOAD_DATABASE" = mongodb ] && node test/__rs/core-mongo/db.mjs drop "$mongo_db"
    echo "$suite $mode: $(node -e 'const r=require(process.argv[1]);console.log(`passed ${r.numPassedTests} failed ${r.numFailedTests} pending ${r.numPendingTests+r.numTodoTests}`)' "$OUT/$mode/$tag.json" 2>/dev/null || echo 'no report')"
  done
done
rm -f "$DB" "$DB-shm" "$DB-wal" "$DB-journal"
status=0
if [[ " ${MODES:-ts rs shadow} " =~ \ (ts|rs|shadow)\  ]]; then
  node test/__rs/core-ops-write/summarize.mjs "$OUT" "$@" || status=1
fi
if [[ " ${MODES:-} " == *" trace-"* ]]; then
  node test/__rs/core-ops-write/trace-compare.mjs "$OUT" "$@" || status=1
fi
exit $status
