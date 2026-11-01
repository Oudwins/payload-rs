#!/usr/bin/env bash
# Runs upstream int suites through ./vitest.upstream.config.ts with the Rust query validation
# (`rs`) and with the upstream modules (`ts`, same config), writes vitest JSON reports to
# $OUT/<suite>-<impl>.json and compares per-test outcomes. Exits non-zero when a report is
# missing, a suite ran zero tests, or any test's outcome differs.
#
#   PAYLOAD_CORE_RUNTIME_ADDON=<query addon> test/__rs/core-query/run-upstream.sh access-control joins
set -u
source /tmp/penv.sh
cd "$(dirname "$0")/../../.."
export PAYLOAD_DATABASE=sqlite NODE_NO_WARNINGS=1 DISABLE_LOGGING=true NODE_OPTIONS="--no-deprecation --no-experimental-strip-types"
OUT=${OUT:-/tmp/rs-core-query-upstream}
DB=${DB:-/tmp/rs-core-query-upstream.db}
mkdir -p "$OUT"
status=0
for suite in "$@"; do
  for impl in ts rs; do
    rm -f "$DB" "$DB"-*
    report="$OUT/$suite-$impl.json"
    rm -f "$report"
    query=$([ "$impl" = ts ] && echo ts || echo rs)
    TZ=${TZ:-UTC} SQLITE_URL=file:$DB PAYLOAD_QUERY=$query \
      pnpm vitest run --config test/__rs/core-query/vitest.upstream.config.ts "test/$suite/int.spec.ts" \
      --reporter=json --outputFile="$report" > "$OUT/$suite-$impl.log" 2>&1
    summary=$(node -e 'const r=require(process.argv[1]);if(!r.numTotalTests)process.exit(3);console.log(`passed ${r.numPassedTests} failed ${r.numFailedTests} pending ${r.numPendingTests+r.numTodoTests} total ${r.numTotalTests}`)' "$report" 2>/dev/null) || { summary='no report or zero tests'; status=1; }
    echo "$suite $impl: $summary"
  done
  node test/__rs/core-validate/compare.mjs "$OUT/$suite-ts.json" "$OUT/$suite-rs.json" || status=1
done
rm -f "$DB" "$DB"-*
exit $status
