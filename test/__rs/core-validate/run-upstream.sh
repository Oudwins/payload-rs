#!/usr/bin/env bash
# Runs upstream int suites on SQLite with the TS engine (`ts`: PAYLOAD_ENGINE / PAYLOAD_CORE_ENGINE
# unset) and with `PAYLOAD_ENGINE=rs` (`rs`: Rust SQL engine, Rust field hooks and the Rust
# validators through payload's own `fields/validations.ts` dispatch, no module alias), per time
# zone, writing vitest JSON reports to $OUT/<suite>-<impl>-<tz>.json and comparing every test's
# outcome (rs against ts of the same time zone) with compare.mjs. Uses the harness config, so the
# shared generated test/databaseAdapter.js is not touched.
#
# Usage: PAYLOAD_ENGINE_ADDON=/tmp/x.node test/__rs/core-validate/run-upstream.sh validate fields auth
# IMPLS="rs" / TZS="UTC Europe/Lisbon" restrict the matrix (defaults: "ts rs", "UTC").
# Exits 1 when a comparison differs or a report is missing.
set -u
source /tmp/penv.sh
unset PAYLOAD_ENGINE PAYLOAD_CORE_ENGINE
export PAYLOAD_DATABASE=sqlite NODE_NO_WARNINGS=1 DISABLE_LOGGING=true
OUT=${OUT:-/tmp/rs-validate}
DB=${DB:-/tmp/rs-validate.db}
status=0
mkdir -p "$OUT"
for suite in "$@"; do
  for tz in ${TZS:-UTC}; do
    tztag=$(echo "$tz" | tr '/' '_')
    for impl in ${IMPLS:-ts rs}; do
      rm -f "$DB" "$DB"-*
      report="$OUT/$suite-$impl-$tztag.json"
      rm -f "$report"
      engine=$([ "$impl" = rs ] && echo rs || echo '')
      env ${engine:+PAYLOAD_ENGINE=$engine} TZ="$tz" SQLITE_URL="file:$DB" \
        pnpm test:int:sqlite --config test/__rs/harness/vitest.config.ts "test/$suite/int.spec.ts" \
        --reporter=json --outputFile="$report" > "$OUT/$suite-$impl-$tztag.log" 2>&1
      echo "$suite $impl $tz: $(node -e 'const r=require(process.argv[1]);console.log(`passed ${r.numPassedTests} failed ${r.numFailedTests} pending ${r.numPendingTests+r.numTodoTests} total ${r.numTotalTests}`)' "$report" 2>/dev/null || echo 'no report')"
      [ -f "$report" ] || status=1
    done
    if [ -f "$OUT/$suite-ts-$tztag.json" ] && [ -f "$OUT/$suite-rs-$tztag.json" ]; then
      node test/__rs/core-validate/compare.mjs "$OUT/$suite-ts-$tztag.json" "$OUT/$suite-rs-$tztag.json" || status=1
    fi
  done
done
rm -f "$DB" "$DB"-*
exit $status
