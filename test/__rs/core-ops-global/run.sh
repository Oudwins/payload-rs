#!/usr/bin/env bash
# Differential run of the global and auth operations: each upstream int suite (or spec path) runs
# three times through test/__rs/core-ops-global/vitest.config.ts, one at a time, each on a fresh
# SQLite file, with RS_OPS_GLOBAL_TRACE recording every global / auth operation case (trace.ts):
#
#   ts   reference: PAYLOAD_ENGINE / PAYLOAD_CORE_ENGINE / PAYLOAD_OPS_GLOBAL_ENGINE unset (all TS)
#   ts2  the reference again (a candidate case that differs from ts is accepted only when it equals
#        another reference run, see compare.mjs)
#   rs   PAYLOAD_OPS_GLOBAL_ENGINE=rs: the Rust global / auth operations, everything else TS
#
# then compare.mjs (exits non-zero on any diff, on a changed test outcome, on a missing report,
# when nothing was compared, or when a run used the wrong implementation).
#
#   PAYLOAD_ENGINE_ADDON=/tmp/ops-global-auth-addon/payload-engine.node \
#     test/__rs/core-ops-global/run.sh globals versions auth
#
# OUT (default /tmp/rs-ops-global), DB (default /tmp/rs-ops-global-auth.db), MODES (default
# "ts ts2 rs"), RS_OPS_GLOBAL_MUTANT (rs runs only), TZ (default UTC). The whole Rust engine
# (PAYLOAD_ENGINE=rs) is checked by the upstream suites (test/__rs/adapter/runSuites.mjs), not
# here: its SQL adapter settles after a different number of microtasks, which these traces record.
set -u
source /tmp/penv.sh
cd "$(dirname "$0")/../../.."
export PAYLOAD_DATABASE=sqlite NODE_NO_WARNINGS=1 DISABLE_LOGGING=true TZ=${TZ:-UTC}
OUT=${OUT:-/tmp/rs-ops-global}
DB=${DB:-/tmp/rs-ops-global-auth.db}
MUTANT=${RS_OPS_GLOBAL_MUTANT:-}
unset RS_OPS_GLOBAL_MUTANT
mkdir -p "$OUT"
# RS_CORE_DB=mongodb: the same runs on MongoDB (test/__rs/core-mongo), each mode on its own
# database (named after the run, dropped afterwards).
CONFIG=test/__rs/core-ops-global/vitest.config.ts
SCRIPT=test:int:sqlite
if [ "${RS_CORE_DB:-sqlite}" = mongodb ]; then
  export PAYLOAD_DATABASE=mongodb
  CONFIG=test/__rs/core-mongo/vitest.core-ops-global.config.ts
  SCRIPT=test:int
fi
for suite in "$@"; do
  spec="test/$suite/int.spec.ts"
  [ -f "$spec" ] || spec="$suite"
  tag=$(echo "$suite" | tr '/.' '__')
  for mode in ${MODES:-ts ts2 rs}; do
    rm -f "$DB" "$DB-shm" "$DB-wal" "$DB-journal"
    rm -rf "$OUT/$mode/$tag"
    mkdir -p "$OUT/$mode/$tag"
    (
      export PAYLOAD_ENGINE=ts # upstream TS (unset selects Rust)
      unset PAYLOAD_CORE_ENGINE PAYLOAD_OPS_GLOBAL_ENGINE
      case "$mode" in
        rs) export PAYLOAD_OPS_GLOBAL_ENGINE=rs ;;
      esac
      if [ -n "$MUTANT" ] && [ "$mode" != ts ] && [ "$mode" != ts2 ]; then
        export RS_OPS_GLOBAL_MUTANT=$MUTANT
      fi
      mongo_db="coremongo_opsg_${tag//[^a-zA-Z0-9]/_}_${mode}_$$"
      RS_OPS_GLOBAL_TRACE="$OUT/$mode/$tag" SQLITE_URL="file:$DB" \
        MONGODB_URL="$(node test/__rs/core-mongo/db.mjs url "$mongo_db")" \
        pnpm "$SCRIPT" --config "$CONFIG" "$spec" \
        --reporter=json --outputFile="$OUT/$mode/$tag/report.json" > "$OUT/$mode/$tag/vitest.log" 2>&1
      [ "$PAYLOAD_DATABASE" = mongodb ] && node test/__rs/core-mongo/db.mjs drop "$mongo_db"
    )
    echo "$suite $mode: $(node -e 'const r=require(process.argv[1]);console.log(`passed ${r.numPassedTests} failed ${r.numFailedTests} pending ${r.numPendingTests+r.numTodoTests}`)' "$OUT/$mode/$tag/report.json" 2>/dev/null || echo 'no report')"
  done
done
rm -f "$DB" "$DB-shm" "$DB-wal" "$DB-journal"
node test/__rs/core-ops-global/compare.mjs "$OUT" "$@"
