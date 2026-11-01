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
set -u
source /tmp/penv.sh
cd "$(dirname "$0")/../../.."
unset PAYLOAD_ENGINE PAYLOAD_CORE_ENGINE PAYLOAD_CORE_OPS_ENGINE
export PAYLOAD_DATABASE=sqlite NODE_NO_WARNINGS=1 DISABLE_LOGGING=true \
  NODE_OPTIONS="--no-deprecation --no-experimental-strip-types" TZ=${TZ:-UTC}
OUT=${OUT:-/tmp/rs-ops-write}
DB=${DB:-/tmp/rs-ops-write.db}
mkdir -p "$OUT"
for suite in "$@"; do
  spec="test/$suite/int.spec.ts"
  [ -f "$spec" ] || spec="$suite"
  tag=$(echo "$suite" | tr '/' '_')
  for mode in ${MODES:-ts rs shadow}; do
    rm -f "$DB" "$DB-shm" "$DB-wal" "$DB-journal"
    mkdir -p "$OUT/$mode"
    rm -rf "$OUT/$mode/ops-$tag"
    PAYLOAD_OPS=$mode RS_OPS_OUT="$OUT/$mode/ops-$tag" SQLITE_URL="file:$DB" \
      pnpm vitest run --config test/__rs/core-ops-write/vitest.config.ts --project int "$spec" \
      --reporter=json --outputFile="$OUT/$mode/$tag.json" > "$OUT/$mode/$tag.log" 2>&1
    echo "$suite $mode: $(node -e 'const r=require(process.argv[1]);console.log(`passed ${r.numPassedTests} failed ${r.numFailedTests} pending ${r.numPendingTests+r.numTodoTests}`)' "$OUT/$mode/$tag.json" 2>/dev/null || echo 'no report')"
  done
done
rm -f "$DB" "$DB-shm" "$DB-wal" "$DB-journal"
node test/__rs/core-ops-write/summarize.mjs "$OUT" "$@"
